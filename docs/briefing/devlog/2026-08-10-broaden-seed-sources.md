# feat(recommender): シード収集元を分野横断に広げる

- 作業日時: 2026-08-10
- 対応内容:
  - シード収集元を 98 → **158 件**（60 件追加、giken-ops #120）
  - `profileIndependent` を 3 → **9 件**
  - 分野の穴（フロントエンド / モバイル / データ基盤 / セキュリティ /
    SRE / 言語ランタイム / デザイン / プロダクト / QA）を埋めた
  - 「登録時に分野を選ばせる」案は**採らなかった**（下記）
- 変更したファイル:
  - `packages/recommender/src/sources/seed.ts`
  - `packages/recommender/src/sources/seed.test.ts`
  - `docs/briefing/requirements.md`（FR-C-08b を追加）
- 確認内容:
  - 追加候補 78 件を実際に取得し、200 かつ item 数 > 0 かつ RSS/Atom の
    ものだけを採用（下の「検証」）
  - `vitest run src/sources/seed.test.ts` 6 件 pass
  - `typecheck` / `lint` / `format` pass
- 残課題:
  - 既存ユーザー（`recSources` が 0 件でない）には追加分が配られない。
    enroll が no-op になるため。giken-ops 側に追い付け手順を残す

## 何が問題だったか

シード 98 件は 2026-08-08 時点のライブラリ 94 ブックマークのタグ集計
（AI エージェント / Kubernetes / LLM / PostgreSQL / RAG …）から逆算して
選ばれていた。1 人で使うぶんには最適だが、**それが全新規ユーザーの初期値に
なる**のは別の話。

実際の内訳:

| 分野 | 件数 |
|---|---|
| 日本の企業技術ブログ | 52 |
| 海外 Engineering Blog | 22 |
| 個人 / 分散システム・低レイヤ | 11 |
| プロダクト / 基盤 | 7 |
| アグリゲータ | 4（うち `profileIndependent` 3） |
| セキュリティ | 2 |
| **フロントエンド / モバイル / データ基盤 / SRE / QA / デザイン** | **0** |

## 「分野を選ばせる」を採らなかった理由

giken-ops #120 の当初案は `SEED_BUNDLES` を作って登録時に 2〜3 個選ばせる形
だった。**これは方針と真逆になるので採らない。**

選ばなかった分野の収集元が入らない ＝ **供給層をユーザーごとに削る**。
FR-C-08 が禁じているのはまさにこれで、ランキングでは取り消せないフィルタを
入り口に置くことになる。しかも登録時点の自己申告なので、**その人の興味が
変わっても届かないまま**になる。

代わりに**共通リストそのものを広げた**。供給は全員に厚く配り、誰に何を出すかは
ランキング層（プロフィール類似 + バンディット）が決める。フロントエンドに
興味がない人には出なくなるだけで、触り始めたら勝手に出るようになる。

## `profileIndependent` が 3 件しかなかったのは潜在バグ

`PROFILE_INDEPENDENT_FLOOR = 0.2` は **取り込み候補数**に対する床で、
ソース数ではない。800 × 0.2 = 160 候補を 3 ソースで賄うのは平常時ぎりぎりで、
どれか 1 つが落ちた日には `min(reserved, independentAvailable)` が静かに縮む。
「視野が狭まるループを断つ」ための床が、いちばん要るときに効かない。

9 件に増やした（HN / GitHub / はてブ IT / Lobsters / InfoQ / The Changelog /
Ars Technica / The Register / Qiita 人気記事）。テストで下限 6 を pin した。

## 検証

候補 78 件を実際に取得して選別した（登録前に必ず取得確認する、という既存の
運用に合わせた）。採用は **HTTP 200 かつ `<item>`/`<entry>` が 1 件以上かつ
RSS/Atom/RDF** の 3 条件すべて。

落ちた 18 件:

| 理由 | 対象 |
|---|---|
| 403 | Dev.to / Reddit r/programming / NCC Group / Real-Time Rendering |
| 404 | ClickHouse / Confluent / Snowflake / Jepsen / Honeycomb / incident.io / Netdata / 2ality / PHP Watch / PyTorch(旧 URL) / Smashing UX / Inigo Quilez / Hacker Newsletter |
| 200 だが item 0 | Swift.org（Atom を返すが本文が空） |

URL を変えて通ったもの: Databricks（`/blog/feed` → `/feed`）、
Materialize（`/blog/rss.xml` → `/rss.xml`）、PyTorch（`/feed.xml` →
`/blog/feed.xml`）、Kotlin（`/feed/` は 403 → `/feed/atom/`）。

Slashdot は 200 で取得できたが、要約の質が低くブリーフィングの材料に
ならないので**意図的に外した**。

## 追加したテスト

`no single host dominates the supply` ── 最多ホストが全体の 15% 未満である
こと。#120 の再発防止で、偏りはランキングでは取り消せないのでここでしか
直せない。同一ホストで書き手が違う Zenn の Publication は意図的に別ソースに
してあるので、上限はその運用が続く程度に緩く取った（現在 zenn.dev が
7/158 = 4.4% で最多）。

## 影響

- collect の HTTP は 1 人あたり 98 → 158 fetch/日。実測で 98 件が約 75 秒
  なので 158 件で 2 分前後。5 人で 10 分、04:30〜05:30 の窓に収まる
