# Briefing Recommender

karakeep に「毎朝の記事レコメンド」機能を追加するための設計ドキュメント一式。

## これは何か

毎朝の morning briefing で「自分の興味リスト」を LLM に手渡す運用には、2 つの限界がある。

1. **リストに書いた興味でも、実際に読む記事はごく一部** — 明示した興味と実際の関心はずれる。
2. **リストに書いていない興味は永久に浮上しない** — 本人も言語化していない暗黙の関心が拾えない。

この機能は、記事の候補プールを毎日ためて、**推薦モデル**でランキングし、karakeep に 1 ページ追加した Briefing 画面で提示する。ユーザーの反応（開いた／保存した／いいねした／読み進めた／興味なしにした）を記録し、そのログでモデルを更新していく。

LLM は学習の主体ではない。**LLM はオーケストレーター、推薦モデルは意思決定器、DB は記憶**という役割分担にする。

## なぜ karakeep の中に作るのか

別サービスとして作らず、この fork の中に実装する。karakeep には既に必要な部品がほぼ揃っているため。

| 必要なもの | karakeep の既存資産 |
|---|---|
| 埋め込み生成 | `apps/workers/workers/embeddingsWorker.ts` + `InferenceClientFactory` |
| ベクトル格納 | `packages/plugins/vectorstore-meilisearch`（Meilisearch は既にクラスタで稼働） |
| ジョブキュー | `packages/plugins/queue-liteque`（SQLite ベース、追加ミドルウェア不要） |
| RSS 取得 | `apps/workers/workers/feedWorker.ts` |
| 認証 / ユーザー | NextAuth + `apiKeys` テーブル（Cloudflare Access の内側で二段構え） |
| 読了進捗 | `userReadingProgress`（`readingProgressPercent`） |
| 明示的な正例 | `bookmarks.favourited` / `highlights` / `tagsOnBookmarks` / `bookmarksInLists` |
| 記事の保存先 | ブックマーク作成 API（推薦記事の「保存」がそのまま既存機能に着地する） |
| リーダービュー | `apps/web/app/reader/[bookmarkId]`（保存後の読了計測がタダで手に入る） |
| メトリクス | workers の `/metrics`（Prometheus + Grafana は giken-ops 側で稼働中） |
| LLM 連携口 | `apps/mcp`（MCP サーバ。briefing エージェントに Tool を生やせる） |

**最大の利点はコールドスタートの解消**にある。既存のブックマーク・お気に入り・タグ・読了進捗が、初日から学習データになる。ゼロから始める独立サービスにはこれがない。

## 何を作らないか

会話ベースの構想から、1 人運用の自宅サーバーという現実に合わせて以下を削った。詳細な理由は [requirements.md](./requirements.md) の「対象外」を参照。

- **LinUCB / Neural Contextual Bandit / 本格的な強化学習** — データ量が足りない。1 日 20 件提示・年間 7,300 impression、正例は年 1,000 件程度。この規模で回せるのは正則化つきロジスティック回帰までで、それ以上は分散のほうが大きい。
- **LightGBM / Python 推論サービス** — TS モノレポに Python ランタイムを持ち込むコストに見合わない。ベイジアンロジスティック回帰は TypeScript で 200 行程度、外部依存なしで書ける。
- **収集プロンプトの自動最適化** — Phase 5 まで凍結する。推薦モデルと収集器を同時に自動更新すると、性能変化の原因が特定できなくなる。
- **毎日の LLM 検索エージェントによる候補収集** — Phase 1 では決定的なソース（RSS / HN / arXiv 等）に限定する。コストと再現性のため。

## 全体像

