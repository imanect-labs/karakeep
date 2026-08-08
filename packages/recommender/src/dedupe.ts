import { dot } from "./vector";

/**
 * 同一記事の検出（FR-C-05）。
 *
 * 同じ記事が RSS・Hacker News・アグリゲータから別々に流れてくる。手がかりを
 * 3 段構えにする。
 *
 * 1. 正規化 URL — いちばん確実。DB の一意制約でほぼ弾ける
 * 2. 正規化タイトル — 転載・ミラーで URL が変わっても効く
 * 3. 埋め込み近傍 — 見出しを書き換えた転載に効く
 *
 * 3 だけに頼らないのが要点。コサイン 0.93 は「同じ話題の別記事」も拾って
 * しまう閾値で、それを重複として潰すと候補プールの多様性が落ちる。
 * 1 と 2 で取れるものは 1 と 2 で取る。
 */

export const DEFAULT_DUPLICATE_THRESHOLD = 0.93;

export interface DedupeItem {
  id: string;
  urlHash: string;
  titleHash?: string | null;
  /** L2 正規化済みであること。null なら埋め込み近傍の判定から外れる。 */
  embedding?: Float32Array | null;
  /** 代表を選ぶときの基準。古いほうを残す（オリジナルである可能性が高い）。 */
  publishedAt?: Date | null;
}

export interface DedupeOptions {
  threshold?: number;
}

/**
 * 新しく取り込んだ候補が、既存の候補または他の新規候補の重複かどうかを判定
 * する。返すのは `重複した候補の id → 代表の id` の写像。写像に載らなかった
 * 候補は代表そのもの。
 *
 * 計算量は `incoming × (incoming + existing)`。1 日 400 件 × プール 5,000 件で
 * 約 200 万回の内積になる。夜間バッチなので許容し、プール全体の総当たり
 * （5,000 × 5,000）はやらない。
 */
export function findDuplicates(
  incoming: DedupeItem[],
  existing: DedupeItem[] = [],
  opts: DedupeOptions = {},
): Map<string, string> {
  const threshold = opts.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  const result = new Map<string, string>();

  // 既存側は代表候補として引けるように索引を張る。
  const byUrlHash = new Map<string, DedupeItem>();
  const byTitleHash = new Map<string, DedupeItem>();
  const withEmbedding: DedupeItem[] = [];

  const register = (item: DedupeItem) => {
    if (!byUrlHash.has(item.urlHash)) {
      byUrlHash.set(item.urlHash, item);
    }
    if (item.titleHash && !byTitleHash.has(item.titleHash)) {
      byTitleHash.set(item.titleHash, item);
    }
    if (item.embedding) {
      withEmbedding.push(item);
    }
  };

  for (const item of existing) {
    register(item);
  }

  // 新規どうしの重複も見る必要があるので、順に処理しながら索引へ足していく。
  // 同じ日に 3 つのソースから同じ記事が来たときに 3 件とも残さないため。
  for (const item of incoming) {
    const representative = findRepresentative(
      item,
      byUrlHash,
      byTitleHash,
      withEmbedding,
      threshold,
    );
    if (representative) {
      // 代表がさらに他の代表を指しているときは終端まで辿る。連鎖して
      // 「重複の重複」になると、後段で candidate が引けなくなる。
      result.set(item.id, resolveChain(representative.id, result));
      continue;
    }
    register(item);
  }

  return result;
}

function findRepresentative(
  item: DedupeItem,
  byUrlHash: Map<string, DedupeItem>,
  byTitleHash: Map<string, DedupeItem>,
  withEmbedding: DedupeItem[],
  threshold: number,
): DedupeItem | null {
  const byUrl = byUrlHash.get(item.urlHash);
  if (byUrl && byUrl.id !== item.id) {
    return byUrl;
  }

  if (item.titleHash) {
    const byTitle = byTitleHash.get(item.titleHash);
    if (byTitle && byTitle.id !== item.id) {
      return byTitle;
    }
  }

  if (!item.embedding) {
    return null;
  }
  let best: DedupeItem | null = null;
  let bestScore = threshold;
  for (const other of withEmbedding) {
    if (other.id === item.id || !other.embedding) {
      continue;
    }
    if (other.embedding.length !== item.embedding.length) {
      // 埋め込みモデルが混在している。比較してはいけない。
      continue;
    }
    const score = dot(item.embedding, other.embedding);
    if (score >= bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function resolveChain(id: string, result: Map<string, string>): string {
  const seen = new Set<string>();
  let current = id;
  while (result.has(current) && !seen.has(current)) {
    seen.add(current);
    current = result.get(current)!;
  }
  return current;
}

/**
 * 同一グループの中から残す 1 件を選ぶ。公開が古いほうを残す — 転載より
 * オリジナルが先に出ている可能性が高いため。公開日時が無いものは後回し。
 */
export function pickRepresentative(group: DedupeItem[]): DedupeItem {
  return [...group].sort((a, b) => {
    const at = a.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bt = b.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (at !== bt) {
      return at - bt;
    }
    return a.id < b.id ? -1 : 1;
  })[0];
}
