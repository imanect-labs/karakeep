import logger from "@karakeep/shared/logger";

import { runBootstrap } from "./bootstrap";
import { runCollect } from "./collect";
import { runEmbed } from "./embed";
import { runRank } from "./rank";

export interface EnrollResult {
  bootstrapped: number;
  collected: number;
  embedded: number;
  briefingSize: number;
}

/**
 * 自己登録の初回パイプライン（FR-U-15）。
 *
 * **5 つを 1 ジョブで直列に流すのが要点。** ボタンを押して翌朝 05:30 まで
 * 何も起きないのはセルフサービスとして成立しないので当日中に Briefing を
 * 出すが、`bootstrap` / `collect` / `rank` を別ジョブとして投入すると壊れる。
 * `RecommenderQueue` は concurrency 1 の FIFO だが、`runCollect` は埋め込みを
 * `RecommenderEmbedQueue`（別ランナー）へ渡すので 2 つのキューの間に順序が
 * 無い。`rank` が埋め込み完了前に走ると `embedding` が null のままヒューリ
 * スティックに落ち、重複マークもクラスタも無い Briefing が出る ── 何も
 * 出ないより悪い。ここで直接呼べば順序は構成上保証される。
 *
 * 再試行しても安全。`runBootstrap` は明示的に冪等、`runCollect` は
 * `dropKnownDuplicates` + `onConflictDoNothing`、`runEmbed` は
 * `embeddingStatus='pending'` しか触らず、`runRank` の `upsertBriefing` は
 * 既存行を再利用してフィードバック済みの impression を保つ。
 *
 * `discover` は入れない。最も通信が重く（robots + トップページ + feed 探索を
 * 20 ドメイン）、価値は本人のブックマークからのドメイン発見なので、シードが
 * 初日の供給を担う以上は急がない。03:30 の cron で走る。
 */
export async function runEnroll(
  userId: string,
  jobId: string,
): Promise<EnrollResult> {
  const log = (msg: string) =>
    logger.info(`[recommender][enroll][${jobId}] ${msg}`);

  // ① 既存ブックマークを候補プールへ。プロフィールの材料になる。
  const bootstrap = await runBootstrap(userId, undefined, jobId);
  log(
    `bootstrap: scanned ${bootstrap.scanned}, imported ${bootstrap.imported}, ${bootstrap.positives} positives`,
  );

  // ② ライブラリ側のベクトル。新規性の特徴量の比較相手になるので、候補を
  //    集める前に埋めておく。
  const libraryEmbed = await runEmbed(userId, undefined, jobId);

  // ③ シード収集元から候補を取り込む。
  const collect = await runCollect(userId, jobId);
  log(
    `collect: ${collect.sourcesTried} sources, fetched ${collect.fetched}, inserted ${collect.inserted}`,
  );

  // ④ 候補のベクトル + 重複判定 + k-means。
  const candidateEmbed = await runEmbed(userId, undefined, jobId);

  // ⑤ Briefing。digest は runRank が自分で投入する。
  const rank = await runRank(userId, undefined, jobId);
  log(`rank: ${JSON.stringify(rank)}`);

  return {
    bootstrapped: bootstrap.imported,
    collected: collect.inserted,
    embedded: libraryEmbed.embedded + candidateEmbed.embedded,
    briefingSize: rank.shown,
  };
}
