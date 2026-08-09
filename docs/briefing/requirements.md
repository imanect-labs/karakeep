# Briefing Recommender — 要件定義

- 対象リポジトリ: `imanect-labs/karakeep`（fork）
- 稼働環境: giken-cluster（Proxmox + Talos K8s）上の karakeep インスタンス
- 版: 初版

## 1. 背景と目的

### 背景

毎朝 LLM に morning briefing を生成させている。興味トピックを列挙して渡しているが、次の 2 点で機能していない。

- 提示される記事の大半が実際には読まれない（明示した興味 ≠ 実際の関心）
- リストに書いていない興味は構造的に浮上しない（暗黙知が表面化しない）

### 目的

1. 実際の行動ログから学習し、読まれる記事の割合を上げる
2. 本人が言語化していない興味を、探索枠を通じて発見・可視化する
3. **候補プールを供給するソースそのものを広げる**（購読済みサイトの中だけで探索しても母集団は広がらない）
4. LLM に渡すコンテキストを、履歴の全量ではなく圧縮したプロフィールと上位候補に限定する

### 成功の定義

| 指標 | 現状（推定） | 3 か月後の目標 |
|---|---|---|
| クリック率 | — | 25% 以上 |
| 保存率（karakeep へのブックマーク化） | — | 8% 以上 |
| **新規ドメイン由来の保存率** | — | **20% 以上** |
| **保存記事の上位 5 ドメイン集中度** | — | **単調増加していないこと** |
| 新規に購読へ昇格したドメイン | — | 月 2 件以上 |
| 探索枠から生まれた新規選好クラスタ | — | 月 1 件以上 |
| Briefing 生成の所要時間 | — | 30 秒以内（LLM 生成を除き 5 秒以内） |

**クリック率・保存率の分母は「提示数」ではなく「`observed` な Briefing の `examined` な impression 数」とする**（§6.3 参照）。提示数を分母にすると、忙しくて Briefing を見なかった週に指標が下がったように見え、モデルの良し悪しと区別できなくなる。

「新規ドメイン由来」とは、**6 か月前の時点で購読も保存もしていなかったドメイン**を指す。推薦精度が上がってもソースが広がっていなければ目的 3 を達成していないため、これを主要 KPI に置く。ドメイン集中度は探索が死んでいないかの逆指標であり、単調増加は警報とする。

初期はベースラインが存在しないため、段階的有効化の前半 2 週間を `trial` 0% / `random` 15% で運用し、`random` 枠の値をベースラインとする（ROADMAP の「段階的な有効化」を参照）。

## 2. スコープ

### 対象

- 単一ユーザー（自宅サーバー 1 人運用）
- **新規ソース（ドメイン）の発見・審査・試用・昇格**
- 記事候補の収集・重複排除・埋め込み
- 推薦スコアリングと探索制御（記事レベルとソースレベルの 2 階層）
- karakeep 内の Briefing ページ（1 ページ追加）
- フィードバック収集とログ蓄積
- プロフィール更新とモデル再学習
- morning briefing エージェント向けの MCP Tool

### 対象外

| 項目 | 理由 |
|---|---|
| マルチユーザー対応 | 1 人運用。テーブルには `userId` を持たせるが、モデルはユーザー横断学習をしない |
| LinUCB / Neural Bandit / 本格的な強化学習 | 年間 impression 約 7,300・正例約 1,000 件という規模でパラメータ数を増やすと分散が支配的になる |
| LightGBM 等の外部 ML ランタイム | TS モノレポに Python を持ち込むコストに見合わない。特徴量 20 次元ならロジスティック回帰で十分 |
| 収集プロンプトの自動最適化 | 推薦モデルと同時に自動更新すると原因分析が不能になる。Phase 5 で手動 A/B から開始する |
| 記事本文のフルテキスト保存（候補段階） | ストレージと著作権の観点。保存はブックマーク化した時点で既存の crawler に任せる |
| 独立した推薦マイクロサービス | karakeep 内実装のほうが既存資産を再利用でき、コールドスタートを解消できる |
| モバイルアプリ対応 | Phase 6 以降。Web レスポンシブで代替 |

## 3. 用語

| 用語 | 定義 |
|---|---|
| 候補 (candidate) | 収集されたが、まだブックマーク化されていない記事。`recCandidates` に格納 |
| 提示 (impression) | 候補が Briefing に表示された事実。表示されなくても選定対象になったものは `shown=false` で記録 |
| Briefing | 1 日 1 スロット分の提示セット |
| 枠 (arm) | `exploit` / `adjacent` / `uncertain` / `random` の 4 種 |
| propensity | その候補がその枠でその順位に選ばれた確率。オフポリシー評価に使う |
| クラスタ | 候補埋め込みを k-means で分割した意味的グループ。潜在トピックの単位 |
| 遅延報酬 | 保存後の読了率・ハイライト・お気に入り化など、提示から時間を空けて確定する報酬 |

## 4. 機能要件

### 4.0 ソース発見（FR-D）

購読済みソースの集合は、自分で選んだ時点で明示的な興味の写像になっている。その中での探索では候補の母集団が広がらないため、ドメインそのものを探索対象にする。

