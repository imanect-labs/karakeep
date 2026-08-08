/**
 * 品質ゲート（FR-D-12）。
 *
 * 無差別にドメインを増やすと SEO スパムとコンテンツファームで候補プールが
 * 埋まる。`discovered` から `screened` に上げる前に 4 段通す。
 *
 * 1. ブロックリスト
 * 2. 更新頻度（直近 90 日に 3 記事以上）
 * 3. 一次情報らしさのヒューリスティック
 * 4. LLM によるドメイン分類 — **ドメインあたり 1 回のみ**
 *
 * ここに置くのは 1〜3。4 は LLM 呼び出しなので worker 側にある。
 * 1〜3 で落ちるものを LLM に回さないのが、コストを無視できる水準に保つ鍵。
 */

/**
 * 既知のコンテンツファーム・転載アグリゲータ・短縮 URL。
 *
 * 網羅を目指さない。ここは「明らかに要らないものを安く落とす」ための
 * 場所で、判断が微妙なものは 2〜4 段目に任せる。
 */
const BLOCKED_SUFFIXES = [
  // 短縮 URL — 記事の供給源になりえない。
  "bit.ly",
  "t.co",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "lnkd.in",
  "tinyurl.com",
  // 大手プラットフォームの汎用ドメイン。個別のブログはサブドメインや
  // パスで分かれるが、ドメイン単位で購読する対象ではない。
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "pinterest.com",
  "tiktok.com",
  "reddit.com",
  "quora.com",
  // 転載・自動生成が多い。
  "medium.com",
  "note.com",
  "qiita.com",
  "zenn.dev",
];

/**
 * `medium.com` / `qiita.com` / `zenn.dev` をブロックしているのは、
 * **ドメイン単位のバンディットが機能しないため**。中身の質が書き手ごとに
 * まったく違うので、ドメインの事後分布が何も意味しない。個々の記事は
 * アグリゲータ経由で候補に入るので、記事が読めなくなるわけではない。
 */
export function isBlockedDomain(domain: string): boolean {
  const normalized = domain.toLowerCase();
  return BLOCKED_SUFFIXES.some(
    (blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`),
  );
}

export const MIN_ARTICLES_IN_WINDOW = 3;
export const UPDATE_WINDOW_DAYS = 90;

/** 更新が続いているか（FR-D-12b）。止まったサイトは試用に入れない。 */
export function hasRecentActivity(
  articleDates: (Date | null | undefined)[],
  now: Date,
): boolean {
  const cutoff = new Date(now.getTime() - UPDATE_WINDOW_DAYS * 86_400_000);
  const recent = articleDates.filter((d) => d && d >= cutoff);
  return recent.length >= MIN_ARTICLES_IN_WINDOW;
}

export interface PrimarySourceSignals {
  /** 本文の文字数の中央値。 */
  medianBodyLength: number;
  /** 本文中の外部リンク数 ÷ 段落数。転載サイトほど高い。 */
  outboundLinkRatio: number;
  /** ページあたりの広告・トラッキングスクリプト数。 */
  adScriptCount: number;
}

export interface QualityVerdict {
  passed: boolean;
  reason?: string;
}

/**
 * 一次情報らしさのヒューリスティック（FR-D-12c）。
 *
 * しきい値は緩めに置いてある。ここで落とすのは「明らかに中身が無い」もの
 * だけで、微妙なものは LLM 分類（4 段目）に渡す。ヒューリスティックを
 * 厳しくすると、短い記事を書く良質な個人ブログを落としてしまう。
 */
export function looksLikePrimarySource(
  signals: PrimarySourceSignals,
): QualityVerdict {
  if (signals.medianBodyLength < 400) {
    return {
      passed: false,
      reason: `median body length ${signals.medianBodyLength} is too short to be an article`,
    };
  }
  if (signals.outboundLinkRatio > 2.5) {
    return {
      passed: false,
      reason: `outbound link ratio ${signals.outboundLinkRatio.toFixed(2)} looks like a link farm`,
    };
  }
  if (signals.adScriptCount > 20) {
    return {
      passed: false,
      reason: `${signals.adScriptCount} ad scripts per page`,
    };
  }
  return { passed: true };
}

export type QualityClass =
  | "primary"
  | "analysis"
  | "syndication"
  | "promotional"
  | "unknown";

/** LLM 分類の結果を受け取って、試用に進めてよいか決める。 */
export function acceptsQualityClass(qualityClass: QualityClass): boolean {
  return qualityClass === "primary" || qualityClass === "analysis";
}

export interface ScreeningInput {
  domain: string;
  articleDates: (Date | null | undefined)[];
  signals?: PrimarySourceSignals;
  now: Date;
}

/**
 * LLM を呼ぶ前の 3 段。落ちたら `reason` を `recDomains.blockedReason` に
 * 残す。再発見時に同じ判定をやり直さないため（FR-D-18）。
 */
export function screenDomain(input: ScreeningInput): QualityVerdict {
  if (isBlockedDomain(input.domain)) {
    return { passed: false, reason: "blocklist" };
  }
  if (!hasRecentActivity(input.articleDates, input.now)) {
    return {
      passed: false,
      reason: `fewer than ${MIN_ARTICLES_IN_WINDOW} articles in the last ${UPDATE_WINDOW_DAYS} days`,
    };
  }
  if (input.signals) {
    const verdict = looksLikePrimarySource(input.signals);
    if (!verdict.passed) {
      return verdict;
    }
  }
  return { passed: true };
}

/**
 * HTML から一次情報らしさの手がかりを取る。crawler が保存した
 * `bookmarkLinks.htmlContent` に対しても、発見時に取ったトップページの
 * HTML に対しても同じものが使える。
 */
export function extractPrimarySourceSignals(
  htmlPages: string[],
): PrimarySourceSignals {
  if (htmlPages.length === 0) {
    return { medianBodyLength: 0, outboundLinkRatio: 0, adScriptCount: 0 };
  }

  const lengths: number[] = [];
  let totalLinks = 0;
  let totalParagraphs = 0;
  let totalAdScripts = 0;

  for (const html of htmlPages) {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    lengths.push(text.length);
    totalLinks += (html.match(/<a\b[^>]*href\s*=\s*["']https?:/gi) ?? [])
      .length;
    totalParagraphs += Math.max(1, (html.match(/<p\b/gi) ?? []).length);
    totalAdScripts += (
      html.match(
        /<script[^>]*(googletagmanager|doubleclick|adsbygoogle|googlesyndication|taboola|outbrain)/gi,
      ) ?? []
    ).length;
  }

  lengths.sort((a, b) => a - b);
  const medianBodyLength = lengths[Math.floor(lengths.length / 2)];

  return {
    medianBodyLength,
    outboundLinkRatio: totalLinks / totalParagraphs,
    adScriptCount: totalAdScripts / htmlPages.length,
  };
}
