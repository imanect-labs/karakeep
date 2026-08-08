import { domainOf } from "../url";

/**
 * D2: 高評価記事の外部リンク抽出（FR-D-04）。
 *
 * **最も費用対効果が高い発見チャネル**。自分が保存した記事が繰り返し参照して
 * いるドメインは、ほぼ確実に一次情報源であり、しかも被リンク回数を元記事の
 * 報酬で重み付けできる。karakeep の crawler が既に `htmlContent` を保存して
 * いるので、**追加のクロールなしに今日から掘れる**。
 */

export interface OutboundLinkSource {
  /** 元記事の bookmarkId。発見の証拠として残す。 */
  bookmarkId: string;
  html: string;
  /** その記事のドメイン。自己リンクを除くために使う。 */
  sourceDomain: string | null;
  /** 元記事の報酬。被リンクの重みになる。 */
  reward: number;
}

export interface DiscoveredDomain {
  domain: string;
  weight: number;
  /** 何本の記事からリンクされたか。 */
  referrerCount: number;
  /** 証拠として残す元記事の id（多いときは代表数件）。 */
  evidenceBookmarkIds: string[];
}

/** 証拠として残す元記事の上限。全部持つと JSON が膨らむ。 */
const MAX_EVIDENCE = 5;

/**
 * ナビゲーション・SNS 共有ボタン・CDN など、記事の参照ではないリンクを
 * 落とすためのパターン。ここを外すと、どのサイトからも同じドメインが
 * 大量に「発見」される。
 */
const NON_ARTICLE_HOSTS = [
  "w3.org",
  "schema.org",
  "gravatar.com",
  "gstatic.com",
  "googleapis.com",
  "cloudflare.com",
  "jsdelivr.net",
  "unpkg.com",
  "cdnjs.com",
  "creativecommons.org",
  "gnu.org",
];

function isNonArticleHost(domain: string): boolean {
  return NON_ARTICLE_HOSTS.some(
    (host) => domain === host || domain.endsWith(`.${host}`),
  );
}

/** HTML の `<a href>` から外部ドメインを取り出す。 */
export function extractOutboundDomains(
  html: string,
  sourceDomain: string | null,
): string[] {
  const domains = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    const domain = domainOf(match[1]);
    if (!domain || domain === sourceDomain || isNonArticleHost(domain)) {
      continue;
    }
    // 同じ記事から同じドメインへ何本リンクがあっても 1 票。目次やナビで
    // 同じ先を何度も指すページがあり、そこを数えると票が壊れる。
    domains.add(domain);
  }
  return [...domains];
}

/**
 * 複数の正例記事から、リンク先ドメインを集計する。
 *
 * 重みは「元記事の報酬の合計」。よく読んだ記事がリンクしているドメインほど
 * 強く推される。単なる被リンク数だと、リンクを大量に張る記事 1 本で
 * 順位が決まってしまう。
 */
export function aggregateOutboundDomains(
  sources: OutboundLinkSource[],
): DiscoveredDomain[] {
  const acc = new Map<string, DiscoveredDomain>();

  for (const source of sources) {
    for (const domain of extractOutboundDomains(
      source.html,
      source.sourceDomain,
    )) {
      const entry = acc.get(domain);
      if (entry) {
        entry.weight += Math.max(0, source.reward);
        entry.referrerCount++;
        if (entry.evidenceBookmarkIds.length < MAX_EVIDENCE) {
          entry.evidenceBookmarkIds.push(source.bookmarkId);
        }
      } else {
        acc.set(domain, {
          domain,
          weight: Math.max(0, source.reward),
          referrerCount: 1,
          evidenceBookmarkIds: [source.bookmarkId],
        });
      }
    }
  }

  return [...acc.values()].sort(
    (a, b) => b.weight - a.weight || b.referrerCount - a.referrerCount,
  );
}

/** UI に出す発見経路の説明（FR-U-10）。 */
export function describeOutboundEvidence(discovered: DiscoveredDomain): string {
  return `あなたが保存した記事 ${discovered.referrerCount} 本からリンクされていました`;
}

/**
 * D1: 既存ブックマークのドメイン逆引き（FR-D-03）。
 *
 * 手で保存したことがあるのに購読していないドメインを抽出する。初期の
 * ソースプールがこれで埋まるので、コールドスタートがほぼ消える。
 */
export interface BookmarkDomainSample {
  bookmarkId: string;
  url: string;
  /** お気に入り・ハイライト・読了などがあるか。重みに効く。 */
  isPositive: boolean;
}

export function aggregateBookmarkDomains(
  bookmarks: BookmarkDomainSample[],
): DiscoveredDomain[] {
  const acc = new Map<string, DiscoveredDomain>();

  for (const bookmark of bookmarks) {
    const domain = domainOf(bookmark.url);
    if (!domain || isNonArticleHost(domain)) {
      continue;
    }
    // 保存した事実そのものを 1 票、明示的な正例をさらに 1 票。「保存したが
    // 読まなかった」より「保存して読んだ」ドメインを上に出す。
    const weight = bookmark.isPositive ? 2 : 1;
    const entry = acc.get(domain);
    if (entry) {
      entry.weight += weight;
      entry.referrerCount++;
      if (entry.evidenceBookmarkIds.length < MAX_EVIDENCE) {
        entry.evidenceBookmarkIds.push(bookmark.bookmarkId);
      }
    } else {
      acc.set(domain, {
        domain,
        weight,
        referrerCount: 1,
        evidenceBookmarkIds: [bookmark.bookmarkId],
      });
    }
  }

  return [...acc.values()].sort(
    (a, b) => b.weight - a.weight || b.referrerCount - a.referrerCount,
  );
}

export function describeBookmarkEvidence(discovered: DiscoveredDomain): string {
  return `あなたが ${discovered.referrerCount} 本のブックマークを保存しているサイトです`;
}
