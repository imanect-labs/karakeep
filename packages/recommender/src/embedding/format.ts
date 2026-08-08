/**
 * 候補記事を埋め込みモデルへ渡す文字列に整形する（FR-S-01 / FR-S-01b）。
 *
 * EmbeddingGemma は文書側の入力書式を `title: {title | "none"} | text: {…}`
 * と規定している。この書式を外すと学習時の分布からずれるので、候補も既存
 * ブックマークも、プロフィール重心に混ざるものはすべて同じ書式で通す。
 *
 * 入れるのはタイトル・要約・本文冒頭までとする。レコメンドに必要なのは
 * 「何の話か」であって精読ではないので、全文を混ぜるとむしろ話題が薄まる。
 */

/** EmbeddingGemma の入力上限。これを超えるとモデル側で黙って切られる。 */
export const MAX_EMBEDDING_TOKENS = 2048;

/**
 * 本文冒頭の文字数上限。トークン上限とは別に置いている。英語は 1 トークン
 * あたりの文字数が多いのでトークン上限だけだと本文がいくらでも伸び、話題より
 * 細部が効いてしまう。
 */
const MAX_BODY_CHARS_CJK = 1200;
const MAX_BODY_CHARS_LATIN = 1500;

/** 要約に割り当てる上限。要約は本文より情報密度が高いので短くてよい。 */
const MAX_SUMMARY_CHARS = 600;

/** タイトルの上限。ここを削ることはまずないが、暴走した <title> の保険。 */
const MAX_TITLE_CHARS = 300;

/**
 * トークン数の見積り係数。正確な Gemma トークナイザは持ち込まない
 * （モデルごとに変わるうえ、ここでの用途は「上限を割らない」ことだけ）。
 * 実測より多めに見積もる向きに倒してあり、切り詰めすぎることはあっても
 * モデル側で黙って切られることはない。
 */
const TOKENS_PER_CJK_CHAR = 1.5;
const TOKENS_PER_OTHER_CHAR = 0.35;

// ひらがな・カタカナ・CJK 統合漢字（拡張 A 含む）・互換漢字・半角カナ。
const CJK_PATTERN =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

export interface DocumentForEmbedding {
  title?: string | null;
  summary?: string | null;
  body?: string | null;
}

function normalize(text: string | null | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}

function countCjk(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) {
      count++;
    }
  }
  return count;
}

/** 文字種で重みを変えたトークン数の見積り。 */
export function estimateTokens(text: string): number {
  const cjk = countCjk(text);
  const other = [...text].length - cjk;
  return Math.ceil(cjk * TOKENS_PER_CJK_CHAR + other * TOKENS_PER_OTHER_CHAR);
}

function isCjkDominant(text: string): boolean {
  const chars = [...text];
  if (chars.length === 0) {
    return false;
  }
  // 日本語の記事は助詞とかなで CJK 比率が高くなる。2 割あれば「日本語混じり」
  // とみなして厳しいほうの上限を使う。
  return countCjk(text) / chars.length >= 0.2;
}

function truncateChars(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) {
    return text;
  }
  return chars.slice(0, maxChars).join("").trimEnd();
}

/**
 * 見積りトークン数が上限を超えないところまで文字を落とす。
 * 二分探索なので長文でも数回の見積りで済む。
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(chars.slice(0, mid).join("")) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return chars.slice(0, low).join("").trimEnd();
}

/**
 * 埋め込み入力を組み立てる。タイトルが無い候補は `none` を入れる
 * （モデルの規定書式。空文字にすると書式が崩れる）。
 *
 * 中身が何も無い場合は null を返す。呼び出し側はその候補の埋め込みを諦めて
 * よいが、**候補そのものを落とす理由にはしない**（FR-S-03）。
 */
export function formatDocumentForEmbedding(
  doc: DocumentForEmbedding,
): string | null {
  const title = truncateChars(normalize(doc.title), MAX_TITLE_CHARS);
  const summary = truncateChars(normalize(doc.summary), MAX_SUMMARY_CHARS);
  const rawBody = normalize(doc.body);

  if (!title && !summary && !rawBody) {
    return null;
  }

  const bodyLimit = isCjkDominant(rawBody || summary || title)
    ? MAX_BODY_CHARS_CJK
    : MAX_BODY_CHARS_LATIN;
  const body = truncateChars(rawBody, bodyLimit);

  // 要約と本文冒頭が同じ文で始まっているときは、要約だけ残す。crawler の
  // description が本文の第 1 段落そのままというソースが少なくない。
  const textParts: string[] = [];
  if (summary) {
    textParts.push(summary);
  }
  if (body && !(summary && body.startsWith(summary.slice(0, 60)))) {
    textParts.push(body);
  }

  const text = textParts.join(" ");
  const formatted = `title: ${title || "none"} | text: ${text}`;
  return truncateToTokens(formatted, MAX_EMBEDDING_TOKENS);
}
