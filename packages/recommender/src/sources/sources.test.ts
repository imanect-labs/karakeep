import { describe, expect, it } from "vitest";

import { arxivAdapter, parseArxivFeed } from "./arxiv";
import { buildQuery, githubAdapter } from "./github";
import { buildHnUrl, hnAdapter } from "./hn";
import { CONVENTIONAL_FEED_PATHS, discoverFeedUrls, parseFeed } from "./rss";
import { getSourceAdapter } from "./index";
import type { FetchContext } from "./types";
import { buildUserAgent, SourceFetchError, stripHtml, toDate } from "./types";

function context(
  body: string,
  overrides: Partial<FetchContext> = {},
): FetchContext {
  return {
    fetch: (async () =>
      new Response(body, { status: 200 })) as typeof globalThis.fetch,
    limit: 50,
    userAgent: "test",
    ...overrides,
  };
}

function failingContext(status: number): FetchContext {
  return {
    fetch: (async () =>
      new Response("nope", { status })) as typeof globalThis.fetch,
    limit: 50,
    userAgent: "test",
  };
}

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Blog</title>
    <item>
      <title>SQLite の WAL モード</title>
      <link>https://example.com/wal</link>
      <pubDate>Wed, 06 Aug 2026 10:00:00 GMT</pubDate>
      <description>&lt;p&gt;WAL の話。&lt;/p&gt;</description>
      <content:encoded>&lt;p&gt;本文はこちら。&lt;/p&gt;</content:encoded>
      <dc:creator>著者名</dc:creator>
    </item>
    <item>
      <title>古い記事</title>
      <link>https://example.com/old</link>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>リンクなし</title>
    </item>
  </channel>
</rss>`;

describe("rss adapter", () => {
  it("maps entries onto the collected shape", async () => {
    const items = await parseFeed(RSS_SAMPLE, { limit: 10 });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: "https://example.com/wal",
      title: "SQLite の WAL モード",
      author: "著者名",
    });
    expect(items[0].summary).toBe("WAL の話。");
    expect(items[0].contentExcerpt).toBe("本文はこちら。");
    expect(items[0].publishedAt?.toISOString()).toBe(
      "2026-08-06T10:00:00.000Z",
    );
  });

  it("skips entries without a link", async () => {
    const items = await parseFeed(RSS_SAMPLE, { limit: 10 });
    expect(items.map((i) => i.title)).not.toContain("リンクなし");
  });

  it("skips entries older than the last fetch", async () => {
    const items = await parseFeed(RSS_SAMPLE, {
      limit: 10,
      since: new Date("2026-01-01"),
    });
    expect(items.map((i) => i.title)).toEqual(["SQLite の WAL モード"]);
  });

  it("keeps undated entries", async () => {
    // 日付を出さないフィードは珍しくない。そこで捨てると永久に候補に入らない。
    const undated = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>t</title><link>https://example.com/a</link></item>
    </channel></rss>`;
    const items = await parseFeed(undated, {
      limit: 10,
      since: new Date("2026-01-01"),
    });
    expect(items).toHaveLength(1);
  });

  it("honours the limit", async () => {
    const items = await parseFeed(RSS_SAMPLE, { limit: 1 });
    expect(items).toHaveLength(1);
  });

  it("turns a broken feed into a SourceFetchError", async () => {
    await expect(parseFeed("<<<not xml", { limit: 10 })).rejects.toBeInstanceOf(
      SourceFetchError,
    );
  });

  it("reports an HTTP failure as a SourceFetchError", async () => {
    await expect(
      getSourceAdapter("rss")!.fetchItems(
        { feedUrl: "https://example.com/feed" } as never,
        failingContext(503),
      ),
    ).rejects.toBeInstanceOf(SourceFetchError);
  });

  it("refuses a source with no feed URL", async () => {
    await expect(
      getSourceAdapter("rss")!.fetchItems({} as never, context("")),
    ).rejects.toBeInstanceOf(SourceFetchError);
  });
});

