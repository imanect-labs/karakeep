# feat(recommender): 日本語ダイジェストを 1 回の呼び出しでまとめて作れるようにする

- 作業日時: 2026-08-15
- 対応内容:
  - `RECOMMENDER_DIGEST_BATCH_SIZE`（既定 1 = 単発、現状動作）を追加
  - `DIGEST_BATCH_SYSTEM_PROMPT` / `buildBatchDigestUserPrompt` /
    `parseBatchDigestResponse` を `packages/shared/digest.ts` に追加
  - `DigestClient` に任意メソッド `completeBatch` を生やし、**external でだけ**実装する
  - `runDigest` を「キャッシュ判定と本文取得を先に済ませる → まとめて投げる →
    欠けた ID だけ単発で作り直す」に組み替え
- 変更したファイル:
  - `packages/shared/config.ts`
  - `packages/shared/digest.ts` / `digest.test.ts`
  - `apps/workers/workers/recommender/digest.ts`
  - `docs/briefing/requirements.md`
  - `docs/briefing/devlog/2026-08-15-digest-batch.md`
- 確認内容:
  - `pnpm typecheck`（shared / workers）、`pnpm lint`、`pnpm format:fix`
  - vitest: shared 16 件（バッチのプロンプト組み立てと 4 形のパース）/ workers 5 件
  - 本番の候補 46 件を使って OpenCode Go (mimo-v2.5) に実際に投げ、
    N=6 / 10 / 20 のトークン・遅延・欠落・字数を実測（下記）
- 残課題:
  - 実運用の失敗率は `karakeep_recommender_digests_total` と、ログの
    `single-call fallbacks` で見る。フォールバックが常に出るようならプロンプトを見直す

## なぜバッチにするのか

giken-cluster ではダイジェストをローカル Ollama（d1 の CPU）で作っていて、
**05:30 から 35 分間、worker-1 の 4 vCPU をほぼ使い切っていた**（Prometheus 実測で
約 3.7 コア、Proxmox 側で d1 のホスト CPU の 55%）。物理的にファンが唸る。

外部プロバイダ（OpenCode Go / mimo-v2.5）に出すと 1 件 2.5 秒で済むが、50 件を
そのまま単発で投げるのは呼び出し回数が多い。まとめて投げられるならそのほうがよい。

## 実測

本番 DB の候補（本文 1000 字、本番と同じプロンプト）を mimo-v2.5 に投げた結果。

| 方式 | 1 件あたり tok | 1 件あたり秒 | 返却 | 要約字数 中央値/最大 |
|---|---:|---:|---|---|
| 単発 | 677 | 2.5 | — | 約 100 |
| 10 件バッチ | 491 | 1.43 | 10/10 | 160 / 182 |
| 20 件バッチ | 409 | 1.18 | 20/20 | 97 / 121 |
| ローカル qwen3.5:4b（現状） | — | 約 24 | — | 平均 133 / 最大 206 |

トークンは 10 件バッチで **約 28% 減**。件数の取りこぼしは 2 回とも 0 件だった。

## `response_format: json_schema` は当てにできない

最初の試行では strict な json_schema で `{"items": [...]}` を要求したのに、
`{"1": {...}, "2": {...}}` が返ってきた。**プロバイダが schema を無視する。**

そこで 2 つ手を打った。

1. 出力の形を**システムプロンプトの本文にも**書く（これで `items` に安定した）
2. `parseBatchDigestResponse` を 4 つの形すべて読めるようにする
   （`items[]` / 別キーの配列 / ID をキーにした object / 素の配列）

ID は候補 ID や URL ではなく**グループ内の 1 始まりの通し番号**にした。長い ID を
モデルに書き写させると写し間違いが混ざる。整数なら取り違えても検出できる。

## 部分的な成功を許す

バッチの一番の危険は「1 件の取りこぼしで N 件が巻き添えになる」ことなので、
パーサは読めたものだけ返し、`runDigest` が**欠けた ID を単発で作り直す**。
呼び出し例外（タイムアウト・5xx）でも同じで、group 全体が単発に落ちるだけで
結果は単発運用と同じになる。落ちた件数はログの `single-call fallbacks` に出す。

## local ではバッチを使わない

`DigestClient.completeBatch` は external にしか生やしていない。ローカルの
Ollama は `num_ctx=2048` で、本文 1000 字を数件並べただけで溢れて後ろの記事が
丸ごと切れる。`RECOMMENDER_DIGEST_BATCH_SIZE` を上げても local では 1 に落ちる。

## バッチサイズの上限

出力は 1 件あたり約 170 トークン。`INFERENCE_MAX_OUTPUT_TOKENS`（giken-cluster は
8192）を超えると応答が途中で切れて JSON が読めず、そのグループが丸ごと単発に
落ちる。**正しさは保たれるが遅くなる**ので、上限の 1/200 くらいを目安にすること。
運用値は 10。