| ID | 要件 |
|---|---|
| FR-D-01 | 発見されたドメインを `recDomains` に一意に登録し、ライフサイクル（`discovered` → `screened` → `trial` → `subscribed` / `dormant` / `rejected` / `retired`）で管理する |
| FR-D-02 | 発見の証拠を `recDomainDiscoveries` に残す。チャネル種別・発見元（元記事の ID や検索クエリ）・発見日時・重みを記録し、同一ドメインの複数チャネルからの発見を累積できる |
| FR-D-03 | **D1: 既存ブックマークのドメイン逆引き** — 手で保存したことがあるが購読していないドメインを抽出する。初回の一括処理と、以後のブックマーク作成時の増分処理の両方に対応する |
| FR-D-04 | **D2: 外部リンク抽出** — 正例となったブックマークの `bookmarkLinks.htmlContent` から外部リンクのドメインを抽出する。被リンク回数は元記事の報酬で重み付けする。追加のクロールは行わない |
| FR-D-05 | **D3: フィード自動発見** — 発見済みドメインのトップページから `<link rel="alternate" type="application/rss+xml">` を解決する。見つからない場合は `/feed`, `/rss.xml`, `/atom.xml`, `/index.xml` を順に試す。すべて失敗したドメインはスクレイプ対象として `screened` に上げてよい |
| FR-D-06 | **D4: アグリゲータのドメインサンプリング** — Hacker News / Lobsters の上位エントリを、記事の供給源ではなく**ドメインの標本**として扱う。抽出したドメインのうち未知のものを `discovered` に入れる |
| FR-D-07 | **D5: 著者・publisher 追跡**（Phase 3）— 正例記事の `author` / `publisher` から、その書き手の個人サイト・他媒体を発見する |
| FR-D-08 | **D6: blogroll 抽出**（Phase 3）— 昇格済みドメインのリンク集ページを LLM で抽出し、そこに載っているドメインを発見する。ドメインあたり 1 回のみ実行する |
| FR-D-09 | **D7: small-web 検索**（Phase 3）— 潜在クラスタのラベルをクエリにして、独立サイト特化の検索（Marginalia / searchmysite 等）を週次で実行する |
| FR-D-10 | **D10: ドメイン埋め込みの近傍**（Phase 3）— ドメインごとの記事埋め込み重心を持ち、選好ドメインに近い未購読ドメインを探す |
| FR-D-11 | **D8: SNS の共有リンク**（Phase 4）、**D9: LLM 検索エージェント**（Phase 5）を追加チャネルとして実装する |
| FR-D-12 | 品質ゲート — `discovered` から `screened` に上げる際、(a) ブロックリスト、(b) 直近 90 日に 3 記事以上の更新、(c) 一次情報らしさのヒューリスティック（本文文字数・外部リンク比率・広告スクリプト数）、(d) LLM によるドメイン分類（一次情報 / 分析 / 転載 / 宣伝）を通す。LLM 判定は**ドメインあたり 1 回のみ**とし結果を永続化する |
| FR-D-13 | 試用 — `trial` のドメインは最大 6 記事 / 4 週間だけ提示される。試用枠のドメイン選択は、ドメインごとのベータ事後分布 `Beta(1 + 正例数, 4 + examined 数 − 正例数)` からの Thompson Sampling で行う |
| FR-D-14 | 昇格 — `subscribed` は**固定席**とする（既定 80 席）。空席があれば `examined` 6 件以上かつ事後平均が席の下位四分位を上回った時点で着席する。満席なら、**最下位の現職を押し出せる場合にのみ**昇格する（事後平均が現職最下位を上回ること）。押し出された現職は `dormant` へ |
| FR-D-15 | 降格 — 次のいずれかで `dormant` にする。(a) 直近 20 `examined` で正例ゼロ、(b) **60 日間 1 件も Briefing に選ばれなかった（埋没）**、(c) 90 日更新なし、(d) FR-D-14 による押し出し |
| FR-D-15b | 席数の妥当性 — 席数は「下位四分位のドメインが 120 日以内に `examined` 20 件へ到達できる」ことを満たす最大値とする。四半期ごとに実測から見直す。自動調整は Phase 3 で導入する |
| FR-D-16 | 取得頻度の段階化 — 購読ドメインを事後平均で 3 層に分ける。上位 25% は毎日、中位 50% は 3 日ごと、下位 25% は週 1 回取得する |
| FR-D-16b | 候補の日次取り込み上限 — 1 日に候補プールへ入れる件数を全体で 400 件に制限する。配分はドメインの事後平均に比例させ、**ドメイン数が増えても候補プールが線形に膨らまないようにする** |
| FR-D-16c | 礼儀 — 同時に `trial` にできるドメインは 10 件まで。クロール時は `robots.txt` を尊重し、ドメインあたり 1 リクエスト / 5 秒を上限とし、User-Agent に連絡先を含める |
| FR-D-17 | 手動昇格・却下 — UI からドメインを 1 クリックで `subscribed` / `rejected` にできる。手動判断はモデルの試用判定より優先する |
| FR-D-18 | `rejected` / `retired` の記録は削除しない。同じドメインが再発見されたときに再審査しないため |

#### 設計判断: 購読ドメインは「上限」ではなく「固定席」にする

当初は `subscribed` の上限を 300 件としていたが、**その規模では降格条件が発火しない**。

```
1 日の提示枠 20 件 × 観測率 0.7 ≒ 14 examined/日
300 ドメインに均等配分すると 1 ドメインあたり 0.047 examined/日
→ 降格に必要な examined 20 件に到達するまで約 430 日
```

さらに exploit 枠は事後の高いドメインに集中するため、平凡なドメインは均等配分よりずっと出ない。結果として、**一度購読に入った平凡なサイトは事実上不死身**になり、候補プールとクロール枠だけを消費し続ける。

逆算すると、下位四分位が 120 日以内に評価しきれる規模は次のようになる。

```
下位 75% のドメインが受け取る枠 ≒ 14 × 0.4 = 5.6 examined/日
5.6 × 120 日 ÷ 20 examined ≒ 33 ドメイン（下位 75% 分）
→ 全体で 40〜90 ドメインが feedback loop の実際の容量
```

したがって席数の初期値を **80** とする。加えて 3 つの独立した歯止めを置く。

1. **固定席と押し出し** — 新規は最下位の現職を上回らないと入れない。「増える」ではなく「入れ替わる」構造にする
2. **埋没判定** — 60 日間 1 度も Briefing に選ばれなかったドメインは降格する。降格条件が `examined` の蓄積だけに依存していた不死身バグへの直接の対処
3. **候補の日次上限** — 取り込み件数を全体で 400 件に固定し、ドメインの事後で配分する。**候補プールのサイズをドメイン数から切り離す**

3 が構造的には最も効く。1 と 2 はドメイン集合の質を保ち、3 はドメイン数が増えても下流（埋め込みコスト・ランキング時間・SQLite サイズ）が膨らまないことを保証する。

### 4.1 候補収集（FR-C）

| ID | 要件 |
|---|---|
| FR-C-01 | RSS/Atom フィードを `recSources` に登録し、日次で新着エントリを取得できる。既存 `feedWorker` のパーサを再利用するが、**ブックマークは作成しない**（候補プールに入れるのみ） |
| FR-C-02 | Hacker News / arXiv / GitHub Trending 等の API ソースに対応する。ソース種別はプラグイン的に追加できる構造とする |
| FR-C-03 | 収集件数の **20% 以上をプロフィール非依存**のソース／クエリから取得する。これは設定で下限を切れないハードフロアとする |
| FR-C-04 | URL を正規化（トラッキングパラメータ除去、AMP 解決、末尾スラッシュ統一）してから重複判定する |
| FR-C-05 | タイトル正規化ハッシュ、および埋め込みコサイン類似度 0.93 以上を同一記事クラスタとみなし、代表 1 件のみを候補として残す |
| FR-C-06 | 候補は取得から 14 日で `expired` にする。expired 候補はランキング対象外だが、ログ整合のため 90 日間は削除しない |
| FR-C-07 | 収集は失敗しても他ソースの処理を止めない。ソース単位の連続失敗回数を記録し、5 回連続失敗で `disabled` にして通知する |
| FR-C-08 | **収集元は全ユーザー共通のシード一覧をコードから配る。** `recSources.domainId` は NULL とし、議席（`RECOMMENDER_DOMAIN_SEATS`）にも試用枠にも載せない。**供給層はユーザーごとに削らない** ── パーソナライズはランキング層が担う。収集元でフィルタするとランキングでは取り消せず、ニッチだが良い情報源が一度の空振りで永久に消える。自動停止が許されるのは嗜好ではなく故障によるもの（FR-C-07 の連続失敗）だけ。個別最適化は `discover` の D1 / D2 / D4 が各自の外側へ伸ばす層が担い、そちらは `domainId` を持つのでドメインのライフサイクルが完全に効く |