```
┌────────────────────────────────────────────────────────────────┐
│ 候補収集 (recCollectWorker) — 毎日 04:00                        │
│   RSS / Hacker News / arXiv / GitHub Trending                  │
│   うち一定割合はプロフィール非依存（フィードバックループ対策）      │
└───────────────────────────┬────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ 正規化・重複排除・埋め込み (recEmbedWorker)                       │
│   URL 正規化 → コンテンツハッシュ → 埋め込み近傍で重複クラスタ化   │
│   → recCandidates (embedding は Float32 BLOB として SQLite に)  │
└───────────────────────────┬────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ ランキング (recRankWorker) — 毎日 05:30                          │
│   特徴量抽出 → モデル推論 → 探索枠の混合 → recBriefings /        │
│   recImpressions（score・uncertainty・propensity・モデル版を保存）│
└───────────────────────────┬────────────────────────────────────┘
                            ▼
┌──────────────────────────┴─────────────────────────────────────┐
│                          │                                      │
▼                          ▼                                      │
Briefing ページ            MCP Tools (Phase 4)                    │
/dashboard/briefing        rank_articles / get_interest_state /   │
（開く・保存・いいね・      explain_article_score /                │
  興味なし）                record_article_feedback                │
│                          （morning briefing エージェントが呼ぶ）  │
└──────────────────────────┬─────────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────────┐
│ フィードバック記録 (recFeedbackEvents)                           │
│   即時: impression / click / save / like / dismiss              │
│   遅延: 保存後の readingProgressPercent / highlight / favourite  │
│         を夜間ジョブで impression に join                        │
└───────────────────────────┬────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ 学習 (recTrainWorker) — 毎日 03:00                              │
│   プロフィール更新（長期 / 直近 / 否定）+ モデル再学習            │
│   → recProfiles / recModels（バージョン管理、シャドー評価つき）    │
└────────────────────────────────────────────────────────────────┘
```

## モデルの段階

いきなりバンディットを回さない。データが貯まるまでは学習しても意味がないので、3 段階に分ける。

| 段階 | 中身 | 発動条件 |
|---|---|---|
| `heuristic-v1` | プロフィール埋め込みとのコサイン類似度 + 鮮度 + 多様性制約による決め打ちスコア | 初日から |
| `logreg-v1` | L2 正則化ロジスティック回帰（約 20 特徴量）。ヒューリスティックスコアを 1 特徴として含む | 正例 100 件以上かつ impression 2,000 件以上 |
| `bayes-logreg-v1` | 上記にラプラス近似で事後分散を持たせ、Thompson Sampling で探索 | `logreg-v1` がシャドー評価でヒューリスティックを上回った時 |

段階が上がる条件は自動判定し、満たさない間は下位モデルにフォールバックする。詳細は [ROADMAP.md](./ROADMAP.md) の判断ゲートを参照。

## 暗黙知を掘り出す仕組み

推薦枠を分割し、「確信度は高くないが不確実性が大きい記事」を必ず一定数混ぜる。ここが暗黙の興味の発見枠になる。

| 枠 | 割合（既定） | 選び方 |
|---|---|---|
| 活用 (exploit) | 60% | 予測スコア上位 |
| 隣接 (adjacent) | 20% | 正例クラスタの近傍だが未提示のクラスタ |
| 不確実 (uncertain) | 10% | 予測分散が大きい順 |
| 無作為 (random) | 10% | プロフィール非依存にサンプリング |

ユーザーの興味は 1 本のリストではなく、4 つのプロフィールで保持する。

- **明示プロフィール** — 手で書いたトピック（`recProfiles.explicitTopics`）
- **潜在プロフィール** — 好反応記事の埋め込み重心（長期、指数減衰なし）
- **一時プロフィール** — 直近 7 日の好反応の重心（減衰つき）
- **否定プロフィール** — 明示的に「興味なし」にした記事の重心

「本人も言語化していないが、なぜか繰り返し読む話題」は潜在プロフィールと `recClusters` の選好スコアに残る。Briefing ページの「興味の現在地」パネルで、潜在クラスタの代表記事とラベルを人間が読める形で提示する。

## フィードバックループへの対策

放置すると「似た記事を集める → 似た記事しかクリックされない → 似た記事が好きだと学習する」という自己強化ループに入る。以下を仕様として固定する。

1. **収集段階の 20% はプロフィール非依存**（固定ソースからの新着をそのまま入れる）
2. **探索枠は最低 10% を常に確保**（モデルがどれだけ自信を持っていても削らない）
3. **同一クラスタは 1 日 3 件まで**という多様性制約をランキング後に適用
4. **提示されなかった候補もログに残す**（オフポリシー評価の母集団になる）
5. **推薦確率 (propensity) を保存**する。将来 IPS/SNIPS で過去ログから新モデルを評価するのに必須

