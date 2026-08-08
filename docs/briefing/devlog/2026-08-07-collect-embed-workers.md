# feat(recommender): collectWorker / embedWorker と日次スケジューラ

- 作業日時: 2026-08-07
- 対応フェーズ: Phase 1 統合実装 / B. 候補収集（後半）

## 対応内容

### キューと設定

- `RecommenderQueue`（discover / collect / rank / train / reward_join /
  maintain / bootstrap）と `RecommenderEmbedQueue` の 2 本。日次バッチは
  時刻をずらして走るので直列で足りる。埋め込みだけ 1 ジョブが長いので
  並列度を独立させた
- `RECOMMENDER_*` の設定を追加。**既定値は ROADMAP の「段階的な有効化」
  前半 2 週（trial 0% / random 15%）に合わせてある**。10% に上げるのは
  config の変更だけで済む
- `RECOMMENDER_ENABLED=false` のあいだは cron を 1 つも登録しない。既存の
  デプロイに影響しない

### `collectWorker`

- 取得対象は「ドメインの取得層から見て期限が来ているソース」。ドメインを
  持たない全体ソース（HN / arXiv / GitHub）は毎日
- `since` には `lastFetchedAt` ではなく **`lastSuccessfulFetchAt`** を渡す。
  失敗した試行で時計を進めると、失敗している間に流れた記事を取りこぼす
- 1 ソースの失敗で収集全体を止めない。連続 5 回で無効化
- ドメインあたり 1 リクエスト / 5 秒。夜間バッチなので待たされて困らない
- **記事のドメイン行をここで作る**。RSS ならソースと同じドメインだが、
  アグリゲータ経由の記事はどこから来るか分からない。`discovered` として
  登録することが D4（ドメイン標本）そのものになる。品質ゲートと昇格は
  discoverWorker の仕事で、ここは証拠を残すだけ
- 重複判定はこの段階では URL とタイトルのハッシュだけ。プール全体を読まず、
  今日の分のハッシュで引き当てる。埋め込み近傍は embedWorker 側

### `embedWorker`

- バッチ単位で埋め込み、バッチが失敗しても他のバッチは続ける。1 バッチの
  失敗でジョブを落とすと、その日の候補が丸ごと埋め込みなしになる
- 近傍重複の比較相手は**同じ `embeddingModelId` の候補だけ**。モデルを
  差し替えた直後は空間が違うので、混ぜると無意味な近傍が出る
- k-means は前日の重心を初期値に渡し、`recClusters` の行 id を再利用する。
  行 id を保つことが「クラスタ ID の連続性」の実体で、ラベルと選好スコアが
  そこにぶら下がっている
- k が減っても旧クラスタ行は消さず `size=0` にする。過去の impression が
  `clusterId` を参照しているため

### `maintain`

expire・パージ・取得層の振り直し。

**要件から 1 点動かした。パージで「提示されたことのある候補」は消さない。**
要件は「ログ整合のため 90 日間は削除しない」だが、`recImpressions.candidateId`
は cascade delete なので、素直に消すと学習データそのものが消える。提示された
候補は候補プールの一部ではなく**ログの一部**なので保持する。提示されなかった
候補（大半）はこれで消えるので、プールは膨らまない。

## 見つけた不具合: 埋め込みが静かに壊れる

疎通確認で `duplicatesMarked` の数が合わず、掘ったところ**本番でも起きる
バグ**だった。

`OpenAI SDK` の `embeddings.create()` は `encoding_format` を明示しないと
**既定で `"base64"` を送り、返ってきた値を無条件に base64 として復号する**。
素の float 配列を返すサーバ（Ollama の `/v1/embeddings`、TEI、多くのローカル
実装）に当てると、**例外にならずに壊れたベクトルが返る**。

実際、8 次元のベクトルが 2 次元に化け、全候補が同一ベクトルになり、すべてが
互いの重複と判定されていた。EmbeddingGemma を Ollama で自ホストする構成は
まさにこの経路なので、気づかなければそのまま本番に入っていた。

対処を 2 つ入れた。

1. `encoding_format: "float"` を明示する
2. `embedDocuments` で次元数を検算する。16 次元未満、またはバッチ内で
   次元が食い違う応答は例外にする

2 を入れたのは、この失敗が**例外ではなく「やたら短いベクトル」として現れる**
から。検算が無いと、無意味なベクトルが候補プールに溜まり続けて推薦が静かに
壊れる。

## 変更したファイル

- `packages/shared-server/src/queues.ts`（キュー 2 本）
- `packages/shared-server/src/eventLogTypes.ts`（イベント種別）
- `packages/shared/config.ts`（`RECOMMENDER_*`）
- `packages/shared/embedding.ts`（`encoding_format` の明示）
- `packages/recommender/src/embedding/client.ts`（次元の検算）
- `apps/workers/workers/recommender/{index,shared,collect,embed,maintain}.ts`（新規）
- `apps/workers/index.ts`（ワーカー登録）
- `apps/workers/metrics.ts`（Prometheus カウンタ 3 つ）
- `apps/workers/package.json`

## 確認内容

- `pnpm --filter @karakeep/recommender test` — 141 件 pass
- `typecheck` / `lint` / `format` — recommender / shared / shared-server /
  workers / db すべて pass
- **疎通確認（使い捨て SQLite ＋ ローカル HTTP サーバ）**
  - RSS 収集: 3 件のエントリのうち、`?utm_source=rss` 付きと `www.` +
    末尾スラッシュの変種が 1 件に畳まれて 2 件になること
  - Hacker News: 実 API に対して 57 件取得、`url` が null の Ask HN は除外
  - 未購読ドメイン 43 件が `discovered` として登録され、`aggregator` の
    発見証跡が入ること
  - 壊れたフィード: `consecutiveFailures=1`、他ソースの処理は継続
  - 同日の再実行: 挿入 0 件・重複 59 件（べき等）
  - `maintain`: 期限切れ 59 件が `expired` に
  - 埋め込み（OpenAI 互換のローカル偽サーバ）: 6 件を埋め込み、3 組の
    近傍重複を検出、クラスタが 2 回目の実行でも同じ id のまま

## 残課題

- `discover` / `rank` / `train` / `reward_join` / `bootstrap` は警告を出して
  何もしない状態（次以降）
- `scrape` アダプタは Phase 1 では未実装
- robots.txt の尊重は、実際に HTML をクロールする discoverWorker 側で入れる
