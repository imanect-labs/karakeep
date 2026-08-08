/**
 * Float32 の埋め込みベクトルを SQLite の BLOB として持ち回すための層。
 *
 * 設計判断（docs/briefing/requirements.md §5）:
 * Meilisearch のベクトルインデックスは `BookmarkVectorDocument` に強く型付け
 * されており、候補記事を載せるとプラグイン境界を壊す。候補プールは 3,000〜
 * 5,000 件・768 次元なので、BLOB に持って TypeScript で総当たりするほうが
 * upstream 追従コストが安い。
 *
 * 保存するベクトルは**必ず L2 正規化済み**とする。そうするとランキング時の
 * コサイン類似度が単なる内積になり、総当たりのループから割り算が消える。
 */

/**
 * ほぼすべての実行環境（x86_64 / arm64）はリトルエンディアンで、そこでは
 * Float32Array のメモリ表現をそのまま BLOB にできる。ビッグエンディアン機で
 * 書いた BLOB をリトルエンディアン機で読むと壊れるので、フォーマットは
 * 「常にリトルエンディアン」と決め、BE 機では DataView 経由の遅い経路を通す。
 */
const IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;

export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/** Float32Array を BLOB 用の Buffer に変換する（リトルエンディアン固定）。 */
export function serializeVector(vector: Float32Array | number[]): Buffer {
  const f32 =
    vector instanceof Float32Array ? vector : Float32Array.from(vector);

  if (IS_LITTLE_ENDIAN) {
    // コピーしてから返す。呼び出し元が保持している Float32Array を後から書き
    // 換えても BLOB が変わらないようにするため。
    return Buffer.from(
      f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength),
    );
  }

  const buf = Buffer.allocUnsafe(f32.length * 4);
  for (let i = 0; i < f32.length; i++) {
    buf.writeFloatLE(f32[i], i * 4);
  }
  return buf;
}

/** BLOB を Float32Array に戻す。 */
export function deserializeVector(blob: Buffer | Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(
      `Embedding blob length ${blob.byteLength} is not a multiple of 4`,
    );
  }
  const length = blob.byteLength / 4;

  if (IS_LITTLE_ENDIAN) {
    // Float32Array は 4 バイト境界を要求する。Buffer は共有プールから切り出さ
    // れることがあり byteOffset が揃っている保証がないので、揃っていなければ
    // コピーする。
    if (blob.byteOffset % 4 === 0) {
      return new Float32Array(
        blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
      );
    }
    const copy = Uint8Array.prototype.slice.call(blob);
    return new Float32Array(copy.buffer);
  }

  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/**
 * L2 正規化した新しいベクトルを返す。ゼロベクトルはゼロのまま返す
 * （NaN を候補プールに撒かないため）。
 */
export function l2Normalize(vector: Float32Array | number[]): Float32Array {
  const out =
    vector instanceof Float32Array
      ? new Float32Array(vector)
      : Float32Array.from(vector);
  let sumSq = 0;
  for (let i = 0; i < out.length; i++) {
    sumSq += out[i] * out[i];
  }
  if (sumSq === 0) {
    return out;
  }
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < out.length; i++) {
    out[i] = out[i] * inv;
  }
  return out;
}

/** 正規化済みベクトル同士の内積。これがそのままコサイン類似度になる。 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** 正規化されているか分からないベクトル同士のコサイン類似度。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dotSum = 0;
  let aSq = 0;
  let bSq = 0;
  for (let i = 0; i < a.length; i++) {
    dotSum += a[i] * b[i];
    aSq += a[i] * a[i];
    bSq += b[i] * b[i];
  }
  if (aSq === 0 || bSq === 0) {
    return 0;
  }
  return dotSum / Math.sqrt(aSq * bSq);
}

/**
 * Matryoshka Representation Learning による次元の切り詰め。
 * **切ったあとに必ず再正規化する**（切ると L2 ノルムが 1 でなくなるため、
 * これを忘れると内積がコサインでなくなる）。
 */
