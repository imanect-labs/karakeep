import type { CollectedItem, FetchContext, SourceAdapter } from "./types";
import { fetchJson, toDate } from "./types";

export interface HnSourceConfig {
  /** `front_page` は HN のフロントページ、`story` は点数しきい値で拾う。 */
  mode?: "front_page" | "story";
  minPoints?: number;
  query?: string;
}

interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  points?: number | null;
  created_at?: string | null;
  story_text?: string | null;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
}

const ALGOLIA_BASE = "https://hn.algolia.com/api/v1";

/**
 * Hacker News（Algolia API）。
 *
 * 記事の供給源としても使うが、**本命はドメインの標本**として使うこと
 * （D4 / FR-D-06）。HN の記事そのものは玉石混交でも、上位に上がるドメインの
 * 分布は良質な独立ブログの標本として優秀。ドメイン抽出は discovery 側で
 * 同じレスポンスを使う。
 */
export const hnAdapter: SourceAdapter<HnSourceConfig> = {
  kind: "hn",

  async fetchItems(config, ctx): Promise<CollectedItem[]> {
    const url = buildHnUrl(config, ctx);
    const response = await fetchJson<AlgoliaResponse>(url, ctx);
    return (response.hits ?? [])
      .filter((hit) => !!hit.url)
      .map((hit) => ({
        url: hit.url!,
        title: hit.title?.trim() ?? null,
        summary: null,
        contentExcerpt: hit.story_text ?? null,
        author: null,
        publishedAt: toDate(hit.created_at ?? null),
        lang: null,
      }))
      .slice(0, ctx.limit);
  },
};

export function buildHnUrl(
  config: HnSourceConfig,
  ctx: Pick<FetchContext, "limit" | "since">,
): string {
  const params = new URLSearchParams();
  params.set("hitsPerPage", String(Math.min(ctx.limit, 100)));

  const filters: string[] = [];
  if (config.mode === "front_page") {
    filters.push("front_page");
  } else {
    filters.push("story");
    if (config.minPoints) {
      // 点数のしきい値。低すぎると玉石混交がそのまま入る。
      params.set("numericFilters", `points>=${config.minPoints}`);
    }
  }
  params.set("tags", filters.join(","));
  if (config.query) {
    params.set("query", config.query);
  }

  // search_by_date は新着順。search は関連度順で、日次収集には向かない。
  const endpoint = config.query ? "search" : "search_by_date";
  return `${ALGOLIA_BASE}/${endpoint}?${params.toString()}`;
}
