import Parser from "rss-parser";

import type { CollectedItem, FetchContext, SourceAdapter } from "./types";
import { fetchText, SourceFetchError, stripHtml, toDate } from "./types";

export interface RssSourceConfig {
  feedUrl: string;
}

/**
 * RSS / Atom フィード。既存の `feedWorker` と同じ `rss-parser` を使うが、
 * **ブックマークは作らない**（FR-C-01）。候補プールに入れるだけ。
 *
 * 取得を `rss-parser` の `parseURL` に任せず自前の fetch にしてあるのは、
 * User-Agent（連絡先入り）と AbortSignal を通すため。
 */
export const rssAdapter: SourceAdapter<RssSourceConfig> = {
  kind: "rss",

  async fetchItems(config, ctx): Promise<CollectedItem[]> {
    if (!config.feedUrl) {
      throw new SourceFetchError("rss source has no feedUrl");
    }
    const xml = await fetchText(config.feedUrl, ctx);
    return parseFeed(xml, ctx);
  },
};

export async function parseFeed(
  xml: string,
  ctx: Pick<FetchContext, "limit" | "since">,
): Promise<CollectedItem[]> {
  const parser = new Parser({
    customFields: {
      item: [
        ["content:encoded", "contentEncoded"],
        ["dc:creator", "dcCreator"],
      ],
    },
  });

  let feed;
  try {
    feed = await parser.parseString(xml);
  } catch (e) {
    throw new SourceFetchError("failed to parse feed", e);
  }

  const items: CollectedItem[] = [];
  for (const entry of feed.items ?? []) {
    const url = entry.link?.trim();
    if (!url) {
      continue;
    }
    const publishedAt = toDate(entry.isoDate ?? entry.pubDate ?? null);
    // 前回取得より古いものは捨てる。日付の無いエントリは残す — 日付を出さない
    // フィードは珍しくなく、そこで捨てると永久に候補に入らない。
    if (ctx.since && publishedAt && publishedAt <= ctx.since) {
      continue;
    }

    items.push({
      url,
      title: entry.title?.trim() ?? null,
      summary: stripHtml(entry.contentSnippet ?? entry.summary ?? null),
      contentExcerpt: stripHtml(entry.contentEncoded ?? entry.content ?? null),
      author: entry.creator ?? entry.dcCreator ?? null,
      publishedAt,
      lang: null,
    });
    if (items.length >= ctx.limit) {
      break;
    }
  }
  return items;
}

/**
 * HTML から `<link rel="alternate">` のフィード URL を拾う（D3 / FR-D-05）。
 * 見つからなければ慣例パスを順に試すのは呼び出し側の仕事。
 */
export function discoverFeedUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const linkPattern = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) {
      continue;
    }
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) {
      continue;
    }
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) {
      continue;
    }
    try {
      urls.push(new URL(href, baseUrl).toString());
    } catch {
      // 相対解決に失敗した href は捨てる。
    }
  }
  return [...new Set(urls)];
}

/** `<link>` が無いサイト向けの慣例パス（FR-D-05）。 */
export const CONVENTIONAL_FEED_PATHS = [
  "/feed",
  "/feed.xml",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feed/",
  "/rss",
];