export function truncateMRL(
  vector: Float32Array,
  dimensions: number,
): Float32Array {
  if (dimensions > vector.length) {
    throw new Error(
      `Cannot truncate a ${vector.length}-dim vector to ${dimensions} dims`,
    );
  }
  if (dimensions === vector.length) {
    return l2Normalize(vector);
  }
  return l2Normalize(vector.subarray(0, dimensions));
}

/** 複数ベクトルの重心。空配列ならゼロ次元ではなく null を返す。 */
export function centroid(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) {
    return null;
  }
  const dims = vectors[0].length;
  const acc = new Float64Array(dims);
  for (const v of vectors) {
    if (v.length !== dims) {
      throw new Error(`Dimension mismatch: ${v.length} vs ${dims}`);
    }
    for (let i = 0; i < dims; i++) {
      acc[i] += v[i];
    }
  }
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    out[i] = acc[i] / vectors.length;
  }
  return out;
}

/**
 * 重み付き重心。直近プロフィール（半減期 7 日の指数減衰）で使う。
 * 重みの合計が 0 なら null。
 */
export function weightedCentroid(
  entries: { vector: Float32Array; weight: number }[],
): Float32Array | null {
  if (entries.length === 0) {
    return null;
  }
  const dims = entries[0].vector.length;
  const acc = new Float64Array(dims);
  let totalWeight = 0;
  for (const { vector, weight } of entries) {
    if (vector.length !== dims) {
      throw new Error(`Dimension mismatch: ${vector.length} vs ${dims}`);
    }
    if (weight === 0) {
      continue;
    }
    totalWeight += weight;
    for (let i = 0; i < dims; i++) {
      acc[i] += vector[i] * weight;
    }
  }
  if (totalWeight === 0) {
    return null;
  }
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    out[i] = acc[i] / totalWeight;
  }
  return out;
}

export interface ScoredIndex {
  index: number;
  score: number;
}

/**
 * 総当たりで上位 k 件を返す。候補 5,000 件 × 768 次元で 50 ms 以内に収まる
 * ことを NFR-01 の前提にしている（vector.bench.test.ts で確認する）。
 *
 * ソートせず、k 件の最小値を持つだけの線形走査にしている。候補数 n に対して
 * k は 20〜100 程度なので、全件ソート O(n log n) より素直に速い。
 */
export function topK(
  query: Float32Array,
  vectors: Float32Array[],
  k: number,
): ScoredIndex[] {
  if (k <= 0) {
    return [];
  }
  const kept: ScoredIndex[] = [];
  // kept が満杯のときの最小スコアと、その位置。満杯になるまでは -Infinity に
  // しておき、全件を無条件に受け入れる。
  let minScore = -Infinity;
  let minIdx = 0;

  for (let i = 0; i < vectors.length; i++) {
    const score = dot(query, vectors[i]);
    if (kept.length < k) {
      kept.push({ index: i, score });
      if (kept.length < k) {
        continue;
      }
    } else if (score > minScore) {
      kept[minIdx] = { index: i, score };
    } else {
      continue;
    }
    // 満杯になった直後、または入れ替えた直後だけ最小値を取り直す。
    minScore = Infinity;
    for (let j = 0; j < kept.length; j++) {
      if (kept[j].score < minScore) {
        minScore = kept[j].score;
        minIdx = j;
      }
    }
  }
  return kept.sort((a, b) => b.score - a.score);
}

/** 候補集合に対する最大コサイン。特徴量 4・11 で使う。 */
export function maxSimilarity(
  query: Float32Array,
  vectors: Float32Array[],
): number {
  let max = -Infinity;
  for (const v of vectors) {
    const score = dot(query, v);
    if (score > max) {
      max = score;
    }
  }
  return max === -Infinity ? 0 : max;
}

/** 上位 n 件の平均コサイン。特徴量 5 で使う。 */
export function meanTopSimilarity(
  query: Float32Array,
  vectors: Float32Array[],
  n: number,
): number {
  const top = topK(query, vectors, n);
  if (top.length === 0) {
    return 0;
  }
  return top.reduce((sum, t) => sum + t.score, 0) / top.length;
}
