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
3. LLM に渡すコンテキストを、履歴の全量ではなく圧縮したプロフィールと上位候補に限定する

### 成功の定義

| 指標 | 現状（推定） | 3 か月後の目標 |
|---|---|---|
| 提示記事のクリック率 | — | 25% 以上 |
| 提示記事の保存率（karakeep へのブックマーク化） | — | 8% 以上 |
| 探索枠から生まれた新規選好クラスタ | — | 月 1 件以上 |
| Briefing 生成の所要時間 | — | 30 秒以内（LLM 生成を除き 5 秒以内） |

初期はベースラインが存在しないため、Phase 1 の最初の 4 週間を「新着順ランダム提示」と併走させ、その値をベースラインとする。

## 2. スコープ

### 対象

- 単一ユーザー（自宅サーバー 1 人運用）
- 記事候補の収集・重複排除・埋め込み
- 推薦スコアリングと探索制御
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

### 4.2 候補の構造化（FR-S）

| ID | 要件 |
|---|---|
| FR-S-01 | 候補のタイトル・要約・本文抜粋（先頭 3,000 文字相当）から埋め込みを生成する。既存 `InferenceClientFactory` の埋め込みモデルを使う |
| FR-S-02 | 埋め込みは `Float32Array` を BLOB として `recCandidates.embedding` に保存する。Meilisearch のベクトルインデックスは使わない（後述の設計判断を参照） |
| FR-S-03 | 要約が取得できない候補は、タイトル + メタディスクリプションのみで埋め込みを生成する。本文取得の失敗は候補を落とす理由にしない |
| FR-S-04 | 全候補を対象に k-means（k は候補数の平方根、上限 64）でクラスタリングし、`recClusters` に重心とラベルを保存する。ラベルは LLM に代表 5 記事のタイトルを渡して 1 回だけ生成する |
| FR-S-05 | クラスタリングは日次バッチとし、クラスタ ID の連続性を保つため前日の重心を初期値にする |

### 4.3 ランキング（FR-R）

| ID | 要件 |
|---|---|
| FR-R-01 | 有効な候補全件に対してスコアと不確実性を算出する |
| FR-R-02 | 枠の配分は既定で exploit 60% / adjacent 20% / uncertain 10% / random 10%。設定で変更可能だが、`uncertain + random` は 10% を下回れない |
| FR-R-03 | ランキング確定後に多様性制約を適用する。同一クラスタからの採用は 1 Briefing あたり最大 3 件、同一ドメインは最大 2 件 |
| FR-R-04 | 各提示について、スコア・不確実性・枠種別・propensity・モデルバージョン・特徴量スナップショットを `recImpressions` に保存する |
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
| FR-U-05 | 「興味なし」は理由の選択（テーマ違い / 既読 / 情報源が弱い / 内容が薄い）を任意で受け付ける |
| FR-U-06 | 「興味の現在地」パネルで、明示プロフィール・上位選好クラスタ（ラベルと代表記事）・否定クラスタ・現在の探索率を表示する |
| FR-U-07 | 過去の Briefing を日付で遡れる |
| FR-U-08 | 未操作カードはスクロールで画面内に入った時点で `viewed` イベントを記録する（IntersectionObserver） |

### 4.5 フィードバック収集（FR-F）

| ID | 要件 |
|---|---|
| FR-F-01 | 即時イベント（`viewed` / `clicked` / `saved` / `liked` / `dismissed`）を `recFeedbackEvents` に追記する。イベントは削除せず、取り消しも新しいイベントとして記録する |
| FR-F-02 | 遅延報酬を日次で join する。保存されたブックマークの `userReadingProgress.readingProgressPercent`、`highlights` の有無、`bookmarks.favourited`、リスト追加を、対応する impression に紐づける |
| FR-F-03 | 遅延報酬の観測窓は保存から 7 日。7 日経過後に確定させ、以後は更新しない |
| FR-F-04 | 既存ブックマーク（推薦経由でないもの）も、コールドスタート用の正例として学習に使えるよう `recImpressions` に `source='bootstrap'` として取り込める |

### 4.6 プロフィールと学習（FR-L）

| ID | 要件 |
|---|---|
| FR-L-01 | 4 種のプロフィールを保持し日次更新する — 明示 / 長期潜在 / 直近 7 日 / 否定 |
| FR-L-02 | 長期潜在プロフィールは全正例埋め込みの重心。直近プロフィールは半減期 7 日の指数減衰重み付き重心 |
| FR-L-03 | クラスタ選好は、クラスタごとの正例率をベータ分布で平滑化した値とする（事前分布 α=1, β=4） |
| FR-L-04 | モデルは `heuristic-v1` → `logreg-v1` → `bayes-logreg-v1` の順に昇格する。昇格条件を満たさない間は下位モデルを使う |
| FR-L-05 | モデル再学習は日次。新モデルは 7 日間シャドー評価（実提示には使わず予測のみ記録）し、既存モデルの AUC を上回った場合のみ昇格する |
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
recSources
  id, userId, kind('rss'|'hn'|'arxiv'|'github'|'custom'), config(json),
  profileIndependent(bool), enabled(bool), consecutiveFailures(int),
  lastFetchedAt, createdAt

recCandidates
  id, userId, sourceId, url, canonicalUrl, urlHash(unique per user),
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
  itemCount, generatedAt

recImpressions
  id, userId, briefingId, candidateId, rank, arm, shown(bool),
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

