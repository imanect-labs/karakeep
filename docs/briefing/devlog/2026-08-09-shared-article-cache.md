# feat(recommender): ダイジェストと埋め込みを urlHash でユーザ間共有する

- 作業日時: 2026-08-09
- 対応内容:
  - `recArticleCache`（`urlHash` を PK、`userId` を持たない）を追加
  - `embed` / `digest` を cache-aside にした
  - `maintain` に共有キャッシュの掃除を足した
  - メトリクスに `shared` ラベルを追加
  - 要件に FR-S-06 を追加
- 変更したファイル:
  - `packages/db/schema.ts` / `packages/db/drizzle/0096_recommender_shared_article_cache.sql`
  - `apps/workers/workers/recommender/articleCache.ts` / `articleCache.test.ts`
  - `apps/workers/workers/recommender/embed.ts`
  - `apps/workers/workers/recommender/digest.ts`
  - `apps/workers/workers/recommender/maintain.ts`
  - `apps/workers/workers/recommender/index.ts`
  - `apps/workers/metrics.ts` は変更なし（既存カウンタのラベル値を増やしただけ）
  - `packages/shared-server/src/eventLogTypes.ts`
  - `docs/briefing/requirements.md`
- 確認内容:
  - vitest 103 件（`apps/workers`。うち新規 10 件）
  - `pnpm typecheck` / `lint` / `format`（monorepo 全体、pre-commit フック）
- 残課題:
  - 実際の共有率は 2 人目が登録されるまで測れない。
    `karakeep_recommender_digests_total{outcome="shared"}` を見る

## なぜ要るのか

社内の複数人に配るための地ならし。**推薦の中身は何も変えていない。**

日本語ダイジェストも埋め込みも「その記事が何であるか」だけで決まり、**誰が
読むかに依存しない**。ところが `recCandidates` は `(userId, urlHash)` 一意
なので、ユーザーごとに別の行になる。全員が同じ収集元を使う以上、候補プールは
ほぼ同一になり、**5 人なら同じ記事を 5 回訳して 5 回埋め込む**。

`qwen3.5:4b` を CPU で ~30 秒/件、`concurrency: 1` で回している。
`briefingSize` が 50 なので:

| | 朝のダイジェスト |
|---|---|
| 共有なし・5 人 | 5 × 25 分 = **125 分**（05:30 開始 → 07:35） |
| 共有あり・5 人 | 重なった分だけ 1 回。定常で 60〜75 分 |

**2 人目が登録される前にこれを入れる必要がある。** 後回しにすると、初めての
複数人運用の朝が 2 時間超になる。1 人のうちは純粋なオーバーヘッドだが、
それでいい。

## 設計: cache-aside にした

`recCandidates` から digest / embedding を正規化して切り出す案は却下した。
読み出し側が `rank.ts` の `loadRankableCandidates`、`embed.ts` の
`markNearDuplicates` と `recluster`、`profiles.ts` の 6 箇所、
`trpc/routers/recommender.ts` と、**4 ファイル 10 箇所**あって全部 JOIN になる。
しかも `clusterId` / `duplicateOfId` / `sourceId` / `status` / `bookmarkId` は
どうやってもユーザー固有なので、中途半端に正規化された行が残るだけ。
得られるのは 10Gi PVC 上の 1GB 弱。割に合わない。

採ったのは、`urlHash` を PK にした表を足して**生成の前に引き、後に書く**だけ。
読み出しの正本は候補行のままで、ランキングも UI もこの表を知らない。
影響範囲はワーカー 2 つとマイグレーション 1 本。

`recArticleCache` に `userId` が無いのは意図的で、**それがこの表の存在理由
そのもの**。`users` への FK も `relations` の登録も無い。

## 次元を別に持つ理由（これが一番危ない）

`OllamaEmbeddingClient.modelId` は `` `ollama/${model}` `` で、
**`RECOMMENDER_EMBEDDING_DIMENSIONS` を含まない**。次元は `embedDocuments` が
後から MRL 切り詰めで適用するので、768 → 512 の変更は**モデル ID からは
見えない**。

これは今の `recCandidates` にもある潜在バグだが、そちらは 1 ユーザー分が
まとめて壊れるだけ。共有キャッシュに持ち込むと**次元の違うベクトルを別の
ユーザーへ配る**ことになるので、`embeddingDimensions` 列を別に持って照合する。
書くときは `cfg.embeddingDimensions ?? result.vector.length`（未設定なら
モデルが決めた実寸を記録する）。設定していないときはモデルが次元を決めるので、
モデル ID の一致だけで足りる。

テストは判定を純関数（`isDigestCacheHit` / `isEmbeddingCacheHit`）に切り出して
そこに当てた。**次元だけ変わってモデル ID が同じケース**を必ず含めている ──
黙って壊れる唯一の経路がそこなので。

## プライバシー: 書くのは collected だけ、読むのは bootstrap も

キャッシュへ**書く**のは `origin='collected'` の候補由来だけにした。
`origin='bootstrap'` は本人のブックマークから取り込んだものなので、
`urlHash` の行が在ること自体が「このインスタンスの誰かがこの URL を保存した」
という信号になる。

**読むのは bootstrap にも許している。** 読んでも何も漏れない ── その行は既に
誰かの収集結果として存在しているので、読むことで新しく生まれる情報が無い。
書き込みだけが信号を作る。

禁止のコストは bootstrap の一度きり ≤2000 行 × 0.30 秒 ≒ 10 分/人。無視できる。

`digest` 側にこの判定は要らない。`loadRankableCandidates` が
`origin='collected'` で絞っているので、bootstrap 由来が `shown` になる経路が
そもそも無い。理由をコメントで残した。

## 共有で埋めた候補も freshlyEmbedded に入れる

キャッシュヒットした候補を `freshlyEmbedded` へ push し忘れると、
**その候補だけ重複マークも k-means のクラスタ割り当ても付かない**。
`markNearDuplicates` と `recluster` の入力がここなので、ヒット側も同じ配列に
入れる必要がある。ベクトルは BLOB を `deserializeVector` して渡す。

## 失敗はキャッシュしない

`digest` の `failure` と `skipped` は書かない。失敗はたいてい本文取得の
一時的な問題（`fetchArticleText` の 15 秒タイムアウト、一時的な 5xx）で、
それを全ユーザーへ配ると**再試行の経路が消える**。1 人が踏んだ一時障害で
5 人全員が永久に原文のままになるのは割に合わない。

## 掃除

`maintain` に `purgeArticleCache` を足した。`coalesce(lastUsedAt, createdAt)`
が `candidatePurgeDays` より古い行を消す。`lastUsedAt` は生成時にも入るので、
一度も再利用されなかった行も同じ物差しで落ちる。無いと 1 日 5MB 程度で
無限に伸びる。

共有キャッシュはユーザーに紐づかないので、誰の maintain で掃除しても同じ。
冪等なので 5 人分が重複して走っても害はない。

## メトリクス

`shared` を既存の `cached` と**別のラベル値**にした。`cached` は「同一
ユーザーが以前生成したもの」（翌日も同じ記事が選ばれたケース）で、`shared` は
「別ユーザーが生成したものを貰った」。混ぜると、ユーザー間共有が実際に
効いているかを測れない。
