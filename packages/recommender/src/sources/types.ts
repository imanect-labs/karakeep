/**
 * 収集元アダプタ（FR-C-01 / FR-C-02）。
 *
 * ソース種別はプラグイン的に足せる形にする。アダプタが返すのは「正規化前の
 * 生の記事」までで、URL 正規化・重複判定・上限配分は呼び出し側（collectWorker）
 * が一括でやる。アダプタごとに重複判定を書くと基準がずれる。
 */

export type RecSourceKind =
  | "rss"
  | "hn"
  | "arxiv"
  | "github"
  | "scrape"
  | "custom";

export interface CollectedItem {
  url: string;
  title: string | null;
  summary: string | null;
  contentExcerpt: string | null;
  author: string | null;
  publishedAt: Date | null;
  lang: string | null;
}

export interface FetchContext {
  /** 差し替え可能にしてテストをネットワークから切り離す。 */
  fetch: typeof globalThis.fetch;
  /** 1 回の取得で返す最大件数。取り込み上限とは別で、これは礼儀の側。 */
  limit: number;
  /** これより古い記事は要らない。前回取得時刻を渡す。 */
  since?: Date | null;
  signal?: AbortSignal;
  userAgent: string;
}

export interface SourceAdapter<TConfig = Record<string, unknown>> {
  kind: RecSourceKind;
  fetchItems(config: TConfig, ctx: FetchContext): Promise<CollectedItem[]>;
}

/**
 * User-Agent には連絡先を入れる（FR-D-16c）。相手に「誰が叩いているのか」を
 * 分かるようにしておくのは、ブロックされないための最低限の礼儀。
 */
export function buildUserAgent(contact: string | undefined): string {
  const suffix = contact ? ` (+${contact})` : "";
  return `KarakeepRecommender/0.1${suffix}`;
}

/** ソース単位の失敗。他ソースの処理は止めない（FR-C-07）。 */
export class SourceFetchError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}

export async function fetchJson<T>(url: string, ctx: FetchContext): Promise<T> {
  const response = await ctx.fetch(url, {
    headers: { "User-Agent": ctx.userAgent, Accept: "application/json" },
    signal: ctx.signal,
  });
  if (!response.ok) {
    throw new SourceFetchError(`${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchText(
  url: string,
  ctx: FetchContext,
): Promise<string> {
  const response = await ctx.fetch(url, {
    headers: { "User-Agent": ctx.userAgent },
    signal: ctx.signal,
  });
  if (!response.ok) {
    throw new SourceFetchError(`${url} returned ${response.status}`);
  }
  return await response.text();
}

/** 秒・ミリ秒・ISO 文字列のどれで来ても Date にする。null は許す。 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    // Unix 秒とミリ秒の区別。2001-09-09 より前に見えたら秒とみなす。
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** HTML タグを落として素のテキストにする。要約欄が HTML のフィード向け。 */
export function stripHtml(html: string | null | undefined): string | null {
  if (!html) {
    return null;
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length === 0 ? null : text;
}