一方、候補プールは常時 3,000〜5,000 件程度。1,536 次元 Float32 なら 30 MB 弱で、Node で総当たりコサイン類似度を計算しても数十ミリ秒で終わる。**SQLite に BLOB で持ち、TypeScript で総当たり**するほうが、性能上のデメリットなしに upstream 追従コストを下げられる。

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
| `no_click`（提示されたが未操作） | -0.15 | 弱い負例。重みは意図的に小さい |

### 6.2 学習ラベル

二値分類の正例／負例と、サンプル重みに変換する。

```
strong_positive : saved | liked | favourited | highlighted | read_full
                    → label=1, weight=1.0
weak_positive   : clicked のみ（保存も読了もなし）
                    → label=1, weight=0.3
weak_negative   : 提示されたが未クリック
                    → label=0, weight=0.3
strong_negative : dismissed
                    → label=0, weight=1.5
```

「クリックしなかった」を強い負例にしない。表示位置・時間帯・見出しの弱さなど、興味以外の要因が混ざるため。

### 6.3 ポジションバイアスの扱い

表示順位 `rank` を **学習時のみ特徴量に含め**、推論時は `rank=1` に固定する。これにより「上に出たからクリックされた」分の寄与をモデルから切り離す。

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
| 9 | ソース種別（上位 8 ソースの one-hot + other） | 9 次元 |
| 10 | 一次情報フラグ（ドメインリスト判定） | bool |
| 11 | 新規性 = 1 − 既存ブックマークとの最大コサイン | real |
| 12 | 言語（ja / en / other） | 3 次元 |
| 13 | 曜日（平日 / 休日） | bool |
| 14 | タイトル長（正規化） | real |
| 15 | 本文長の推定値（対数） | real |
| 16 | `heuristic-v1` のスコア | real |
| 17 | 表示順位（学習時のみ） | real |

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
| NFR-05 | ストレージ増分は候補プール 30 MB + 年間ログ 50 MB 以内 |
| NFR-06 | 埋め込み API コストは 1 日 200 件 × 3,000 トークン以内 |
| NFR-07 | 推薦関連のメトリクスを既存 workers の `/metrics` に出す（候補数・提示数・クリック率・保存率・モデルバージョン・ジョブ失敗数） |
| NFR-08 | いずれかのワーカーが落ちても Briefing ページは前日分を表示できる |
| NFR-09 | 収集ジョブの失敗は Briefing の生成を止めない。候補が 1 件もない場合は空の Briefing を生成し、その旨を表示する |
| NFR-10 | 認証は既存の NextAuth に乗る。MCP Tool は既存の API キー機構を使う |
| NFR-11 | upstream への追従性のため、既存ファイルの変更は README に列挙した登録ポイントに限定する |
| NFR-12 | 全ログは `userId` 単位で削除できる（データ削除要求への対応） |

## 10. 制約と前提

- ユーザーは 1 名。学習データは年間 impression 約 7,300 件、正例約 1,000 件を見込む。**この規模がモデル選択の最大の制約**である
- karakeep の SQLite は `local-path` PV で d1（worker-1）にノード固定。推薦機能もこのノードに乗る
- Meilisearch は既存の検索・ベクトル用途のまま。推薦は Meilisearch に依存しない
- 埋め込みモデルは既存の推論設定（`InferenceClientFactory`）に従う。モデルを変えた場合は全候補の再埋め込みが必要で、その間はプロフィールとの比較が無効になる。モデル ID を `recCandidates` に記録し、混在時は再計算する
- Cloudflare Access の内側で運用するため、外部からの未認証アクセスは考慮しない

## 11. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| フィードバックループによる興味の固定化 | 探索が死に、暗黙知が出てこない | 収集の 20% をプロフィール非依存に固定。探索枠の下限 10%。多様性制約 |
| データ不足でモデルが過学習 | ヒューリスティックより悪化 | 昇格ゲート（正例 100 件・impression 2,000 件）とシャドー評価の 2 段構え |
| 遅延報酬の join 漏れ | 保存後の読了が学習に反映されない | 観測窓 7 日で確定させ、確定済みフラグを持つ。未確定 impression は学習から除外 |
| upstream の大きな変更との衝突 | rebase 不能 | 追加のみを原則とし、変更する既存ファイルを README に明記。定期的に upstream を取り込む |
| 埋め込み API の障害・モデル変更 | 候補が推薦できない | 埋め込み失敗候補は新着順フォールバックの対象に含める。モデル ID を記録 |
| 候補プールの肥大化 | SQLite の性能劣化 | 14 日で expire、90 日でパージ。候補数の上限アラートを Grafana に設定 |
| 「保存」以外の読了計測ができない | 報酬が保存に偏る | 外部リンクの滞在時間は計測しない設計とし、保存後の読了を主要な深度シグナルとして扱うことを明示 |

## 12. オフポリシー評価の準備

将来、過去ログから新モデルを評価できるようにするため、Phase 1 の時点から以下を必ず記録する。評価そのものは Phase 5 で実装する。

- 収集されたが提示されなかった候補（上位 100 件）
- 表示順位・表示時刻
- 推薦時のモデルバージョン
- **推薦確率 (propensity)**
- 探索か活用か（arm）
- 特徴量スナップショット
- その時点のプロフィールのハッシュ（`recProfiles` の履歴は持たず、ハッシュで同一性のみ判定）

propensity を後から復元することはできないため、これだけは初日から確実に保存する。
