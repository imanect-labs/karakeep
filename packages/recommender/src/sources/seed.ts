import type { ArxivSourceConfig } from "./arxiv";
import type { GithubSourceConfig } from "./github";
import type { HnSourceConfig } from "./hn";
import type { RssSourceConfig } from "./rss";
import type { RecSourceKind } from "./types";

/**
 * 新規ユーザーへ配る共通の収集元（FR-C-08）。
 *
 * **供給層は全員共通にして、人ごとに削らない。** パーソナライズはランキング層が
 * やる。収集元でフィルタするとランキングでは取り消せず、ニッチだが良い情報源が
 * 一度の空振りで永久に消える。個別最適化は `discover` の D1 / D2 / D4 が
 * 各自の外側へ伸ばす層が担う（そちらは `domainId` を持つのでドメインの
 * ライフサイクルが完全に効く）。
 *
 * ここに `domain` を持たせていないのも同じ理由。`recSources.domainId` は NULL で
 * 入れ、`isSourceDue` の「ドメインに紐づかない全体ソースは毎日取る」経路に乗せる。
 * 議席（`RECOMMENDER_DOMAIN_SEATS`）も試用枠も消費しない。記事の**掲載元**
 * ドメインは `collect` の `ensureDomains` が `discovered` として作り、バンディットが
 * 独立に育てる ── 供給（共通）と評価（個人）の分離が既存の設計。
 *
 * **この一覧は 2026-08-08〜09 に手作業で本番へ投入したものと同じ。**
 * すべて登録前に実際に取得して 200 と item 数を確認済み。取得できなかったもの
 * （はてブのサブカテゴリは `?category=` が無視されて親と完全一致、
 * Uber / LinkedIn / Box は feed 無し、Quora は robots で拒否、Yelp は 403）は
 * 外してある。経緯は giken-ops の `docs/karakeep-recommender-sources.md`。
 *
 * ⚠️ `zenn.dev` / `qiita.com` は `BLOCKED_SUFFIXES`（`domain/quality.ts`）に
 * 入っているが、`isBlockedDomain` は `screenDomain` のドメイン発見経路にしか
 * 効かない。ドメイン単位のバンディットが機能しない（書き手ごとに質が違う）から
 * 議席を与えないだけで、記事を候補に入れるのは妨げていない。ここに Zenn 系が
 * あるのは意図的。
 */

export interface SeedSource {
  /** `recSources.name`。**冪等性のキーでもある**ので、後から変えない。 */
  name: string;
  kind: RecSourceKind;
  config:
    | RssSourceConfig
    | HnSourceConfig
    | ArxivSourceConfig
    | GithubSourceConfig;
  /**
   * プロフィールに寄らない供給源か（`PROFILE_INDEPENDENT_FLOOR = 0.2`）。
   * 「好きなものばかり出てきて視野が狭まる」ループを断つための床で、
   * `random` アームもここから引く。分野横断のアグリゲータにだけ立てる。
   */
  profileIndependent?: boolean;
}

