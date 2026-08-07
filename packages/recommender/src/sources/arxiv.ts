import type { CollectedItem, SourceAdapter } from "./types";
import { fetchText, SourceFetchError, stripHtml, toDate } from "./types";

export interface ArxivSourceConfig {
  /** 例: `cs.IR`, `cs.LG`。複数指定は OR で結合する。 */
  categories?: string[];
  /** 任意の検索語。カテゴリと AND で結合する。 */
  query?: string;
}

const ARXIV_API = "https://export.arxiv.org/api/query";

/**
 * arXiv の Atom API。
 *
 * `rss-parser` に通さず自前で読んでいるのは、arXiv の Atom が `<summary>` に
 * アブストラクト全文を入れる独自の使い方をしていて、汎用パーサだと要約と
 * 本文の区別が付かないため。ここでは要約＝アブストラクトとして扱う。
 */
export const arxivAdapter: SourceAdapter<ArxivSourceConfig> = {
  kind: "arxiv",

  async fetchItems(config, ctx): Promise<CollectedItem[]> {
    const terms: string[] = [];
    if (config.categories?.length) {
      terms.push(`(${config.categories.map((c) => `cat:${c}`).join(" OR ")})`);
    }
    if (config.query) {
      terms.push(`all:${config.query}`);
    }
    if (terms.length === 0) {
      throw new SourceFetchError(
        "arxiv source has neither categories nor query",
      );
    }

    const params = new URLSearchParams({
      search_query: terms.join(" AND "),
      sortBy: "submittedDate",
      sortOrder: "descending",
      max_results: String(Math.min(ctx.limit, 100)),
    });
    const xml = await fetchText(`${ARXIV_API}?${params.toString()}`, ctx);
    return parseArxivFeed(xml, ctx.limit, ctx.since);
  },
};

export function parseArxivFeed(
  xml: string,
  limit: number,
  since?: Date | null,
): CollectedItem[] {
  const items: CollectedItem[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    // abs ページの URL を使う。pdf 直リンクだと本文が取れない。
    const url = tag(entry, "id")?.replace("http://", "https://");
    if (!url) {
      continue;
    }
    const publishedAt = toDate(tag(entry, "published"));
    if (since && publishedAt && publishedAt <= since) {
      continue;
    }
    const authors = [
      ...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g),
    ]
      .map((m) => m[1].trim())
      .filter(Boolean);

    items.push({
      url,
      title: normalizeWhitespace(tag(entry, "title")),
      summary: normalizeWhitespace(stripHtml(tag(entry, "summary"))),
      contentExcerpt: null,
      author: authors.length > 0 ? authors.join(", ") : null,
      publishedAt,
      lang: "en",
    });
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeEntities(match[1]) : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeWhitespace(text: string | null): string | null {
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : null;
}