### 4.2 候補の構造化（FR-S）

| ID | 要件 |
|---|---|
| FR-S-00 | **埋め込みプロバイダをテキスト推論から分離する。** `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` を追加し、埋め込み専用クライアントを生成する。現状 `InferenceClientFactory.build()`（`packages/shared/inference.ts:173-184`）はプロバイダを 1 つしか選べず、埋め込みもチャットと同じ `openAIBaseUrl` へ送られる。この分離なしには埋め込みを取得できない（§10 を参照） |
| FR-S-01 | 埋め込みモデルは **EmbeddingGemma-300m（768 次元）** を Ollama 経由で自ホストする。入力書式は文書側の規定に従い `title: {タイトル \| "none"} \| text: {本文}` とする |
| FR-S-01b | 入力はタイトル + 要約 + 本文冒頭とし、**合計 2,048 トークン以内**に収める（本文は日本語で概ね 1,200 文字、英語で 1,500 文字が上限の目安）。レコメンドに必要なのは話題の把握であり精読ではないため、全文を混ぜない方がトピックが立つ |
| FR-S-02 | 埋め込みは `Float32Array` を BLOB として `recCandidates.embedding` に保存する。Meilisearch のベクトルインデックスは使わない（後述の設計判断を参照） |
| FR-S-03 | 要約が取得できない候補は、タイトル + メタディスクリプションのみで埋め込みを生成する。本文取得の失敗は候補を落とす理由にしない |
| FR-S-04 | 全候補を対象に k-means（k は候補数の平方根、上限 64）でクラスタリングし、`recClusters` に重心とラベルを保存する。ラベルは LLM に代表 5 記事のタイトルを渡して 1 回だけ生成する |
| FR-S-05 | クラスタリングは日次バッチとし、クラスタ ID の連続性を保つため前日の重心を初期値にする |
| FR-S-06 | **日本語ダイジェストと埋め込みは `urlHash` 単位で全ユーザー間で共有する。** どちらも記事の内容だけで決まり、誰が読むかに依存しない。`recArticleCache`（`userId` を持たない）に置き、`embed` / `digest` が生成前に引いて候補行へコピーする。読み出しの正本は `recCandidates` のままで、ランキングと UI はこの表を知らない。モデル ID か埋め込み次元が一致しない行はミスとして扱う（`modelId` は次元を含まないため次元を別に持つ）。キャッシュへ**書く**のは `origin='collected'` 由来のものだけとし、`origin='bootstrap'`（本人のブックマーク）は**読み取りのみ**許す。生成失敗はキャッシュしない |

### 4.3 ランキング（FR-R）

| ID | 要件 |
|---|---|
| FR-R-01 | 有効な候補全件に対してスコアと不確実性を算出する |
| FR-R-02 | 枠の配分は既定で exploit 55% / adjacent 20% / uncertain 10% / **trial 10%** / random 5%。設定で変更可能だが、`uncertain + trial + random` は 25% を、**`trial` は単独で 10%** を下回れない |
| FR-R-02b | `trial` 枠は `trial` 状態のドメイン由来の候補のみから選ぶ。試用ドメインの記事は 1 Briefing あたり最大 2 件とし、探索疲れを避ける |
| FR-R-03 | ランキング確定後に多様性制約を適用する。同一クラスタからの採用は 1 Briefing あたり最大 3 件、同一ドメインは最大 2 件 |
| FR-R-03b | Thompson Sampling の重みサンプル `w̃ ~ N(ŵ, Σ)` は **1 Briefing につき 1 回だけ引く**。記事ごとに引き直すと、その日の 20 件が互いに無関係な方針で選ばれ、並びの一貫性と事後解釈の両方が失われる |
| FR-R-03c | `uncertain` 枠は、**スコア上位 30% に絞ってから**不確実性の大きい順に選ぶ。絞らないと「有望ではないが単に特徴が外れ値なだけの記事」が毎回選ばれる |
| FR-R-04 | 各提示について、スコア・不確実性・枠種別・propensity・モデルバージョン・特徴量スナップショットを `recImpressions` に保存する |
| FR-R-04b | **`exploit` / `adjacent` 枠は argmax ではなく温度つき softmax の非復元抽出（Plackett–Luce）で選ぶ**。温度 `τ` の既定は 0.15 とし、argmax に近い挙動を保ちながら選出確率を厳密に計算できるようにする。各スロットの `propensity` には `P(枠) × P(記事 \| 枠)` の実値を保存する |
| FR-R-05 | 提示されなかった候補についても、上位 100 件までは `shown=false` で `recImpressions` に記録する |
| FR-R-06 | モデル推論が失敗した場合、公開日時の新着順にフォールバックし、`modelVersion='fallback'` として記録する |
| FR-R-07 | 1 Briefing の既定件数は 20 件。設定可能 |

### 4.4 提示 UI（FR-U）

`/dashboard/briefing` に 1 ページ追加する。