- 取り込み上限 800 は変えていないので、**1 ソースあたりの配分が
  800/98 ≒ 8 件から 800/158 ≒ 5 件に薄くなる**。D'Hondt は
  `domainId = NULL` のソースを重み 0.2 で均等に扱うため、これは
  「1 つの情報源を深く」から「多くの情報源を浅く」への意図的な移動

---

# feat(recommender): シードの増分を maintain で既存ユーザーへ配る

- 作業日時: 2026-08-10
- 対応内容: `runMaintain` に `syncSeedSources` を追加
- 変更したファイル:
  - `apps/workers/workers/recommender/maintain.ts`
  - `apps/workers/workers/recommender/maintain.test.ts`（新規）
  - `packages/trpc/routers/recommender.ts`（コメントのみ）
- 確認内容: `selectMissingSeedSources` 4 件 pass

シードを配るのは `enroll` だけで、そちらは「`recSources` が 1 件でもあれば
何もしない」。**一度登録した人には一覧を増やしても永久に届かない。**
今回 60 件足したが、既存の 1 人には 1 件も配られない状態だった。

手順書で毎回流し込む運用にすると、忘れた瞬間に「人によって供給が違う」状態が
できる ── 供給層は全員共通、という前提そのものが崩れる。`maintain`（02:00）で
`name` 突き合わせの差分 insert にした。

既にある行には触らない。とくに `enabled = false`（FR-C-07 の連続失敗で
止めた収集元）はそのまま止めておく ── 復活させると壊れた feed を毎日叩く。
一覧から外したものを消しもしない（供給層は削らない）。

---

# fix(recommender): enroll で埋め込みが二重に走るのを止める

- 作業日時: 2026-08-10
- 対応内容:
  - `runCollect` に `enqueueEmbed` オプションを追加し、`runEnroll` から
    `false` で呼ぶ
  - enroll の埋め込みをメトリクスに積む
- 変更したファイル:
  - `apps/workers/workers/recommender/collect.ts`
  - `apps/workers/workers/recommender/enroll.ts`
  - `apps/workers/workers/recommender/index.ts`
- 確認内容: `typecheck` / `lint` / `format` pass、workers のテスト 19 件 pass

## どうやって見つけたか

本番に 2 人目（使い捨てのテストユーザー）を作って `enroll` を実際に通した。
**PR #22 / #24 はデプロイ済みだが本番で一度も実行されていなかった。**

## ① 埋め込みが二重に走る

```
01:16:31 [embed][955] 793 candidates need an embedding
01:16:31 [embed][955] 57 embeddings came from the shared article cache
01:16:35 [embed][956] 704 candidates need an embedding   ← 4 秒後に別ランナー
01:25:23 [embed][955] embedded 736 (57 shared)
01:25:29 [embed][956] embedded 704 (0 shared)            ← 704 件を二重計算
```

`runCollect` は取り込み後に `RecommenderEmbedQueue` へ埋め込みジョブを投入する。
`runEnroll` は順序保証のために自分でも `runEmbed` を呼ぶ。`runEmbed` は
`embeddingStatus='pending'` を `findMany` で掴むだけで**取り合いの調停を
しない**ので、2 つのランナーが同じ候補を両方処理する。

enroll 全体 10 分 23 秒のうち埋め込みが 9 分弱で、その大半が無駄。Ollama を
2 本で取り合うので待ちも伸びる。

`enqueueEmbed: false` で投入自体を止めた。既定は `true` なので日次 cron の
経路は変わらない。

## ② enroll の埋め込みがメトリクスに出ない

`enroll` は `runEmbed` を直接呼ぶので `embed` タスクのランナーを通らず、
カウンタが一切増えない。**実際 57 件ヒットしていたのに
`karakeep_recommender_embeddings_total{outcome="shared"}` が 0 のままで、
共有キャッシュが効いていないと誤読しかけた。** dispatcher の `enroll` case で
積むようにした。

## 副産物として取れた実測値

| 項目 | 値 |
|---|---|
| `runEnroll` 全体 | **10 分 23 秒**（計画の見積り「10 分弱」とほぼ一致） |
| collect（98 収集元） | **約 75 秒**、2,729 件取得 → 800 件選抜 → 793 件挿入 |
| 埋め込み（793 件） | 約 9 分（うち 704 件は二重計算の無駄） |
| 共有キャッシュのヒット | 埋め込み **57 件**、ダイジェストは初日ゆえ僅少 |
| 収集元の失敗 | 2/98（arXiv が 429、Reddit Engineering が 403） |

collect が 75 秒なら 158 収集元で 2 分前後、5 人で 10 分。04:30〜05:30 の窓に
収まる。**計画で唯一未測定だった前提がこれで埋まった。**

## 残課題

- `Reddit Engineering`（`https://www.reddit.com/r/RedditEng.rss`）が 403。
  Reddit が UA なしの RSS を弾くようになった。連続 5 回で自動無効化される
  ので放置でも壊れないが、代替が無いなら一覧から外すべき
- `runEmbed` は依然として行を掴む調停をしない。今回は投入側を止めて回避したが、
  ほかの経路で 2 つ走れば同じことが起きる
