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
 * **全件、登録前に実際に取得して 200 と item 数を確認してある。** 骨格の 98 件は
 * 2026-08-08〜09 に手作業で本番へ投入したものと同一（はてブのサブカテゴリは
 * `?category=` が無視されて親と完全一致、Uber / LinkedIn / Box は feed 無し、
 * Quora は robots で拒否、Yelp は 403 だったので外してある）。
 * 2026-08-10 に分野の穴を埋める 60 件を足して 158 件（下の #120 のブロック）。
 * 経緯は giken-ops の `docs/karakeep-recommender-sources.md`。
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
  // 分野を問わない供給の厚み。`PROFILE_INDEPENDENT_FLOOR = 0.2` は**候補数**に
  // 対する床なので、独立ソースが 3 件しかないと 800 件 × 20% = 160 件を賄えず
  // 床が満たせないまま静かに縮む。ここを厚くしておくと `random` アームの引きも
  // 広がる。
  {
    name: "Lobsters",
    kind: "rss",
    config: { feedUrl: "https://lobste.rs/rss" },
    profileIndependent: true,
  },
  {
    name: "InfoQ",
    kind: "rss",
    config: { feedUrl: "https://feed.infoq.com/" },
    profileIndependent: true,
  },
  {
    name: "The Changelog",
    kind: "rss",
    config: { feedUrl: "https://changelog.com/feed" },
    profileIndependent: true,
  },
  {
    name: "Ars Technica",
    kind: "rss",
    config: {
      feedUrl: "https://feeds.arstechnica.com/arstechnica/technology-lab",
    },
    profileIndependent: true,
  },
  {
    name: "The Register",
    kind: "rss",
    config: { feedUrl: "https://www.theregister.com/headlines.atom" },
    profileIndependent: true,
  },
  // 日本語側の分野横断。Zenn は下の「プロダクト / 基盤」にあるが、あちらは
  // 全記事フィードで profileIndependent ではない（質のばらつきが大きい）。
  // Qiita の人気記事は選抜が入るぶん床の材料として使える。
  {
    name: "Qiita 人気記事",
    kind: "rss",
    config: { feedUrl: "https://qiita.com/popular-items/feed" },
    profileIndependent: true,
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
  {
    name: "Google Security Blog",
    kind: "rss",
    config: { feedUrl: "https://security.googleblog.com/feeds/posts/default" },
  },
  {
    name: "PortSwigger Research",
    kind: "rss",
    config: { feedUrl: "https://portswigger.net/research/rss" },
  },
  {
    name: "GitHub Security Lab",
    kind: "rss",
    config: { feedUrl: "https://github.blog/tag/github-security-lab/feed/" },
  },
  {
    name: "Snyk Blog",
    kind: "rss",
    config: { feedUrl: "https://snyk.io/blog/feed/" },
  },
  {
    name: "Krebs on Security",
    kind: "rss",
    config: { feedUrl: "https://krebsonsecurity.com/feed/" },
  },
  {
    name: "Schneier on Security",
    kind: "rss",
    config: { feedUrl: "https://www.schneier.com/feed/atom/" },
  },
  {
    name: "JPCERT/CC",
    kind: "rss",
    config: { feedUrl: "https://blogs.jpcert.or.jp/ja/atom.xml" },
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

  // =========================================================================
  // ここから下は「分野の穴を埋める」ための追加（giken-ops #120）。
  //
  // 上の一覧は 2026-08-08 時点のライブラリ 94 ブックマークのタグ集計
  // （AI エージェント / Kubernetes / LLM / PostgreSQL / RAG …）から逆算して
  // 選ばれていて、**AI・分散システム・インフラが濃く、フロントエンド・
  // モバイル・データ基盤・セキュリティ・QA が事実上ゼロ**だった。
  // 1 人で使うぶんには最適だが、それが全新規ユーザーの初期値になるのは別の話。
  //
  // **解き方として「登録時に分野を選ばせる」は採らなかった。** 選ばなかった
  // 分野の収集元が入らない ＝ 供給層をユーザーごとに削ることになり、この
  // ファイル冒頭の方針と真逆になる。ランキングで取り消せないフィルタを
  // 入り口に置くと、興味が変わっても届かない。
  //
  // 代わりに**共通リストそのものを分野横断へ広げる**。供給は全員に厚く配り、
  // 誰に何を出すかはランキング層（プロフィール類似 + バンディット）が決める。
  // 「フロントエンドの記事が要らない人」には出なくなるだけで、**将来その人が
  // フロントエンドを触り始めたら勝手に出るようになる**のが、この形の利点。
  //
  // 追加分も全件、登録前に実際に取得して 200 と item 数を確認済み。落ちたもの:
  //   403 … Dev.to / Reddit r/programming / NCC Group / Real-Time Rendering
  //   404 … ClickHouse / Confluent / Snowflake / Jepsen / Honeycomb /
  //          incident.io / Netdata / 2ality / PHP Watch
  //   200 だが item 0 … Swift.org（Atom を返すが本文が空）
  // =========================================================================

  // --- フロントエンド / Web プラットフォーム --------------------------------
  // ブラウザベンダの一次情報を軸にする。仕様と実装の話は寿命が長く、
  // フレームワークの流行より腐りにくい。
  {
    name: "web.dev",
    kind: "rss",
    config: { feedUrl: "https://web.dev/static/blog/feed.xml" },
  },
  {
    name: "Chrome for Developers",
    kind: "rss",
    config: { feedUrl: "https://developer.chrome.com/static/blog/feed.xml" },
  },
  {
    name: "WebKit Blog",
    kind: "rss",
    config: { feedUrl: "https://webkit.org/feed/" },
  },
  {
    name: "Mozilla Hacks",
    kind: "rss",
    config: { feedUrl: "https://hacks.mozilla.org/feed/" },
  },
  {
    name: "V8 Blog",
    kind: "rss",
    config: { feedUrl: "https://v8.dev/blog.atom" },
  },
  {
    name: "React Blog",
    kind: "rss",
    config: { feedUrl: "https://react.dev/rss.xml" },
  },
  {
    name: "Vue.js Blog",
    kind: "rss",
    config: { feedUrl: "https://blog.vuejs.org/feed.rss" },
  },
  {
    name: "Svelte Blog",
    kind: "rss",
    config: { feedUrl: "https://svelte.dev/blog/rss.xml" },
  },
  {
    name: "Next.js Blog",
    kind: "rss",
    config: { feedUrl: "https://nextjs.org/feed.xml" },
  },
  {
    name: "Astro Blog",
    kind: "rss",
    config: { feedUrl: "https://astro.build/rss.xml" },
  },
  {
    name: "Deno Blog",
    kind: "rss",
    config: { feedUrl: "https://deno.com/feed" },
  },
  {
    name: "Bun Blog",
    kind: "rss",
    config: { feedUrl: "https://bun.sh/rss.xml" },
  },
  {
    name: "TypeScript DevBlog",
    kind: "rss",
    config: { feedUrl: "https://devblogs.microsoft.com/typescript/feed/" },
  },
  {
    name: "CSS-Tricks",
    kind: "rss",
    config: { feedUrl: "https://css-tricks.com/feed/" },
  },
  {
    name: "Smashing Magazine",
    kind: "rss",
    config: { feedUrl: "https://www.smashingmagazine.com/feed/" },
  },
  {
    name: "A List Apart",
    kind: "rss",
    config: { feedUrl: "https://alistapart.com/main/feed/" },
  },
  {
    name: "Josh Comeau",
    kind: "rss",
    config: { feedUrl: "https://www.joshwcomeau.com/rss.xml" },
  },
  {
    name: "Kent C. Dodds",
    kind: "rss",
    config: { feedUrl: "https://kentcdodds.com/blog/rss.xml" },
  },

  // --- モバイル -------------------------------------------------------------
  {
    name: "Android Developers Blog",
    kind: "rss",
    config: {
      feedUrl: "https://android-developers.googleblog.com/feeds/posts/default",
    },
  },
  {
    name: "Kotlin Blog",
    kind: "rss",
    // `/feed/` は 403。Atom 側は通る。
    config: { feedUrl: "https://blog.jetbrains.com/kotlin/feed/atom/" },
  },
  {
    name: "Swift by Sundell",
    kind: "rss",
    config: { feedUrl: "https://swiftbysundell.com/rss" },
  },
  {
    name: "NSHipster",
    kind: "rss",
    config: { feedUrl: "https://nshipster.com/feed.xml" },
  },
  {
    name: "objc.io",
    kind: "rss",
    config: { feedUrl: "https://www.objc.io/feed.xml" },
  },
  {
    name: "iOS Dev Weekly",
    kind: "rss",
    config: { feedUrl: "https://iosdevweekly.com/issues.rss" },
  },
  {
    name: "Flutter",
    kind: "rss",
    config: { feedUrl: "https://medium.com/feed/flutter" },
  },

  // --- 言語 / ランタイム ----------------------------------------------------
  // Rust は上の「プロダクト / 基盤」に既にある。
  {
    name: "Go Blog",
    kind: "rss",
    config: { feedUrl: "https://go.dev/blog/feed.atom" },
  },
  {
    name: "Python Insider",
    kind: "rss",
    config: { feedUrl: "https://blog.python.org/feeds/posts/default" },
  },
  {
    name: "Ruby News",
    kind: "rss",
    config: { feedUrl: "https://www.ruby-lang.org/en/feeds/news.rss" },
  },
  {
    name: "Inside Java",
    kind: "rss",
    config: { feedUrl: "https://inside.java/feed.xml" },
  },
  {
    name: ".NET Blog",
    kind: "rss",
    config: { feedUrl: "https://devblogs.microsoft.com/dotnet/feed/" },
  },
  {
    name: "Elixir Blog",
    kind: "rss",
    config: { feedUrl: "https://elixir-lang.org/atom.xml" },
  },
  {
    name: "Zig News",
    kind: "rss",
    config: { feedUrl: "https://ziglang.org/news/index.xml" },
  },

  // --- データ基盤 -----------------------------------------------------------
  // DuckDB / PostgreSQL / PlanetScale は上にあるが、いずれも DB 単体の話。
  // パイプライン・ウェアハウス側がまるごと無かった。
  {
    name: "Databricks Blog",
    kind: "rss",
    config: { feedUrl: "https://www.databricks.com/feed" },
  },
  {
    name: "dbt Labs Blog",
    kind: "rss",
    config: { feedUrl: "https://www.getdbt.com/blog/rss.xml" },
  },
  {
    name: "Materialize Blog",
    kind: "rss",
    config: { feedUrl: "https://materialize.com/rss.xml" },
  },
  {
    name: "Data Engineering Weekly",
    kind: "rss",
    config: { feedUrl: "https://www.dataengineeringweekly.com/feed" },
  },

  // --- SRE / 可観測性 -------------------------------------------------------
  {
    name: "Grafana Blog",
    kind: "rss",
    config: { feedUrl: "https://grafana.com/blog/index.xml" },
  },
  {
    name: "charity.wtf",
    kind: "rss",
    config: { feedUrl: "https://charity.wtf/feed/" },
  },

  // --- 機械学習 / AI --------------------------------------------------------
  // arXiv と Google Research はあったが、実装寄り・解説寄りの一次情報が薄い。
  {
    name: "Hugging Face Blog",
    kind: "rss",
    config: { feedUrl: "https://huggingface.co/blog/feed.xml" },
  },
  {
    name: "PyTorch Blog",
    kind: "rss",
    config: { feedUrl: "https://pytorch.org/blog/feed.xml" },
  },
  {
    name: "Google DeepMind Blog",
    kind: "rss",
    config: { feedUrl: "https://deepmind.google/blog/rss.xml" },
  },
  {
    name: "BAIR Blog",
    kind: "rss",
    config: { feedUrl: "https://bair.berkeley.edu/blog/feed.xml" },
  },
  {
    name: "Lil'Log",
    kind: "rss",
    config: { feedUrl: "https://lilianweng.github.io/index.xml" },
  },

  // --- デザイン / プロダクト / QA -------------------------------------------
  // エンジニアだけが使うものではないので、コードを書かない話も供給する。
  {
    name: "Nielsen Norman Group",
    kind: "rss",
    config: { feedUrl: "https://www.nngroup.com/feed/rss/" },
  },
  {
    name: "Lenny's Newsletter",
    kind: "rss",
    config: { feedUrl: "https://www.lennysnewsletter.com/feed" },
  },
  {
    name: "SVPG",
    kind: "rss",
    config: { feedUrl: "https://www.svpg.com/articles/rss" },
  },
  {
    name: "Google Testing Blog",
    kind: "rss",
    config: { feedUrl: "https://testing.googleblog.com/feeds/posts/default" },
  },
];