| ID | 要件 |
|---|---|
| FR-U-01 | 当日の Briefing をカード一覧で表示する。カードにはタイトル・ソース・公開日時・要約・選定理由を表示する |
| FR-U-02 | 選定理由は「過去に高評価だった記事群と意味的に近い」「最近このテーマの提示が多いため重複ペナルティあり」のような自然文で表示する。探索枠の記事には探索枠であることを明示する |
| FR-U-03 | 各カードに **開く** / **保存** / **いいね** / **興味なし** の 4 操作を置く |
| FR-U-04 | 「保存」は既存のブックマーク作成フローを呼び、通常どおり crawl・要約・タグ付け・翻訳の対象にする。保存したブックマーク ID を impression に紐づける |
| FR-U-05 | 「興味なし」は **1 クリックで完了**する。理由の選択（テーマ違い / 既読 / 情報源が弱い / 内容が薄い）は任意の追加操作とし、必須にしない。明示的な負例はこれしか取れないため、押すコストを最小化する |
| FR-U-06 | 「興味の現在地」パネルで、明示プロフィール・上位選好クラスタ（ラベルと代表記事）・否定クラスタ・現在の探索率を表示する |
| FR-U-07 | 過去の Briefing を日付で遡れる |
| FR-U-08 | カードが viewport に 50% 以上・1 秒以上入った時点で `viewed` イベントを記録する（IntersectionObserver） |
| FR-U-09 | 試用ドメイン由来のカードには、試用中であることと発見経路を明示する |
| FR-U-10 | 「今日の新しい発見」ブロックを置き、新規発見ドメインを**発見経路の説明つき**で表示する（例:「あなたが保存した記事 3 本からリンクされていました」）。各ドメインに **購読 / 却下** の 1 クリック操作を置く |
| FR-U-11 | Briefing を開いた時点で `opened` イベントを送り、離脱時に最後に `viewed` されたカードの順位を送る。これらは §6.3 の観測状態の判定に使う |
| FR-U-12 | カードは **日本語の訳題を主表示**にし、原題を副題として小さく添える。日本語記事や訳題が無い記事では原題だけを出す |
| FR-U-13 | 訳題と日本語要約は **rank で表示が確定した候補にだけ**生成する（1 日 `briefingSize` 件）。生成は rank とは別ジョブで、Briefing の生成をブロックしない。結果は `recCandidates` に永続キャッシュし、同じ記事が翌日も選ばれたら再生成しない。プロバイダはローカル（Ollama）と外部を env で切り替える。RSS の抜粋が短い候補は本文を取得して要約の入力にする |
| FR-U-15 | **Briefing ページの「はじめる」で自分で有効化できる。** 押下で共通のシード収集元が登録され、初回パイプライン（bootstrap → embed → collect → embed → rank）が **1 ジョブとして直列に**実行される。3 ジョブに分けると、`runCollect` が埋め込みを別キューへ渡すため `rank` が埋め込み完了前に走る。冪等で、収集元を既に 1 件でも持つユーザーには何もしない（判定は `recommenderUserIds()` と同じ述語） |
| FR-U-14 | カードに **「訳して読む」を「保存」とは別に置く**。どちらもブックマークを作る（翻訳がブックマーク単位のため）が、「訳して読む」が記録するのは正例でも負例でもない中立の `read_intent` だけとする。観測窓を過ぎても engagement が 1 つも付かなかった `read_intent` は、`read_abandoned` という**弱い負例**（`dismissed` より軽い）に確定させる |

### 4.5 フィードバック収集（FR-F）

| ID | 要件 |
|---|---|
| FR-F-01 | 即時イベント（`viewed` / `clicked` / `saved` / `liked` / `dismissed`）を `recFeedbackEvents` に追記する。イベントは削除せず、取り消しも新しいイベントとして記録する |
| FR-F-02 | 遅延報酬を日次で join する。保存されたブックマークの `userReadingProgress.readingProgressPercent`、`highlights` の有無、`bookmarks.favourited`、リスト追加を、対応する impression に紐づける |
| FR-F-03 | 遅延報酬の観測窓は保存から 7 日。7 日経過後に確定させ、以後は更新しない |
| FR-F-04 | 既存ブックマーク（推薦経由でないもの）も、コールドスタート用の正例として学習に使えるよう `recImpressions` に `source='bootstrap'` として取り込める |
| FR-F-05 | Briefing の観測状態を判定して `recBriefings.observationState` に保存する。`unobserved`（`opened` イベントなし）/ `partial`（開いたが最下部に到達せず）/ `observed`（最下部まで到達） |
| FR-F-06 | impression ごとに `examined` フラグを立てる。`viewed` イベントがあるか、**その impression より下位の impression に `viewed` がある**（通過証明）場合に `true` とする |
| FR-F-07 | `unobserved` な Briefing の impression には**一切ラベルを付けない**。ログとしては保持するが、学習・指標のどちらの分母にも入れない |

### 4.6 プロフィールと学習（FR-L）

| ID | 要件 |
|---|---|
| FR-L-01 | 4 種のプロフィールを保持し日次更新する — 明示 / 長期潜在 / 直近 7 日 / 否定 |
| FR-L-02 | 長期潜在プロフィールは全正例埋め込みの重心。直近プロフィールは半減期 7 日の指数減衰重み付き重心 |
| FR-L-03 | クラスタ選好は、クラスタごとの正例率をベータ分布で平滑化した値とする（事前分布 α=1, β=4） |
| FR-L-03b | ドメインごとのベータ事後分布を更新し、`trial` の昇格・降格判定を行う（FR-D-13〜15） |
| FR-L-04 | モデルは `heuristic-v1` → `logreg-v1` → `bayes-logreg-v1` の順に昇格する。昇格条件を満たさない間は下位モデルを使う |
| FR-L-04b | 学習目標は**同一 Briefing 内のペアワイズ比較**とする（§6.2）。`examined` かつ未操作の記事を単独の負例ラベルにはしない |
| FR-L-05 | モデル再学習は日次。新モデルは 7 日間シャドー評価（実提示には使わず予測のみ記録）し、**ペア正解率と NDCG@20 の両方**で既存モデルを上回った場合のみ昇格する。片方だけで判定しない — ペアの順序は合っていても上位 20 件に良い記事を集められない状態がありうるため |
| FR-L-05b | 学習には `recImpressions.features` に保存した**特徴量スナップショットをそのまま使う**。現在のプロフィールで過去記事の特徴量を計算し直すと、その記事を保存した事実が既にプロフィールへ反映されているため、答えを見て問題を解くことになる。スナップショットはデバッグ用ログではなく、リーク防止のための必須要件である |
| FR-L-05c | ハイパーパラメータ `λ` は**時系列の拡張窓 CV**（過去のみで学習し次の 2 週間を予測、を繰り返す）で選ぶ。ランダム分割は未来の情報が漏れるため使わない |
| FR-L-06 | すべてのモデルバージョンとパラメータ・学習日時・評価指標を `recModels` に保存し、任意のバージョンにロールバックできる |
| FR-L-07 | 学習データが昇格条件を満たさない場合、学習ジョブは何もせず理由をログに残す（無理に学習しない） |

### 4.7 LLM 連携（FR-A）

MCP Tool として公開する。morning briefing エージェントはこれを呼ぶだけでよく、記事履歴を丸ごと渡す必要はない。

| ID | 要件 |
|---|---|
| FR-A-01 | `rank_articles` — 当日の推薦順位を返す |
| FR-A-02 | `get_interest_state` — 現在の明示的・潜在的興味を圧縮表現で返す |
| FR-A-03 | `explain_article_score` — 特定記事のスコア内訳を返す |
| FR-A-04 | `record_article_feedback` — クリック・いいね・保存等を記録する |
| FR-A-05 | LLM はスコアを尊重する立場とし、並べ替えの自由を与えない。LLM の役割は読みやすい briefing 文への編集に限定する |

