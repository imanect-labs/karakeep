import { createHash } from "node:crypto";

/**
 * URL の正規化と重複判定（FR-C-04 / FR-C-05）。
 *
 * 同じ記事が RSS・Hacker News・アグリゲータから別々の URL で流れてくる。
 * トラッキングパラメータ付き、AMP 版、末尾スラッシュ違い、www の有無 —
 * 正規化しないと候補プールが同じ記事で埋まり、多様性制約も意味をなさなくなる。
 */

/**
 * 除去するクエリパラメータ。前方一致で消すものは `PREFIXES` に置く。
 * ここに無いパラメータは残す。記事の同一性に関わるパラメータ（`?id=123`,
 * `?p=456` のような CMS のパーマリンク）を巻き込んで消すほうが害が大きい。
 */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "source",
  "spm",
  "scid",
  "cmpid",
  "campaign_id",
  "at_medium",
  "at_campaign",
  "s_kwcid",
  "vero_id",
  "vero_conv",
  "trk",
  "trkCampaign",
  "sc_channel",
  "sc_campaign",
  "amp",
  "usp",
]);

const TRACKING_PARAM_PREFIXES = ["utm_", "_hs", "pk_", "piwik_", "matomo_"];

/**
 * `si` は YouTube の共有トラッキングだが、他サイトでは意味のあるパラメータで
 * ありうる。ホストを見て消す。
 */
const HOST_SCOPED_TRACKING_PARAMS: Record<string, string[]> = {
  "youtube.com": ["si", "pp", "feature"],
  "youtu.be": ["si", "t"],
  "open.spotify.com": ["si"],
};

function isTrackingParam(key: string, host: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) {
    return true;
  }
  if (TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
    return true;
  }
  const scoped = HOST_SCOPED_TRACKING_PARAMS[host];
  return scoped ? scoped.includes(lower) : false;
}

/**
 * Google AMP キャッシュ URL から元の URL を復元する。
 * `https://example-com.cdn.ampproject.org/c/s/example.com/post` の形。
 */
function resolveAmpCache(url: URL): URL | null {
  if (!url.hostname.endsWith(".cdn.ampproject.org")) {
    return null;
  }
  // パスは /c/ または /c/s/ で始まり、そのあとが元のホスト + パス。
  const match = /^\/[cvia]\/(s\/)?(.+)$/.exec(url.pathname);
  if (!match) {
    return null;
  }
  const scheme = match[1] ? "https" : "http";
  try {
    return new URL(`${scheme}://${match[2]}${url.search}`);
  } catch {
    return null;
  }
}

/** AMP のパス・サブドメイン表記を元のページに寄せる。 */
function stripAmpMarkers(url: URL): void {
  if (url.hostname.startsWith("amp.")) {
    url.hostname = url.hostname.slice(4);
  }
  url.pathname = url.pathname
    .replace(/\/amp\/?$/i, "/")
    .replace(/\/amp\//i, "/")
    .replace(/\.amp(\.html?)?$/i, "$1");
}

export interface NormalizedUrl {
  /** 重複判定と表示に使う正規化済み URL。 */
  canonicalUrl: string;
  /** 正規化済み URL の SHA-256（先頭 32 文字）。一意制約のキー。 */
  urlHash: string;
  /** `www.` を落としたホスト名。ドメイン単位のバンディットのキー。 */
  domain: string;
}

/**
 * URL を正規化する。パースできない文字列は null を返す（候補ごと落とす）。
 *
 * `domain` は eTLD+1 ではなくホスト名そのもの（`www.` だけ落とす）にしている。
 * Public Suffix List を持ち込むと依存とデータ更新が増えるわりに、この用途
 * — 「どのサイトを購読するか」— ではサブドメインを区別したいことのほうが多い。
 * `blog.example.com` と `shop.example.com` は別のソースとして扱いたい。
 */
export function normalizeUrl(raw: string): NormalizedUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const resolved = resolveAmpCache(url);
  if (resolved) {
    url = resolved;
  }

  // http は https に寄せる。同じ記事が両方で流れてくることがあり、
  // スキーム違いだけで重複させたくない。
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.port = "";
  url.hash = "";

  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
  }
  stripAmpMarkers(url);

  const host = url.hostname;
  const params = [...url.searchParams.entries()].filter(
    ([key]) => !isTrackingParam(key, host),
  );
  // 残ったパラメータはキー順に並べ替える。順番違いを別 URL にしない。
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of params) {
    url.searchParams.append(key, value);
  }

  // ルート以外の末尾スラッシュを落とす。
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  if (url.pathname === "") {
    url.pathname = "/";
  }

  const canonicalUrl = url.toString();
  return {
    canonicalUrl,
    urlHash: sha256Short(canonicalUrl),
    domain: host,
  };
}

/** ホスト名だけ取り出す。フィード URL からドメインを引くときなどに使う。 */
export function domainOf(raw: string): string | null {
  return normalizeUrl(raw)?.domain ?? null;
}

function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/**
 * タイトルの正規化ハッシュ。同じ記事が別 URL で流れてきたときの第 2 の
 * 手がかりになる（第 1 は URL、第 3 は埋め込み近傍）。
 *
 * 記号と空白を落として小文字化するだけにとどめる。ストップワード除去まで
 * やると「Rust 1.90 released」と「Rust 1.91 released」が同一になる。
 */
export function normalizeTitleHash(
  title: string | null | undefined,
): string | null {
  if (!title) {
    return null;
  }
  const normalized = title
    .normalize("NFKC")
    .toLowerCase()
    // 記号・約物を落とす。CJK は残す。
    .replace(/[!-/:-@[-`{-~、-〜「」『』・]/gu, "")
    .replace(/\s+/g, "")
    .trim();
  return normalized.length === 0 ? null : sha256Short(normalized);
}
