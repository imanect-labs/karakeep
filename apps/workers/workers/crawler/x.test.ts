import { afterEach, describe, expect, test, vi } from "vitest";

import { extractTweetId, fetchXPostContent } from "./x";

const log = { info: () => undefined, warn: () => undefined };

describe("extractTweetId", () => {
  test("accepts the X and Twitter post URLs we see in practice", () => {
    expect(
      extractTweetId("https://x.com/langchain/status/2083236117839499511"),
    ).toBe("2083236117839499511");
    // The share sheet appends ?s=46.
    expect(
      extractTweetId(
        "https://x.com/nathanflurry/status/2083202564775117263?s=46",
      ),
    ).toBe("2083202564775117263");
    expect(extractTweetId("https://twitter.com/jack/status/20")).toBe("20");
    expect(extractTweetId("https://x.com/i/web/status/12345")).toBe("12345");
    expect(extractTweetId("https://www.x.com/a/status/999")).toBe("999");
  });

  test("rejects anything that is not a post", () => {
    expect(extractTweetId("https://x.com/langchain")).toBeNull();
    expect(extractTweetId("https://example.com/x.com/a/status/1")).toBeNull();
    expect(extractTweetId("https://notx.com/a/status/1")).toBeNull();
    expect(extractTweetId("not a url")).toBeNull();
  });
});

function mockResponse(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 404,
      json: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchXPostContent", () => {
  test("returns null for a non-X url without calling out", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(
      await fetchXPostContent("https://example.com/a", "[t]", log),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("uses the post text, not the account name, and expands t.co links", async () => {
    mockResponse({
      text: "Kubernetes is the wrong primitive for diverse workloads https://t.co/bSfy6gpGsU",
      created_at: "2026-07-29T10:00:00.000Z",
      entities: {
        urls: [
          {
            url: "https://t.co/bSfy6gpGsU",
            expanded_url: "https://example.com/post",
          },
        ],
      },
      user: { name: "Ivan Burazin", screen_name: "ivanburazin" },
    });

    const post = await fetchXPostContent(
      "https://x.com/ivanburazin/status/2082640448448057784",
      "[t]",
      log,
    );

    expect(post?.title).toContain("Kubernetes is the wrong primitive");
    expect(post?.title).not.toContain("Ivan Burazin");
    expect(post?.author).toBe("Ivan Burazin");
    expect(post?.publisher).toBe("X (@ivanburazin)");
    expect(post?.html).toContain("https://example.com/post");
    expect(post?.html).not.toContain("t.co/bSfy6gpGsU");
  });

  test("never returns the account avatar as the image", async () => {
    mockResponse({
      text: "a post with no media at all, just some words to title with",
      user: { name: "A", screen_name: "a" },
      // The avatar is what og:image would have given us.
      photos: [],
      mediaDetails: [],
    });
    const post = await fetchXPostContent(
      "https://x.com/a/status/1",
      "[t]",
      log,
    );
    expect(post?.image).toBeNull();
  });

  test("takes an article's preview and cover image", async () => {
    mockResponse({
      text: "https://t.co/2mffiKkWZa",
      entities: {
        urls: [
          {
            url: "https://t.co/2mffiKkWZa",
            expanded_url: "http://x.com/i/article/2083185690137792512",
          },
        ],
      },
      user: { name: "LangChain", screen_name: "LangChain" },
      article: {
        preview_text:
          "There are more code review agents now, and we have been building one internally. Code review is hard to evaluate.",
        cover_media: {
          media_info: {
            original_img_url: "https://pbs.twimg.com/media/HOj2ZanWMAA1W1f.png",
          },
        },
      },
    });

    const post = await fetchXPostContent(
      "https://x.com/langchain/status/2083236117839499511",
      "[t]",
      log,
    );

    expect(post?.title).toContain("There are more code review agents now");
    expect(post?.image).toBe("https://pbs.twimg.com/media/HOj2ZanWMAA1W1f.png");
    expect(post?.description).toContain("code review agents");
    expect(post?.html).toContain("code review agents");
  });

  test("drops the post text when it is only the link to the article", async () => {
    mockResponse({
      text: "https://t.co/abc",
      entities: {
        urls: [
          { url: "https://t.co/abc", expanded_url: "http://x.com/i/article/1" },
        ],
      },
      user: { name: "A", screen_name: "a" },
      article: {
        title: "The article",
        preview_text: "The body of the article.",
      },
    });
    const post = await fetchXPostContent(
      "https://x.com/a/status/1",
      "[t]",
      log,
    );
    expect(post?.html).not.toContain("<p>http://x.com/i/article/1</p>");
    expect(post?.html).toContain("<h2>The article</h2>");
    expect(post?.title).toBe("The article");
  });

  test("does not double-escape entities X already encoded", async () => {
    mockResponse({
      text: "Litestream &amp; others didn't fit, plus more words for a title",
      user: { name: "A", screen_name: "a" },
    });
    const post = await fetchXPostContent(
      "https://x.com/a/status/1",
      "[t]",
      log,
    );
    expect(post?.html).toContain("Litestream &amp; others");
    expect(post?.html).not.toContain("&amp;amp;");
  });

  test("prefers attached media over nothing", async () => {
    mockResponse({
      text: "look at this, here are some words so the title is usable",
      user: { name: "A", screen_name: "a" },
      photos: [{ url: "https://pbs.twimg.com/media/photo.jpg" }],
    });
    const post = await fetchXPostContent(
      "https://x.com/a/status/1",
      "[t]",
      log,
    );
    expect(post?.image).toBe("https://pbs.twimg.com/media/photo.jpg");
    expect(post?.html).toContain("<img src=");
  });

  test("includes a quoted post in the body", async () => {
    mockResponse({
      text: "this is worth reading, and here is a bit more text for the title",
      user: { name: "A", screen_name: "a" },
      quoted_tweet: {
        text: "the original claim being quoted",
        user: { name: "B", screen_name: "b" },
      },
    });
    const post = await fetchXPostContent(
      "https://x.com/a/status/1",
      "[t]",
      log,
    );
    expect(post?.html).toContain("<blockquote>");
    expect(post?.html).toContain("@b");
    expect(post?.html).toContain("the original claim being quoted");
  });

  test("escapes markup from the post text", async () => {
    mockResponse({
      text: '<script>alert("x")</script> and some more words for the title',
      user: { name: "A", screen_name: "a" },
    });
    const post = await fetchXPostContent(
      "https://x.com/a/status/1",
      "[t]",
      log,
    );
    expect(post?.html).not.toContain("<script>");
    expect(post?.html).toContain("&lt;script&gt;");
  });

  test("keeps the crawled metadata when the endpoint fails", async () => {
    mockResponse({}, false);
    expect(
      await fetchXPostContent("https://x.com/a/status/1", "[t]", log),
    ).toBeNull();
  });

  test("keeps the crawled metadata when the post has no usable text", async () => {
    mockResponse({ text: "", user: { name: "A", screen_name: "a" } });
    expect(
      await fetchXPostContent("https://x.com/a/status/1", "[t]", log),
    ).toBeNull();
  });
});