## 5. データモデル

すべて `rec` プレフィックス。`packages/db/schema.ts` の末尾に追記し、追加マイグレーションで作成する。

```
recDomains
  id, userId, domain(unique per user), status('discovered'|'screened'|
    'trial'|'subscribed'|'dormant'|'rejected'|'retired'),
  feedUrl, scrapable(bool), title, description, faviconUrl,
  qualityClass('primary'|'analysis'|'syndication'|'promotional'|'unknown'),
  qualityCheckedAt, blockedReason,
  centroid(blob),                     -- ドメイン埋め込み (D10 用)
  examinedCount, positiveCount, betaAlpha(real), betaBeta(real),
  trialStartedAt, trialImpressionCount,
  promotedAt, demotedAt, manualDecision('subscribe'|'reject'|null),
  firstSeenAt, lastArticleAt, createdAt

recDomainDiscoveries
  id, domainId, channel('bookmark_backfill'|'outbound_link'|'aggregator'|
    'author'|'blogroll'|'smallweb_search'|'domain_neighbor'|'social'|'llm_search'),
  evidenceRef,                        -- 元記事 bookmarkId / 検索クエリ 等
  weight(real), discoveredAt

recSources
  id, userId, domainId, kind('rss'|'hn'|'arxiv'|'github'|'scrape'|'custom'),
  config(json), profileIndependent(bool), enabled(bool),
  consecutiveFailures(int), lastFetchedAt, createdAt

recCandidates
  id, userId, sourceId, domainId, url, canonicalUrl, urlHash(unique per user),
  title, summary, contentExcerpt, author, publishedAt, fetchedAt,
  lang, embedding(blob, Float32), embeddingStatus, clusterId,
  duplicateOfId, status('active'|'expired'|'promoted'), bookmarkId,
  createdAt

recClusters
  id, userId, label, centroid(blob), size, preferenceScore,
  positiveCount, negativeCount, computedAt

recProfiles
  userId(pk), explicitTopics(json), stableEmbedding(blob),
  recentEmbedding(blob), negativeEmbedding(blob),
  clusterPreferences(json), negativeClusters(json),
  explorationRate(real), updatedAt

recBriefings
  id, userId, briefingDate, slot('morning'), status, modelVersion,
  itemCount, generatedAt,
  observationState('unobserved'|'partial'|'observed'),
  openedAt, deepestViewedRank, observationFinalizedAt

recImpressions
  id, userId, briefingId, candidateId, domainId, rank, arm, shown(bool),
  examined(bool),                     -- 実際に目に入ったと確認できるか
  score(real), uncertainty(real), propensity(real),
  modelVersion, features(json), shownAt,
  rewardFinalized(bool), rewardValue(real), createdAt

recFeedbackEvents
  id, impressionId, userId, eventType, value(real), reason,
  occurredAt, meta(json)

recModels
  version(pk), kind, params(json), featureSchema(json),
  trainedAt, trainSampleCount, positiveCount,
  metrics(json), status('shadow'|'active'|'retired')
```

### 設計判断: 埋め込みを Meilisearch に置かない

karakeep のベクトルストアプラグイン（`packages/shared/vectorStore.ts`）は `BookmarkVectorDocument` に強く型付けされており、候補記事を載せるにはプラグインインターフェースの変更が必要になる。これは upstream との差分を大きくする。

一方、候補プールは常時 3,000〜5,000 件程度。768 次元 Float32 なら候補あたり 3 KB、プール全体で 15 MB 弱で、Node で総当たりコサイン類似度を計算しても数十ミリ秒で終わる。**SQLite に BLOB で持ち、TypeScript で総当たり**するほうが、性能上のデメリットなしに upstream 追従コストを下げられる。

ベクトルは**書き込み時に L2 正規化**しておく。ランキング時のコサインが単なる内積になり、総当たりのループが素直に速くなる。MRL で 512 / 256 次元へ切り詰める場合は、**切った後に必ず再正規化**する。

候補が 5 万件を超えた場合はこの判断を見直す（その時点で HNSW か Meilisearch への移行を検討）。

## 6. 報酬設計

合成報酬は保存しない。**生イベントを記録し、重みは設定で後から変える**。

### 6.1 イベントと既定重み

| イベント | 既定重み | 備考 |
|---|---|---|
| `viewed`（画面内に入った） | 0 | 分母の把握用 |
| `clicked` | +0.2 | 単独では弱い正例 |
| `saved`（ブックマーク化） | +1.2 | 最も強い明示的正例 |
| `liked` | +1.0 | |
| `dismissed`（興味なし） | -1.0 | 理由つきなら否定プロフィールにも反映 |
| `read_partial`（読了率 30〜60%） | +0.5 | 遅延報酬 |
| `read_full`（読了率 60% 以上） | +0.8 | 遅延報酬 |
| `highlighted` | +0.9 | 遅延報酬 |
| `favourited`（保存後） | +1.0 | 遅延報酬 |

**`no_click` というイベントは定義しない。** 「押されなかったこと」は観測ではないため（§6.3）。

### 6.2 学習ラベル — ペアワイズ比較

`examined` かつ未操作の記事を、単独の負例ラベルにはしない。代わりに**同一 Briefing 内のペアワイズ比較**を学習の主目標とする。

```
同一 Briefing b の中で:
  正例集合  P_b = { saved | liked | favourited | highlighted | read_full }
  比較対象  N_b = { examined かつ未操作 }   ← ラベルではなく「比較の相手」

  学習目標:  すべての (x⁺, x⁻) ∈ P_b × N_b について σ(w·(x⁺ − x⁻)) を最大化
```

同一 Briefing 内で比較するため、その日の可処分時間・気分・時間帯といった**日次のバイアスがペアの中でキャンセルされる**。「今日は忙しくて 3 件しか開けなかった」という日でも、開いた 3 件と開かなかった記事の相対順序の情報は正しく残る。

実装上は差分ベクトル `x⁺ − x⁻` に対するロジスティック回帰そのもの（Bradley–Terry / RankNet の 1 層版）であり、二値分類とまったく同じコードで動く。

**サンプル重み**

| ペアの種類 | 重み |
|---|---|
| strong_positive（保存・いいね・読了）vs examined 未操作 | 1.0 |
| weak_positive（クリックのみ）vs examined 未操作 | 0.3 |
| strong_positive vs weak_positive（保存 > 単なるクリック） | 0.3 |
| **dismissed を負側に置いたペア** | 1.5 |