## クリックを報酬にしない

クリックだけを報酬にすると、扇情的なタイトルと既知の興味ばかりが強化される。報酬は合成値を保存せず、**生イベントを分解して記録**し、重みは設定ファイルで後から変えられるようにする。

```
reward = explicit_feedback      # いいね / 保存 / 興味なし
       + reading_depth          # 保存後の readingProgressPercent
       + return_behavior        # 後日の再訪・ハイライト
       + novelty_bonus          # 既存ブックマークとの非類似度
       - repetition_penalty     # 同一クラスタの連続提示
```

「クリックしなかった」は弱い負例として扱う（重み 0.3）。表示位置・時間帯・見出しの弱さなど、興味以外の要因が混ざるため。表示順位は学習時のみ特徴量に入れ、推論時は 1 位固定にすることでポジションバイアスを外す。

## ディレクトリ構成（実装時）

upstream への追従を壊さないため、**追加のみ**を原則とする。既存ファイルへの変更は登録ポイントに限定する。

```
packages/recommender/          # 新規パッケージ（モデル・特徴量・スコアリング）
  src/features.ts              #   特徴量抽出
  src/model/logreg.ts          #   ベイジアンロジスティック回帰（依存なし）
  src/model/heuristic.ts       #   Phase 1 のスコアリング
  src/profile.ts               #   4 種プロフィールの更新
  src/reward.ts                #   報酬分解と重み設定
  src/vector.ts                #   Float32 BLOB のシリアライズ・総当たりコサイン

apps/workers/workers/recommender/
  collectWorker.ts             #   候補収集
  embedWorker.ts               #   候補の埋め込み
  rankWorker.ts                #   日次ランキング生成
  trainWorker.ts               #   プロフィール更新・モデル再学習
  rewardJoinWorker.ts          #   遅延報酬の join

packages/trpc/routers/recommender.ts   # Briefing ページ用の tRPC ルータ
apps/web/app/dashboard/briefing/       # 追加する 1 ページ
apps/mcp/src/tools/recommender.ts      # MCP Tool（Phase 4）
packages/db/drizzle/00XX_recommender.sql  # 追加マイグレーション

# 既存ファイルへの変更（コンフリクトしうる登録ポイント）
packages/db/schema.ts          # rec* テーブルの追加（ファイル末尾に追記）
apps/workers/index.ts          # ワーカー登録
packages/trpc/routers/_app.ts  # ルータ登録
apps/web/components/**/Sidebar # ナビゲーション項目
packages/shared/config.ts      # 設定項目
```

テーブルはすべて `rec` プレフィックスをつける。fork 由来のスキーマだと一目で分かるようにし、upstream のマイグレーションとの衝突も避ける。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [requirements.md](./requirements.md) | 機能要件・データモデル・報酬設計・API/Tool 仕様・非機能要件・対象外 |
| [ROADMAP.md](./ROADMAP.md) | フェーズ分割・完了条件・判断ゲート・手動作業の手順書 |

## 開発の始め方

```bash
pnpm install
pnpm db:generate          # スキーマ変更後にマイグレーション生成
pnpm db:migrate
pnpm dev                  # web + workers
pnpm preflight            # typecheck / lint / format
```

推薦まわりだけを動かす場合:

```bash
pnpm --filter @karakeep/recommender test
pnpm --filter @karakeep/workers run start   # ワーカーのみ
```

## デプロイ

giken-ops の ArgoCD で管理している karakeep スタックにそのまま乗る。この fork をビルドして GHCR に push し、`gitops/apps/karakeep/values.yaml` の `web.image.tag` を sha タグでピン止めする流れは既存のとおり。

推薦機能は SQLite / Meilisearch / liteque を既存インスタンスと共有するため、**新しいミドルウェアの追加は不要**。ストレージ増分は候補プール約 30 MB + 年間ログ約 50 MB を見込む。