export const SEED_SOURCES: readonly SeedSource[] = [
  // --- アグリゲータ -------------------------------------------------------
  // HN と GitHub はドメインの**標本**としても働く（D4 / FR-D-06）。HN 上位に
  // 上がるドメインの分布は良質な独立ブログの標本として優秀で、discovery 側が
  // 同じレスポンスからドメインを抽出する。
  {
    name: "Hacker News front page",
    kind: "hn",
    config: { mode: "front_page" },
    profileIndependent: true,
  },
  {
    name: "GitHub new repos",
    kind: "github",
    config: { createdWithinDays: 7, minStars: 50 },
    profileIndependent: true,
  },
  {
    name: "はてブ IT",
    kind: "rss",
    config: { feedUrl: "https://b.hatena.ne.jp/hotentry/it.rss" },
    profileIndependent: true,
  },
  {
    name: "arXiv cs.IR/LG/CL/DC",
    kind: "arxiv",
    config: { categories: ["cs.IR", "cs.LG", "cs.CL", "cs.DC"] },
  },

  // --- 個人 / 深い技術 ----------------------------------------------------
  {
    name: "Simon Willison",
    kind: "rss",
    config: { feedUrl: "https://simonwillison.net/atom/everything/" },
  },
  {
    name: "Julia Evans",
    kind: "rss",
    config: { feedUrl: "https://jvns.ca/atom.xml" },
  },
  {
    name: "Dan Luu",
    kind: "rss",
    config: { feedUrl: "https://danluu.com/atom.xml" },
  },
  {
    name: "Marc Brooker",
    kind: "rss",
    config: { feedUrl: "https://brooker.co.za/blog/rss.xml" },
  },
  {
    name: "Metadata (Murat)",
    kind: "rss",
    config: {
      feedUrl: "https://muratbuffalo.blogspot.com/feeds/posts/default",
    },
  },
  {
    name: "All Things Distributed",
    kind: "rss",
    config: { feedUrl: "https://www.allthingsdistributed.com/atom.xml" },
  },
  {
    name: "John Regehr",
    kind: "rss",
    config: { feedUrl: "https://blog.regehr.org/feed" },
  },
  {
    name: "Eli Bendersky",
    kind: "rss",
    config: { feedUrl: "https://eli.thegreenplace.net/feeds/all.atom.xml" },
  },
  {
    name: "Chips and Cheese",
    kind: "rss",
    config: { feedUrl: "https://chipsandcheese.com/feed/" },
  },
  {
    name: "LWN.net",
    kind: "rss",
    config: { feedUrl: "https://lwn.net/headlines/newrss" },
  },
  {
    name: "High Scalability",
    kind: "rss",
    config: { feedUrl: "https://highscalability.com/rss/" },
  },

  // --- セキュリティ -------------------------------------------------------
  {
    name: "Trail of Bits",
    kind: "rss",
    config: { feedUrl: "https://blog.trailofbits.com/feed/" },
  },
  {
    name: "Project Zero",
    kind: "rss",
    config: {
      feedUrl: "https://googleprojectzero.blogspot.com/feeds/posts/default",
    },
  },

  // --- プロダクト / 基盤 --------------------------------------------------
  {
    name: "Cloudflare Blog",
    kind: "rss",
    config: { feedUrl: "https://blog.cloudflare.com/rss/" },
  },
  {
    name: "Kubernetes Blog",
    kind: "rss",
    config: { feedUrl: "https://kubernetes.io/feed.xml" },
  },
  {
    name: "DuckDB Blog",
    kind: "rss",
    config: { feedUrl: "https://duckdb.org/feed.xml" },
  },
  {
    name: "Rust Blog",
    kind: "rss",
    config: { feedUrl: "https://blog.rust-lang.org/feed.xml" },
  },
  {
    name: "PostgreSQL News",
    kind: "rss",
    config: { feedUrl: "https://www.postgresql.org/news.rss" },
  },
  {
    name: "PlanetScale Blog",
    kind: "rss",
    config: { feedUrl: "https://planetscale.com/blog/rss.xml" },
  },
  {
    name: "Zenn",
    kind: "rss",
    config: { feedUrl: "https://zenn.dev/feed" },
  },

  // --- 海外 Engineering Blog ---------------------------------------------
  {
    name: "AWS Architecture Blog",
    kind: "rss",
    config: { feedUrl: "https://aws.amazon.com/blogs/architecture/feed/" },
  },
  {
    name: "Google Research",
    kind: "rss",
    config: { feedUrl: "https://research.google/blog/rss/" },
  },
  {
    name: "Meta Engineering",
    kind: "rss",
    config: { feedUrl: "https://engineering.fb.com/feed/" },
  },
  {
    name: "Netflix Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://netflixtechblog.com/feed" },
  },
  {
    name: "GitHub Engineering",
    kind: "rss",
    config: { feedUrl: "https://github.blog/feed/" },
  },
  {
    name: "Stripe Engineering",
    kind: "rss",
    config: { feedUrl: "https://stripe.dev/blog/feed" },
  },
  {
    name: "Jane Street Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://blog.janestreet.com/feed.xml" },
  },
  {
    name: "Dropbox Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://dropbox.tech/feed" },
  },
  {
    name: "Slack Engineering",
    kind: "rss",
    config: { feedUrl: "https://slack.engineering/feed" },
  },
  {
    name: "Airbnb Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://medium.com/feed/airbnb-engineering" },
  },
  {
    name: "Pinterest Engineering",
    kind: "rss",
    config: { feedUrl: "https://medium.com/feed/pinterest-engineering" },
  },
  {
    name: "Groupon Engineering",
    kind: "rss",
    config: { feedUrl: "https://medium.com/feed/groupon-eng" },
  },
  {
    name: "Atlassian Engineering",
    kind: "rss",
    config: { feedUrl: "https://www.atlassian.com/blog/comments/feed" },
  },
  {
    name: "Etsy Code as Craft",
    kind: "rss",
    config: { feedUrl: "https://www.etsy.com/codeascraft/rss" },
  },
  {
    name: "HubSpot Engineering",
    kind: "rss",
    config: { feedUrl: "https://product.hubspot.com/blog/rss.xml" },
  },
  {
    name: "Heroku Engineering",
    kind: "rss",
    config: { feedUrl: "https://www.heroku.com/feed/" },
  },
  {
    name: "Salesforce Engineering",
    kind: "rss",
    config: { feedUrl: "https://engineering.salesforce.com/feed/" },
  },
  {
    name: "Engineering at Microsoft",
    kind: "rss",
    config: {
      feedUrl: "https://devblogs.microsoft.com/engineering-at-microsoft/feed",
    },
  },
  {
    name: "Python at Microsoft",
    kind: "rss",
    config: { feedUrl: "https://devblogs.microsoft.com/python/feed" },
  },
  {
    name: "Reddit Engineering",
    kind: "rss",
    config: { feedUrl: "https://www.reddit.com/r/RedditEng.rss" },
  },
  {
    name: "eBay Innovation",
    kind: "rss",
    config: { feedUrl: "https://www.ebayinc.com/stories/news/rss/" },
  },
  {
    name: "Yahoo Engineering",
    kind: "rss",
    config: { feedUrl: "https://yahooeng.tumblr.com/rss" },
  },

  // --- 日本の企業技術ブログ ------------------------------------------------
  {
    name: "Cybozu Inside Out",
    kind: "rss",
    config: { feedUrl: "https://blog.cybozu.io/feed" },
  },
  {
    name: "Mercari Engineering",
    kind: "rss",
    config: { feedUrl: "https://engineering.mercari.com/blog/feed.xml" },
  },
  {
    name: "ZOZO TECH BLOG",
    kind: "rss",
    config: { feedUrl: "https://techblog.zozo.com/feed" },
  },
  {
    name: "LINEヤフー Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://techblog.lycorp.co.jp/ja/feed/index.xml" },
  },
  {
    name: "CyberAgent Developers Blog",
    kind: "rss",
    config: { feedUrl: "https://developers.cyberagent.co.jp/blog/feed/" },
  },
  {
    name: "DeNA Engineering",
    kind: "rss",
    config: { feedUrl: "https://engineering.dena.com/blog/index.xml" },
  },
  {
    name: "LayerX エンジニアブログ",
    kind: "rss",
    config: { feedUrl: "https://tech.layerx.co.jp/feed" },
  },
  {
    name: "SmartHR Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://tech.smarthr.jp/feed" },
  },
  {
    name: "IIJ Engineers Blog",
    kind: "rss",
    config: { feedUrl: "https://eng-blog.iij.ad.jp/feed" },
  },
  {
    name: "エムスリーテックブログ",
    kind: "rss",
    config: { feedUrl: "https://www.m3tech.blog/feed" },
  },
  {
    name: "さくらのナレッジ",
    kind: "rss",
    config: { feedUrl: "https://knowledge.sakura.ad.jp/feed/" },
  },
  {
    name: "Hatena Developer Blog",
    kind: "rss",
    config: { feedUrl: "https://developer.hatenastaff.com/feed" },
  },
  {
    name: "Money Forward Developers",
    kind: "rss",
    config: { feedUrl: "https://moneyforward-dev.jp/feed" },
  },
  {
    name: "freee Developers Hub",
    kind: "rss",
    config: { feedUrl: "https://developers.freee.co.jp/feed" },
  },
  {
    name: "Sansan Builders Box",
    kind: "rss",
    config: { feedUrl: "https://buildersbox.corp-sansan.com/feed" },
  },
  {
    name: "PLAID Engineer Blog",
    kind: "rss",
    config: { feedUrl: "https://tech.plaid.co.jp/rss.xml" },
  },
  {
    name: "MonotaRO Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://tech-blog.monotaro.com/feed" },
  },
  {
    name: "Tabelog Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://tech-blog.tabelog.com/feed" },
  },
  {
    name: "Timee Product Team Blog",
    kind: "rss",
    config: { feedUrl: "https://tech.timee.co.jp/feed" },
  },
  {
    name: "KINTO Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://blog.kinto-technologies.com/rss/feed.xml" },
  },
  {
    name: "CARTA TECH BLOG",
    kind: "rss",
    config: { feedUrl: "https://techblog.cartaholdings.co.jp/feed" },
  },
  {
    name: "CADDi Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://caddi.tech/feed" },
  },
  {
    name: "BASEプロダクトチームブログ",
    kind: "rss",
    config: { feedUrl: "https://devblog.thebase.in/feed" },
  },
  {
    name: "Visional Engineering Blog",
    kind: "rss",
    config: { feedUrl: "https://engineering.visional.inc/blog/index.xml" },
  },
  {
    name: "Findy Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://tech.findy.co.jp/feed" },
  },
  {
    name: "KAKEHASHI Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://kakehashi-dev.hatenablog.com/feed" },
  },
  {
    name: "LegalOn Technologies",
    kind: "rss",
    config: { feedUrl: "https://tech.legalforce.co.jp/feed" },
  },
  {
    name: "MEDLEY Developer Portal",
    kind: "rss",
    config: { feedUrl: "https://developer.medley.jp/rss.xml" },
  },
  {
    name: "RevComm Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://tech.revcomm.co.jp/feed" },
  },
  {
    name: "Speee DEVELOPER BLOG",
    kind: "rss",
    config: { feedUrl: "https://tech.speee.jp/feed" },
  },
  {
    name: "RAKUS Developers Blog",
    kind: "rss",
    config: { feedUrl: "https://tech-blog.rakus.co.jp/feed" },
  },
  {
    name: "CrowdWorks エンジニアブログ",
    kind: "rss",
    config: { feedUrl: "https://engineer.crowdworks.jp/feed" },
  },
  {
    name: "Yappli Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://tech.yappli.io/feed" },
  },
  {
    name: "PR TIMES 開発者ブログ",
    kind: "rss",
    config: { feedUrl: "https://developers.prtimes.com/feed/" },
  },
  {
    name: "スタディサプリ Product Team Blog",
    kind: "rss",
    config: { feedUrl: "https://blog.studysapuri.jp/feed" },
  },
  {
    name: "NIFTY engineering",
    kind: "rss",
    config: { feedUrl: "https://engineering.nifty.co.jp/feed" },
  },
  {
    name: "GMO Developers",
    kind: "rss",
    config: { feedUrl: "https://developers.gmo.jp/feed" },
  },
  {
    name: "NRIネットコム Blog",
    kind: "rss",
    config: { feedUrl: "https://tech.nri-net.com/feed" },
  },
  {
    name: "G-gen Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://blog.g-gen.co.jp/feed" },
  },
  {
    name: "サーバーワークス エンジニアブログ",
    kind: "rss",
    config: { feedUrl: "https://blog.serverworks.co.jp/feed" },
  },
  {
    name: "CloudNative BLOGs",
    kind: "rss",
    config: { feedUrl: "https://blog.cloudnative.co.jp/feed.xml" },
  },
  {
    name: "Future Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://future-architect.github.io/atom.xml" },
  },
  {
    name: "HERP TechHub",
    kind: "rss",
    config: { feedUrl: "https://tech-hub.herp.co.jp/feed.xml" },
  },
  {
    name: "富士通研究所 fltech",
    kind: "rss",
    config: { feedUrl: "https://blog.fltech.dev/feed" },
  },
  {
    name: "ABEJA Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://tech-blog.abeja.asia/feed" },
  },
  {
    name: "ACES エンジニアブログ",
    kind: "rss",
    config: { feedUrl: "https://tech.acesinc.co.jp/feed" },
  },

  // Zenn の Publication。ドメインは zenn.dev だが書き手が違うので別ソース。
  {
    name: "Finatext Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://zenn.dev/p/finatext/feed" },
  },
  {
    name: "Fusic Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://zenn.dev/p/fusic/feed" },
  },
  {
    name: "Loglass Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://zenn.dev/p/loglass/feed" },
  },
  {
    name: "PKSHA Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://zenn.dev/p/pksha/feed" },
  },
  {
    name: "Turing Tech Blog",
    kind: "rss",
    config: { feedUrl: "https://zenn.dev/p/turing_motors/feed" },
  },
  {
    name: "Ubie テックブログ",
    kind: "rss",
    config: { feedUrl: "https://zenn.dev/p/ubie_dev/feed" },
  },
];