describe("discoverFeedUrls", () => {
  it("picks up rel=alternate feed links and resolves them", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://cdn.example.com/atom">
      <link rel="stylesheet" href="/style.css">
      <link rel="alternate" type="text/html" href="/other">
    </head></html>`;
    expect(discoverFeedUrls(html, "https://example.com/blog/")).toEqual([
      "https://example.com/feed.xml",
      "https://cdn.example.com/atom",
    ]);
  });

  it("returns nothing when there is no feed link", () => {
    expect(discoverFeedUrls("<html></html>", "https://example.com")).toEqual(
      [],
    );
  });

  it("offers conventional paths as the fallback", () => {
    expect(CONVENTIONAL_FEED_PATHS).toContain("/feed");
    expect(CONVENTIONAL_FEED_PATHS).toContain("/index.xml");
  });
});

describe("hn adapter", () => {
  it("asks for new stories, not relevance-ranked ones", () => {
    // search は関連度順で、日次収集には向かない。
    const url = buildHnUrl({}, { limit: 30 });
    expect(url).toContain("/search_by_date?");
    expect(url).toContain("tags=story");
  });

  it("applies the points threshold", () => {
    expect(buildHnUrl({ minPoints: 50 }, { limit: 30 })).toContain(
      "numericFilters=points%3E%3D50",
    );
  });

  it("switches to the front page mode", () => {
    expect(buildHnUrl({ mode: "front_page" }, { limit: 30 })).toContain(
      "tags=front_page",
    );
  });

  it("drops Ask HN style posts that carry no external URL", async () => {
    const body = JSON.stringify({
      hits: [
        {
          objectID: "1",
          title: "A post",
          url: "https://example.com/a",
          created_at: "2026-08-06T00:00:00Z",
        },
        { objectID: "2", title: "Ask HN: something", url: null },
      ],
    });
    const items = await hnAdapter.fetchItems({}, context(body));
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://example.com/a");
  });
});

describe("arxiv adapter", () => {
  const ATOM = `<feed>
    <entry>
      <id>http://arxiv.org/abs/2608.00001v1</id>
      <title>  A Study of
      Something </title>
      <summary>We show that &lt;b&gt;things&lt;/b&gt; work.</summary>
      <published>2026-08-06T00:00:00Z</published>
      <author><name>Ada L.</name></author>
      <author><name>Grace H.</name></author>
    </entry>
  </feed>`;

  it("maps entries and joins authors", () => {
    const items = parseArxivFeed(ATOM, 10);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("A Study of Something");
    expect(items[0].author).toBe("Ada L., Grace H.");
    expect(items[0].summary).toBe("We show that things work.");
    expect(items[0].lang).toBe("en");
  });

  it("uses the https abs page, not the pdf", () => {
    expect(parseArxivFeed(ATOM, 10)[0].url).toBe(
      "https://arxiv.org/abs/2608.00001v1",
    );
  });

  it("skips entries older than the last fetch", () => {
    expect(parseArxivFeed(ATOM, 10, new Date("2026-09-01"))).toHaveLength(0);
  });

  it("refuses a source with neither categories nor query", async () => {
    await expect(
      arxivAdapter.fetchItems({}, context(ATOM)),
    ).rejects.toBeInstanceOf(SourceFetchError);
  });
});

describe("github adapter", () => {
  it("builds a query with stars and a recency window", () => {
    const query = buildQuery({ language: "rust", minStars: 100 });
    expect(query).toContain("language:rust");
    expect(query).toContain("stars:>=100");
    expect(query).toMatch(/created:>\d{4}-\d{2}-\d{2}/);
  });

  it("treats the last push as the freshness signal", async () => {
    // 古いリポジトリが再活性化したときに拾えるようにする。
    const body = JSON.stringify({
      items: [
        {
          html_url: "https://github.com/a/b",
          full_name: "a/b",
          description: "desc",
          created_at: "2020-01-01T00:00:00Z",
          pushed_at: "2026-08-06T00:00:00Z",
          stargazers_count: 500,
          owner: { login: "a" },
        },
      ],
    });
    const items = await githubAdapter.fetchItems({}, context(body));
    expect(items[0].publishedAt?.toISOString()).toBe(
      "2026-08-06T00:00:00.000Z",
    );
    expect(items[0].author).toBe("a");
  });
});

describe("adapter registry", () => {
  it("resolves the implemented kinds", () => {
    expect(getSourceAdapter("rss")).not.toBeNull();
    expect(getSourceAdapter("hn")).not.toBeNull();
    expect(getSourceAdapter("arxiv")).not.toBeNull();
    expect(getSourceAdapter("github")).not.toBeNull();
  });

  it("returns null for kinds that are not implemented yet", () => {
    // 呼び出し側は「そのソースを飛ばす」として扱う。1 ソースの欠落で収集
    // 全体を止めない。
    expect(getSourceAdapter("scrape")).toBeNull();
    expect(getSourceAdapter("custom")).toBeNull();
  });
});

describe("helpers", () => {
  it("puts the contact address in the User-Agent", () => {
    // 誰が叩いているか分かるようにしておくのがブロックされない最低条件。
    expect(buildUserAgent("https://example.com/about")).toContain(
      "+https://example.com/about",
    );
    expect(buildUserAgent(undefined)).toBe("KarakeepRecommender/0.1");
  });

  it("tells unix seconds from milliseconds", () => {
    expect(toDate(1785000000)?.getUTCFullYear()).toBe(2026);
    expect(toDate(1785000000000)?.getUTCFullYear()).toBe(2026);
  });

  it("returns null for junk timestamps", () => {
    expect(toDate("not a date")).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate("")).toBeNull();
  });

  it("strips markup and script bodies", () => {
    expect(stripHtml("<p>a<script>evil()</script>b</p>")).toBe("a b");
    expect(stripHtml("<p>  </p>")).toBeNull();
    expect(stripHtml(null)).toBeNull();
  });
});
