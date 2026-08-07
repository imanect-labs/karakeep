# feat(recommender): lay the foundation — vector layer, embedding provider split, rec\* schema

- 作業日時: 2026-08-07
- 対応フェーズ: Phase 1 統合実装 / A. 基盤

## 対応内容

### `packages/recommender` の新設と `vector.ts`

埋め込みベクトルを SQLite の BLOB として持ち回す層を実装した。書き込み時に
必ず L2 正規化し、ランキング時のコサインを内積に落とす。

- Float32 の直列化・復元をリトルエンディアン固定にした。SQLite ドライバが
  共有プールから切り出す `Buffer` は `byteOffset` が 4 の倍数とは限らず、
  `Float32Array` はアラインメントを要求するため、揃っていなければコピーする
  経路を用意した（この分岐が無いと本番でだけ落ちる）
- `truncateMRL` は切り詰めたあとに必ず再正規化する。切ると L2 ノルムが 1 で
  なくなり、内積がコサインでなくなるため
- `topK` は全件ソートではなく k 件保持の線形走査にした
- ゼロベクトル・空集合で NaN を返さないことをテストで固定した。正例が 1 件も
  ない初日でも特徴量抽出が落ちてはいけない

### 埋め込みプロバイダの分離（FR-S-00）

これが Phase 1 全体の前提条件。upstream の `InferenceClientFactory` は
プロバイダを 1 つしか選べず、埋め込みもチャットと同じ `OPENAI_BASE_URL` へ
送られる。現行の値は OpenCode Go（チャット補完のリレー）で `/embeddings` を
提供しないため、**このままでは埋め込みが 1 件も作れない**。

- `EMBEDDING_PROVIDER` / `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` を追加
- `packages/shared/embedding.ts` に `EmbeddingClientFactory` を新設。
  OpenAI 互換と Ollama ネイティブの 2 経路を持つ
- `EMBEDDING_BASE_URL` 未設定時は推論プロバイダにフォールバックするので、
  **upstream の構成は挙動が変わらない**
- `modelId`（例 `ollama/embeddinggemma`）を返す。候補ごとに記録して、モデル
  差し替え時に再計算対象を見分ける
- 既存の `embeddingsWorker` も新しいファクトリ経由に切り替えた。ブートストラップ
  で既存ブックマークの埋め込みが要るため

### 埋め込み入力の整形（FR-S-01 / FR-S-01b）

EmbeddingGemma の規定書式 `title: {title | "none"} | text: {…}` に整形し、
2,048 トークン以内に収める。

- 正確な Gemma トークナイザは持ち込まず、文字種別の係数で多めに見積もる。
  用途は「上限を割らない」ことだけなので、切り詰めすぎることはあっても
  モデル側で黙って切られることはない向きに倒した
- トークン上限とは別に本文の文字数上限を置いた。英語は 1 トークンあたりの
  文字数が多く、トークン上限だけだと本文が 4,000 文字以上通る。そうなると
  話題ではなく細部が効きはじめる
- 要約と本文冒頭が重複しているソース（crawler の description が本文第 1 段落
  そのまま）は要約だけ残す

### `rec*` テーブル 10 種とマイグレーション

`packages/db/schema.ts` の末尾に追記し、`0094_recommender_tables.sql` を生成。
分割せず 1 回のマイグレーションで済ませた。

設計から動かした点が 1 つある。**ブートストラップした既存ブックマークを
`recCandidates` に `origin='bootstrap'` / `status='promoted'` として入れる**
ことにした。プロフィール重心の計算が候補もブックマークも同じ 1 本のクエリで
済み、埋め込みの持ち方も 1 通りになる。

要件から追加したカラム:

| カラム | 理由 |
|---|---|
| `recDomains.lastSelectedAt` | 埋没判定（60 日選ばれなければ降格）に必要。`examined` の蓄積に依存しない基準 |
| `recDomains.fetchTier` | 取得頻度の 3 層化 |
| `recCandidates.embeddingModelId` | モデル混在の検出 |
| `recImpressions.domainStatusAtImpression` / `domainAlpha` / `domainBeta` | 提示時点のドメイン状態。後から復元できない（§12） |
| `recImpressions.profileHash` / `featureSchemaVersion` | リーク防止と特徴量スキーマの世代管理 |
| `recImpressions.source` | ブートストラップ由来を `examined` の分母から外すため |

`recFeedbackEvents` に `(impressionId, eventType, occurredAt)` の一意制約を
置いた。MCP 経由と UI 経由で同じイベントが二重計上されるのを防ぐ。

## 変更したファイル

- `packages/recommender/**`（新規）
- `packages/shared/embedding.ts`（新規）
- `packages/shared/config.ts`
- `packages/shared/inference.ts`（パーサ 2 つを export しただけ）
- `packages/db/schema.ts`
- `packages/db/drizzle/0094_recommender_tables.sql`（新規）
- `apps/workers/workers/embeddingsWorker.ts`

## 確認内容

- `pnpm --filter @karakeep/recommender test` — 44 件 pass
- 総当たり内積のベンチ（5,000 件 × 768 次元）が 50 ms 以内。これは NFR-01 の
  前提そのものなので、テストとして固定した
- `typecheck` — db / shared / recommender / workers すべて pass
- `lint` / `format` — pass
- 空の DB に対して全マイグレーションを適用し、`rec*` 10 テーブルの作成を確認

## 残課題

- Ollama + EmbeddingGemma のデプロイは giken-ops 側（未着手）
- クロスリンガル整合の検証（手動作業）は Ollama デプロイ後
- B. 候補収集以降は未着手