**日ごとの正規化を掛ける。** 各ペアの重みをさらに `1 / |N_b|` で割り、1 つの正例が寄与する総重量をその日の `examined` 数によらず一定にする。これをしないと、20 件すべてスクロールした日が、6 件しか見なかった日を圧倒し、暇な日の好みばかりを学習する。

`dismissed` は唯一の明示的な負例であり、`P_b` が空の Briefing でも「他のどの examined 記事より下」というペアを作れる。

**ペアが作れない Briefing の扱い**

正例も `dismissed` もない Briefing（開いたが何もしなかった日）は、ペアが 1 つも作れないため**学習に寄与しない**。これは正しい挙動である。「何もしなかった」から何かを推論しようとしない。

### 6.3 「押されなかったこと」を観測として扱わない

クリックは安定して観測できるが、**非クリックは観測できない**。Briefing を見ない日、途中までしかスクロールしない日、開いたが時間がなかった日がある。これらの impression を負例にすると、記録されるのは興味の欠如ではなく可処分時間になる。

**3 段の防御**

| 段 | 仕組み | 効果 |
|---|---|---|
| 1 | `observationState = unobserved` の Briefing は学習・指標のどちらの分母にも入れない | 見なかった日が丸ごと除外される |
| 2 | `examined = false` の impression は比較対象にしない | スクロールで到達しなかったカードが除外される |
| 3 | ペアワイズ比較（§6.2）で日次バイアスをキャンセルする | 忙しい日と暇な日を同列に扱わない |

**`examined` の判定**

次のいずれかを満たす場合に `true`。

- そのカードが viewport に 50% 以上・1 秒以上入った（`viewed` イベント）
- **より下位のカードに `viewed` がある**（通過証明。スクロールで飛ばされたが視界には入った）

最後に `viewed` されたカードより下の未到達カードは `examined = false` とする。

**指標の分母**

クリック率・保存率の分母は「提示数」ではなく **`observed` な Briefing の `examined` impression 数**とする。提示数を分母にすると、忙しかった週に指標が下がったように見え、モデルの良し悪しと区別できない。

**未観測 Briefing の記事の再提示**

`unobserved` だった Briefing のスコア上位 5 件は、翌日の Briefing に 1 回だけ再提示してよい。ただし**新しい impression レコードとして記録**し、元の impression は未ラベルのまま残す。再提示は 1 回限りとし、それでも観測されなければ候補プールに戻す。

### 6.4 ポジションバイアスの扱い

表示順位 `rank` を **学習時のみ特徴量に含め**、推論時は `rank=1` に固定する。これにより「上に出たからクリックされた」分の寄与をモデルから切り離す。

ペアワイズ学習では、同一 Briefing 内で `rank` が近い記事どうしのペアほどバイアスの影響が小さい。将来的にはペアの重みを `1 / (1 + |rank⁺ − rank⁻|)` で減衰させることも検討する（Phase 3 以降、データ量を見てから）。

## 7. 特徴量

`logreg-v1` の特徴量は 20 前後に抑える。次元を増やすと、この規模のデータでは分散が支配的になる。

| # | 特徴量 | 型 |
|---|---|---|
| 1 | cos(候補, 長期潜在プロフィール) | real |
| 2 | cos(候補, 直近 7 日プロフィール) | real |
| 3 | cos(候補, 否定プロフィール) | real |
| 4 | 直近 30 日の正例記事との最大コサイン | real |
| 5 | 上位 5 正例との平均コサイン | real |
| 6 | 所属クラスタの選好スコア | real |
| 7 | 所属クラスタの直近 7 日提示回数（対数） | real |
| 8 | 公開からの経過時間（対数時間） | real |
| 9 | ソース種別（rss / aggregator / scrape / api） | 4 次元 |
| 9b | **ドメインのベータ事後平均**（未知ドメインは事前値 0.2） | real |
| 9c | **ドメインの examined 数**（対数。事後の信頼度を表す） | real |
| 9d | **ドメイン状態**（subscribed / trial） | bool |
| 10 | 一次情報フラグ（`recDomains.qualityClass` 由来） | 4 次元 |
| 11 | 新規性 = 1 − 既存ブックマークとの最大コサイン | real |
| 12 | 言語（ja / en / other） | 3 次元 |
| 13 | 休日 × `cos(候補, 直近プロフィール)`（**交互作用**。単独の曜日特徴は使わない） | real |
| 14 | タイトル長（正規化） | real |
| 15 | 本文長の推定値（対数） | real |
| 16 | `heuristic-v1` のスコア | real |
| 17 | 表示順位（学習時のみ） | real |

#### 設計判断: Briefing 内で一定の特徴量は使えない

ペアワイズ学習は差分ベクトル `x⁺ − x⁻` を入力にするため、**同一 Briefing 内ですべての記事に同じ値をとる特徴量は必ず 0 になり、重みが同定不能になる**。

```
曜日 / 平日休日 / briefing スロット / その日のプロフィール状態
  → 同じ日の全記事で同値 → 差分が常に 0 → 学習できない
切片項も同様に消えるため、バイアスは学習対象にならない
```

これらは落とすか、**記事ごとに値が変わる特徴との交互作用**にする。

```
✗  f = is_weekend
✓  f = is_weekend × cos(候補, 直近プロフィール)
     「休日は直近の関心に寄った記事が読まれやすい」を表現できる
```

`rank` は同一 Briefing 内で値が変わるため差分に残る（だからポジションバイアス補正が成立する）。

**ドメインを one-hot にしない**のが要点。ドメインは数百に増えるうえ新規追加が続くため、one-hot にすると次元が発散し、新規ドメインは常に未学習になる。代わりに**ドメイン単位のベータ事後平均を 1 特徴に圧縮**して渡す。ドメインの良し悪しはソースレベルのバンディット（§4.0）が持ち、記事モデルはそれを 1 つの入力として受け取るという役割分担にする。

特徴量スキーマは `recModels.featureSchema` に保存し、スキーマが変わったら旧モデルを自動で `retired` にする。

## 8. MCP Tool 仕様

### `rank_articles`

```json
{
  "name": "rank_articles",
  "arguments": {
    "context": {
      "date": "2026-08-06",
      "briefing_slot": "morning",
      "max_results": 10
    }
  }
}
```

戻り値:

```json
{
  "briefing_id": "brf_01H...",
  "model_version": "bayes-logreg-v1",
  "ranked_articles": [
    {
      "article_id": "cnd_a123",
      "url": "https://...",
      "title": "...",
      "summary": "...",
      "source": "lobste.rs",
      "published_at": "2026-08-05T22:10:00Z",
      "score": 0.82,
      "uncertainty": 0.31,
      "selection_mode": "exploitation",
      "matched_interests": ["local-first AI", "recommendation systems"]
    },
    {
      "article_id": "cnd_a456",
      "score": 0.64,
      "uncertainty": 0.78,
      "selection_mode": "exploration",
      "matched_interests": ["latent cluster 17: 分散合意プロトコル"]
    }
  ]
}
```

