import { arxivAdapter } from "./arxiv";
import { githubAdapter } from "./github";
import { hnAdapter } from "./hn";
import { rssAdapter } from "./rss";
import type { RecSourceKind, SourceAdapter } from "./types";

export * from "./types";
export * from "./seed";
export * from "./rss";
export * from "./hn";
export * from "./arxiv";
export * from "./github";

/**
 * ソース種別からアダプタを引く。`scrape` と `custom` は Phase 1 では未実装で、
 * 呼び出し側は null を「そのソースを飛ばす」として扱う（FR-C-07 の精神で、
 * 1 ソースの欠落が収集全体を止めない）。
 */
const ADAPTERS: Partial<Record<RecSourceKind, SourceAdapter<never>>> = {
  rss: rssAdapter as SourceAdapter<never>,
  hn: hnAdapter as SourceAdapter<never>,
  arxiv: arxivAdapter as SourceAdapter<never>,
  github: githubAdapter as SourceAdapter<never>,
};

export function getSourceAdapter(
  kind: RecSourceKind,
): SourceAdapter<never> | null {
  return ADAPTERS[kind] ?? null;
}
