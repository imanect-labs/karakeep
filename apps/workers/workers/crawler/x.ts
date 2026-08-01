// X (Twitter) post metadata (imanect-labs fork).
//
// X serves the same Open Graph tags for every post on an account: og:title is
// "<Display Name> (@handle) on X" and og:image is the profile picture, so every
// bookmarked post ended up titled with the account name and illustrated with its
// avatar. Long-form "X Articles" are worse still: the post body is a single t.co
// link, so nothing readable is stored at all.
//
// The syndication endpoint below is the same source the web app's XRenderer
// already reads through react-tweet. It needs no auth and returns the post text,
// the author, attached media, quoted posts, and — for articles — a preview and a
// real cover image.

const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";
const FETCH_TIMEOUT_MS = 10_000;
const TITLE_MAX_CHARS = 100;

export interface XPostContent {
  title: string;
  description: string;
  /** Null when the post has no media: better no image than the account avatar. */
  image: string | null;
  author: string;
  publisher: string;
  datePublished: string | null;
  html: string;
}

export function extractTweetId(url: string): string | null {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "x.com" && host !== "twitter.com" && host !== "mobile.x.com") {
    return null;
  }
  const match = /^\/(?:[^/]+\/status|i\/web\/status)\/(\d+)/.exec(
    parsed.pathname,
  );
  return match ? match[1] : null;
}

/** The token the syndication endpoint expects, as computed by react-tweet. */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/** X returns post text with HTML entities already encoded; decode before re-escaping. */
const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Swap t.co shorteners for the URLs they point at. */
function expandUrls(
  text: string,
  urls?: { url?: string; expanded_url?: string }[],
): string {
  let out = text;
  for (const u of urls ?? []) {
    if (u.url && u.expanded_url) {
      out = out.split(u.url).join(u.expanded_url);
    }
  }
  return out;
}

/** First sentence or line, trimmed to something that reads as a title. */
function toTitle(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) {
    return null;
  }
  const firstSentence = /^(.{10,}?[。．.!?！？])\s/.exec(flat);
  const candidate = firstSentence ? firstSentence[1] : flat;
  return candidate.length > TITLE_MAX_CHARS
    ? candidate.slice(0, TITLE_MAX_CHARS).trimEnd() + "…"
    : candidate;
}

interface SyndicationTweet {
  text?: string;
  created_at?: string;
  entities?: { urls?: { url?: string; expanded_url?: string }[] };
  user?: { name?: string; screen_name?: string };
  photos?: { url?: string }[];
  mediaDetails?: { type?: string; media_url_https?: string }[];
  video?: { poster?: string };
  quoted_tweet?: {
    text?: string;
    user?: { name?: string; screen_name?: string };
  };
  article?: {
    title?: string;
    preview_text?: string;
    cover_media?: { media_info?: { original_img_url?: string } };
  };
}

/** True when the post text carries nothing but a link (an article's does). */
function isJustALink(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim());
}

function buildHtml(tweet: SyndicationTweet, text: string): string {
  const parts: string[] = [];
  // An article's post text is only the link to the article, which the article
  // body below already stands in for.
  if (text && !isJustALink(text)) {
    parts.push(`<p>${escapeHtml(text)}</p>`);
  }

  const article = tweet.article;
  if (article?.title) {
    parts.push(`<h2>${escapeHtml(article.title)}</h2>`);
  }
  if (article?.preview_text) {
    parts.push(`<p>${escapeHtml(article.preview_text)}</p>`);
  }

  for (const photo of tweet.photos ?? []) {
    if (photo.url) {
      parts.push(`<img src="${escapeHtml(photo.url)}" alt="">`);
    }
  }

  const quoted = tweet.quoted_tweet;
  if (quoted?.text) {
    const who = quoted.user?.screen_name ? `@${quoted.user.screen_name}` : "";
    parts.push(
      `<blockquote>${who ? `<p>${escapeHtml(who)}</p>` : ""}<p>${escapeHtml(
        decodeEntities(expandUrls(quoted.text, tweet.entities?.urls)),
      )}</p></blockquote>`,
    );
  }

  return parts.length ? `<div>${parts.join("")}</div>` : "";
}

function firstMediaUrl(tweet: SyndicationTweet): string | null {
  const cover = tweet.article?.cover_media?.media_info?.original_img_url;
  if (cover) {
    return cover;
  }
  const photo = tweet.photos?.find((p) => p.url)?.url;
  if (photo) {
    return photo;
  }
  if (tweet.video?.poster) {
    return tweet.video.poster;
  }
  return (
    tweet.mediaDetails?.find((m) => m.media_url_https)?.media_url_https ?? null
  );
}

/**
 * Post content for an X URL, or null when the URL isn't one, the endpoint is
 * unreachable, or the response is unusable. Callers keep the crawled metadata in
 * that case, so a failure here only means no improvement, never a broken crawl.
 */
export async function fetchXPostContent(
  url: string,
  logPrefix: string,
  log: { info: (m: string) => void; warn: (m: string) => void },
): Promise<XPostContent | null> {
  const id = extractTweetId(url);
  if (!id) {
    return null;
  }

  let tweet: SyndicationTweet;
  try {
    const res = await fetch(
      `${SYNDICATION_URL}?id=${id}&lang=en&token=${syndicationToken(id)}`,
      {
        headers: { "user-agent": "Mozilla/5.0 (compatible; karakeep)" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      log.warn(
        `${logPrefix} X syndication lookup for "${id}" returned ${res.status}; keeping the crawled metadata.`,
      );
      return null;
    }
    tweet = (await res.json()) as SyndicationTweet;
  } catch (e) {
    log.warn(
      `${logPrefix} X syndication lookup for "${id}" failed: ${e}; keeping the crawled metadata.`,
    );
    return null;
  }

  const text = decodeEntities(
    expandUrls(tweet.text ?? "", tweet.entities?.urls),
  ).trim();
  const article = tweet.article;
  // An article's post text is just the link to it, so its preview is the content.
  const titleSource =
    article?.title || article?.preview_text || (isJustALink(text) ? "" : text);
  const title = toTitle(titleSource);
  const name = tweet.user?.name ?? "";
  const handle = tweet.user?.screen_name ? `@${tweet.user.screen_name}` : "";

  if (!title && !article) {
    log.warn(
      `${logPrefix} X post "${id}" has no usable text; keeping the crawled metadata.`,
    );
    return null;
  }

  const description = article?.preview_text?.trim() || text;
  log.info(
    `${logPrefix} Rebuilt X post "${id}" from syndication${article ? " (article)" : ""}.`,
  );

  return {
    title: title ?? `${name} ${handle}`.trim(),
    description,
    image: firstMediaUrl(tweet),
    author: name,
    publisher: handle ? `X (${handle})` : "X",
    datePublished: tweet.created_at ?? null,
    html: buildHtml(tweet, text),
  };
}