`rank_articles` の呼び出し自体が impression を生成する。LLM が結果を使わなかった場合に impression が残らないよう、`shown` フラグは Briefing ページの表示または `record_article_feedback` の `viewed` で確定させる。

### `get_interest_state`

戻り値はコンテキスト節約のため圧縮表現とする。埋め込みそのものは返さない。

```json
{
  "explicit_topics": ["分散システム", "ローカル LLM"],
  "top_clusters": [
    { "id": "cluster_12", "label": "推薦システムと情報検索", "score": 0.84 },
    { "id": "cluster_31", "label": "SQLite / 組み込み DB", "score": 0.61 }
  ],
  "emerging_clusters": [
    { "id": "cluster_44", "label": "形式手法", "score": 0.38, "trend": "up" }
  ],
  "negative_clusters": [
    { "id": "cluster_7", "label": "AI 製品リリース速報", "score": -0.72 }
  ],
  "recent_interest_shift": "直近 2 週間で「形式手法」への反応が増加",
  "exploration_rate": 0.15,
  "source_discovery": {
    "trial_domains": [
      { "domain": "simonwillison.net", "discovered_via": "outbound_link",
        "evidence": "保存記事 3 本からリンク", "examined": 4, "positives": 2 }
    ],
    "recently_promoted": ["lobste.rs", "blog.example-lab.ac.jp"],
    "new_domain_save_share": 0.22
  },
  "model_version": "bayes-logreg-v1"
}
```

### `explain_article_score`

`article_id` を受け取り、上位寄与特徴量とその符号・寄与量、類似する過去の正例記事を最大 3 件返す。

### `record_article_feedback`

`article_id`（または `impression_id`）と `event_type`、任意の `value` / `reason` を受け取り記録する。冪等性のため `(impression_id, event_type, occurred_at)` で重複排除する。

## 9. 非機能要件

| ID | 要件 |
|---|---|
| NFR-01 | ランキング生成は候補 5,000 件に対して 5 秒以内 |
| NFR-02 | Briefing ページの初期表示は 1 秒以内（サーバー側で事前生成済みの結果を読むだけ） |
| NFR-03 | 追加ミドルウェアを導入しない。SQLite / Meilisearch / liteque の既存構成で完結する |
| NFR-04 | SQLite への書き込みは既存 WAL モード前提。候補投入は 1 トランザクションあたり 200 件までにチャンクし、`database is locked` を誘発しない |
| NFR-05 | ストレージ増分は候補プール 15 MB + 年間ログ 50 MB 以内（768 次元 Float32 × 5,000 件） |
| NFR-06 | 埋め込みは自ホストのため API コストはゼロ。Ollama の追加リソースは requests 1Gi / limits 2Gi 以内（EmbeddingGemma は量子化済みで 622 MB）。1 日 400 件の埋め込みが夜間バッチ枠（1 時間）内に完了すること |
| NFR-07 | 推薦関連のメトリクスを既存 workers の `/metrics` に出す（候補数・提示数・クリック率・保存率・モデルバージョン・ジョブ失敗数） |
| NFR-08 | いずれかのワーカーが落ちても Briefing ページは前日分を表示できる |
| NFR-09 | 収集ジョブの失敗は Briefing の生成を止めない。候補が 1 件もない場合は空の Briefing を生成し、その旨を表示する |
| NFR-10 | 認証は既存の NextAuth に乗る。MCP Tool は既存の API キー機構を使う |
| NFR-11 | upstream への追従性のため、既存ファイルの変更は README に列挙した登録ポイントに限定する |
| NFR-12 | 全ログは `userId` 単位で削除できる（データ削除要求への対応） |

## 10. 制約と前提

- ユーザーは 1 名。学習データは年間 impression 約 7,300 件、正例約 1,000 件を見込む。**この規模がモデル選択の最大の制約**である
- ただしペアワイズ学習（§6.2）では、1 Briefing あたり `|P| × |N|` 組のペアが作れる。正例 3 件 × examined 未操作 15 件なら 1 日 45 組、年間約 16,000 組になる。**制約が効くのは正例の絶対数（年 1,000 件）であってペア数ではない**点に注意する。ペアが増えても独立な情報は増えない
- Briefing を見ない日が一定割合ある前提で設計する。観測率 70% を想定し、それを下回っても指標が壊れないよう分母を `observed` に限定する（§6.3）
- karakeep の SQLite は `local-path` PV で d1（worker-1）にノード固定。推薦機能もこのノードに乗る
- Meilisearch は既存の検索・ベクトル用途のまま。推薦は Meilisearch に依存しない
- Cloudflare Access の内側で運用するため、外部からの未認証アクセスは考慮しない

### 埋め込みについての前提

**現行構成では埋め込みを取得できない。** 着手前に FR-S-00 の対応が必要である。

1. `openaiBaseUrl` は OpenCode Go（`https://opencode.ai/zen/go/v1`）を指しており、これはチャット補完のリレーである。`/embeddings` は提供されていない
2. `OpenAIInferenceClient.generateEmbeddingFromText()`（`inference.ts:322-333`）は、チャットと同一の `baseURL`（`:211`）を使う
3. `InferenceClientFactory.build()`（`:173-184`）は `openAIApiKey` があれば無条件に OpenAI 系を返すため、「チャットは OpenCode Go、埋め込みは Ollama」という併用ができない
4. `EMBEDDING_ENABLE_AUTO_INDEXING` の既定は `false` で values.yaml にも設定がないため、**現在は埋め込みがまったく生成されていない**
5. `EMBEDDING_DIMENSIONS` は API に送られておらず、Meilisearch のインデックス次元宣言に使われるだけである（`vectorstore-meilisearch/src/index.ts:257`）。次元を絞る場合は自前で切り詰める

**モデル選定の第一基準は日英のクロスリンガル整合**とする。プロフィール重心は日本語記事と英語記事を混ぜて構成されるため、埋め込み空間で言語ごとに領域が分かれていると、`cos(候補, プロフィール)` が話題ではなく言語を測る特徴量になる。言語の one-hot では吸収しきれない。

EmbeddingGemma-300m を選ぶのはこの基準による。XTREME-UP（20 言語のクエリを英語パッセージへ当てる検索）で MRR@10 47.7 を記録し、Gecko（7.6）や GTE-multilingual-base（19.0）を大きく上回る。論文は、MTEB 多言語で強いモデルでも XTREME-UP では苦戦する例として Qwen3-Embedding-0.6B を名指ししており、**汎用の多言語スコアとクロスリンガル整合は別物**である。

