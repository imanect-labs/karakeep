# feat(recommender): Briefing に日本語の訳題と要約を付ける

- 作業日時: 2026-08-09
- 対応内容:
  - `recCandidates` に `titleJa` / `summaryJa` / `digestStatus` / `digestModelId` を追加
    （migration `0095_briefing_japanese_digest.sql`）
  - `RECOMMENDER_DIGEST_PROVIDER`（`off` / `local` / `external`）と
    `_MODEL` / `_FETCH_BODY` / `_BODY_CHARS` を追加
  - `packages/shared/digest.ts` … プロンプト・パーサ・推論クライアント
  - `apps/workers/workers/recommender/digest.ts` … 本文取得と DB 書き戻し
  - `rank` の末尾で `digest` ジョブを enqueue（**待たない**）
  - tRPC `getBriefing` と `BriefingCard` に訳題・日本語要約を出す
  - メトリクス `karakeep_recommender_digests_total{outcome}`
  - 要件に FR-U-12 / FR-U-13 を追加
- 変更したファイル:
  - `packages/db/schema.ts`
  - `packages/db/drizzle/0095_briefing_japanese_digest.sql`
  - `packages/shared/config.ts`
  - `packages/shared/digest.ts` / `digest.test.ts`
  - `packages/shared-server/src/queues.ts`
  - `packages/shared-server/src/eventLogTypes.ts`
  - `packages/trpc/routers/recommender.ts`
  - `apps/workers/metrics.ts`
  - `apps/workers/workers/recommender/digest.ts` / `digest.test.ts`
  - `apps/workers/workers/recommender/index.ts`
  - `apps/workers/workers/recommender/rank.ts`
  - `apps/web/components/dashboard/briefing/BriefingCard.tsx`
  - `docs/briefing/requirements.md`
- 確認内容:
  - `pnpm typecheck`（shared / shared-server / db / trpc / workers / web）
  - `pnpm lint`、`pnpm format:fix`
  - vitest 12 件（プロンプト組み立て・JSON パース・本文選択・Readability 抽出）

## なぜ「表示が確定した 30 件」だけなのか

取り込みは 1 日 800 件（`RECOMMENDER_DAILY_INTAKE_CAP`）ある。候補プール全体に
訳題と要約を作ると 1 日 800 回の LLM 呼び出しになるが、そのうち実際に人が読むのは
`briefingSize` の 30 件だけで、**96% が捨てられる**。

rank が終わってから `shown=true` の 30 件にだけ生成する。結果は `recCandidates`
（impression ではなく候補）に持たせる。同じ記事が翌日も選ばれたときに再生成
しないため — キャッシュの単位は「記事」であって「その日の提示」ではない。

## なぜ rank の中で待たないのか

ローカル LLM（GTX 1650 / qwen3.5:4b）で 30 件に約 6 分かかる。rank の中で回すと、
推論サーバーが落ちている日や遅い日に **Briefing そのものが出なくなる**。
05:30 に原文のまま Briefing を出し、日本語は数分後に埋まる形にした。

生成に失敗した候補は `digestStatus='failure'` を書いて次へ進む。UI は原題と
元の要約に落ちる（NFR-09）。

## `think: false` が必須

qwen3.5 系はハイブリッド推論モデルで、既定では reasoning が `num_predict` を
食い潰し、**JSON が 1 件も出力されない**（実記事 14 件で 14/14 パース失敗）。
`think: false` を付けると 0/14 になる。ここが成否を分けるので、
`packages/shared/digest.ts` の該当行にコメントを残した。

`num_ctx` を 4096 にすると VRAM 4GB の GTX 1650 で ollama が OOM kill された。
2048 に固定している。

## プロンプトについて

2 行は実測の失敗に対する個別の手当てなので、短くしないこと。

- 「中国語の語彙(治理・信息など)は使わない」… qwen 系は「AI治理」「产品线」を混ぜる
- 「BODY が断片でも必ず要約を書く」… 「情報が不足していたら空にする」と書いた版では、
  本文が短い記事の要約が軒並み空になった

## 残課題

- `RECOMMENDER_DIGEST_PROVIDER` の既定は `off`。デプロイ側（giken-ops）で
  Ollama に `qwen3.5:4b` を置いてから `local` にする
- プロンプトを変えたときの再生成は手動（`digestModelId` はモデルしか見ていない）。
  モデル名を変えるか、列を NULL に戻して再実行する
- 全文翻訳のローカル化（テキストノード方式 + CAT-Translate）は別 PR