| 候補 | サイズ / 次元 | 位置づけ |
|---|---|---|
| **EmbeddingGemma-300m** | 308M / 768 | **採用。**クロスリンガル整合が突出、最軽量、Ollama 提供済み |
| Qwen3-Embedding-0.6B | 595M / 1024 | 32k コンテキストが必要になった場合の代替。クロスリンガルは劣る |
| Ruri v3 310m | 310M / 768 | JMTEB 77.2 で日本語 SOTA。収集元が英語中心のため主軸には向かない |
| bge-m3 | 568M / 1024 | 2024 年初頭のモデル。あえて選ぶ理由がない |

埋め込みモデルを変更した場合は全候補・全ブックマークの再埋め込みが必要で、その間はプロフィールとの比較が無効になる。**モデル ID を `recCandidates` に記録し、混在時は再計算する。** 外部提供条件の変更で停止するリスク（2026-07-31 に推論モデルが 403 を返し翻訳とタグ付けが全滅した事例）を、システム中で最も差し替えコストの高い部品から外すため、埋め込みは自ホストとする。

## 11. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| フィードバックループによる興味の固定化 | 探索が死に、暗黙知が出てこない | 収集の 20% をプロフィール非依存に固定。探索枠の下限 10%。多様性制約 |
| データ不足でモデルが過学習 | ヒューリスティックより悪化 | 昇格ゲート（正例 100 件・impression 2,000 件）とシャドー評価の 2 段構え |
| 遅延報酬の join 漏れ | 保存後の読了が学習に反映されない | 観測窓 7 日で確定させ、確定済みフラグを持つ。未確定 impression は学習から除外 |
| upstream の大きな変更との衝突 | rebase 不能 | 追加のみを原則とし、変更する既存ファイルを README に明記。定期的に upstream を取り込む |
| 埋め込みサービスの停止・モデル変更 | 候補が推薦できない。モデル変更時は全再計算が必要でプロフィールが一時的に無効になる | 自ホストで外部提供条件の変化から切り離す。埋め込み失敗候補は新着順フォールバックの対象に含める。モデル ID を候補ごとに記録し、混在時は再計算する |
| 埋め込み空間が言語で分かれる | `cos(候補, プロフィール)` が話題ではなく言語を測る特徴量になる | クロスリンガル整合を第一基準にモデルを選ぶ。採用前に自前データで検証する（Phase 1 の手動作業） |
| 候補プールの肥大化 | SQLite の性能劣化 | 14 日で expire、90 日でパージ。候補数の上限アラートを Grafana に設定 |
| 「保存」以外の読了計測ができない | 報酬が保存に偏る | 外部リンクの滞在時間は計測しない設計とし、保存後の読了を主要な深度シグナルとして扱うことを明示 |
| **Briefing を見ない日が続く** | 偽の負例が大量に混入し、モデルが劣化する | `unobserved` の除外・`examined` 判定・ペアワイズ学習の 3 段構え（§6.3）。観測率が 4 週連続で 50% を下回ったら学習を停止する |
| **明示的な負例が集まらない** | 「興味なし」を押す習慣がないとペアの負側が弱くなる | 「興味なし」を 1 クリックにする（FR-U-05）。それでも `dismissed` が週 3 件未満なら、UI 上で軽く促す |
| **ソース発見でスパムが流入する** | 候補プールの品質低下 | 4 段の品質ゲート（FR-D-12）、`trial` は同時 10 ドメインまで、1 Briefing あたり試用記事 2 件まで |
| **試用枠が体感品質を下げる** | 毎朝ゴミを見せられて Briefing 自体を見なくなる → 上のリスクに連鎖 | 試用記事は 1 日最大 2 件。試用中であることを明示し、期待値を下げておく。「今日の新しい発見」ブロックで却下を 1 クリックにする |
| **ドメインプールの肥大化** | クロール負荷、候補プールの膨張、Briefing の質の希釈 | 固定席 80 + 押し出し方式、埋没判定（60 日選ばれなければ降格）、候補の日次取り込み上限 400 件、取得頻度の 3 層化（§4.0 の設計判断を参照） |
| **降格条件が発火しない** | 平凡なドメインが不死身になり、枠と候補プールを食い続ける | 席数を feedback loop の容量（40〜90）に合わせる。`examined` の蓄積に依存しない埋没判定を併用する |
| **クロール先への負荷・礼儀** | ブロックされる、迷惑をかける | `robots.txt` 尊重、ドメインあたり 1 リクエスト / 5 秒、User-Agent に連絡先を明記（FR-D-16） |

## 12. オフポリシー評価の準備

### 記録するだけでは足りない

**選択が決定的なら propensity は 0 か 1 にしかならず、逆確率重み付けは機能しない。** 当初「propensity を保存すれば将来オフポリシー評価ができる」としていたが、これは誤りだった。argmax で選んでいる限り、後からログをいくら眺めても反実仮想は復元できない。

評価可能にするには**選択自体をランダム化する**必要がある。そのため FR-R-04b で `exploit` / `adjacent` 枠を温度つき softmax の非復元抽出に変更した。

```
P(a_1) = exp(score(a_1)/τ) / Σ_{a∈C} exp(score(a)/τ)
P(a_2) = exp(score(a_2)/τ) / Σ_{a∈C∖{a_1}} exp(score(a)/τ)
...
propensity(a_k) = P(枠) × Π 上記の逐次確率
```

`τ = 0.15` なら実質的に argmax とほぼ同じ並びになり、体感の推薦品質を落とさずに propensity が厳密に得られる。**この変更を入れないと Phase 5 のオフポリシー評価は原理的に実施できない。**

なお `random` 枠（5%）だけは元から一様なので、そこだけは厳密な IPS が可能である。ただし年間 365 件では検定力が足りない。

### 記録項目

Phase 1 の実装時点から以下を必ず記録する。評価そのものは Phase 5 で実装する。

- 収集されたが提示されなかった候補（上位 100 件）
- 表示順位・表示時刻
- 推薦時のモデルバージョン
- **推薦確率 (propensity)**
- 探索か活用か（arm）
- **Briefing の観測状態と impression の `examined` フラグ** — これがないと、過去ログのどれが有効なサンプルだったか後から復元できない
- **ドメインの当時の状態とベータ事後**（trial / subscribed、α・β）
- 特徴量スナップショット
- その時点のプロフィールのハッシュ（`recProfiles` の履歴は持たず、ハッシュで同一性のみ判定）

propensity を後から復元することはできないため、これだけは初日から確実に保存する。
