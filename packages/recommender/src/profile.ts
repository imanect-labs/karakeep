import { createHash } from "node:crypto";

import { centroid, l2Normalize, weightedCentroid } from "./vector";

/**
 * 4 種のプロフィール（FR-L-01 / FR-L-02）。
 *
 * ユーザーの興味は 1 本のリストではなく 4 つのプロフィールで持つ。
 *
 * - 明示 — 手で書いたトピック
 * - 長期潜在 — 全正例埋め込みの重心（減衰なし）
 * - 直近 7 日 — 半減期 7 日の指数減衰つき重心
 * - 否定 — 「興味なし」にした記事の重心
 *
 * 「本人も言語化していないが、なぜか繰り返し読む話題」は長期潜在に残る。
 */

/** 直近プロフィールの半減期（日）。 */
export const RECENT_HALF_LIFE_DAYS = 7;

/** 重みがこの値を下回る正例は直近プロフィールから外す。 */
const RECENT_WEIGHT_FLOOR = 0.01;

export interface ProfileSample {
  vector: Float32Array;
  occurredAt: Date;
  /** 報酬。強い正例ほど重心を強く引く。 */
  weight?: number;
}

export interface Profiles {
  /** 全正例の重心。null は「正例がまだ 1 件も無い」。 */
  stable: Float32Array | null;
  recent: Float32Array | null;
  negative: Float32Array | null;
}

/**
 * 正例・負例のサンプルからプロフィールを組み立てる。
 *
 * 重心は L2 正規化して返す。候補との比較が内積で済み、しかも正例の件数が
 * 増えてもスケールが変わらない（件数でスコアの絶対値が動くと、しきい値が
 * 日ごとに意味を変えてしまう）。
 */
export function buildProfiles(
  positives: ProfileSample[],
  negatives: ProfileSample[],
  now: Date,
): Profiles {
  const stable = centroid(positives.map((p) => p.vector));

  const decayed = positives
    .map((p) => ({
      vector: p.vector,
      weight: (p.weight ?? 1) * halfLifeWeight(p.occurredAt, now),
    }))
    .filter((p) => p.weight >= RECENT_WEIGHT_FLOOR);

  return {
    stable: stable ? l2Normalize(stable) : null,
    recent: normalizeOrNull(weightedCentroid(decayed)),
    negative: normalizeOrNull(centroid(negatives.map((n) => n.vector))),
  };
}

function normalizeOrNull(vector: Float32Array | null): Float32Array | null {
  return vector ? l2Normalize(vector) : null;
}

/** 半減期 7 日の指数減衰。未来の日付は 1 として扱う。 */
export function halfLifeWeight(
  occurredAt: Date,
  now: Date,
  halfLifeDays = RECENT_HALF_LIFE_DAYS,
): number {
  const days = (now.getTime() - occurredAt.getTime()) / 86_400_000;
  if (days <= 0) {
    return 1;
  }
  return Math.pow(0.5, days / halfLifeDays);
}

/**
 * プロフィールの同一性を表すハッシュ（§12）。
 *
 * `recProfiles` の履歴は持たず、impression 側にこのハッシュを控える。
 * 「この impression を出したときのプロフィールは今と同じか」だけが分かれば、
 * 特徴量スナップショットと突き合わせてリークを検出できる。
 */
export function profileHash(profiles: Profiles): string {
  const hash = createHash("sha256");
  for (const vector of [profiles.stable, profiles.recent, profiles.negative]) {
    if (!vector) {
      hash.update("null");
      continue;
    }
    // 浮動小数の下位ビットの揺れでハッシュが変わらないよう、有効数字を
    // 落としてから混ぜる。
    hash.update(
      new Uint8Array(
        Float32Array.from(vector, (v) => Math.round(v * 1e4) / 1e4).buffer,
      ),
    );
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * クラスタ選好（FR-L-03）。クラスタ id から選好スコアを引く写像を作る。
 * 未知のクラスタは事前値を返す。
 */
export function clusterPreferenceLookup(
  preferences: Record<string, number> | null | undefined,
  prior = 0.2,
): (clusterId: string | null | undefined) => number {
  return (clusterId) => {
    if (!clusterId || !preferences) {
      return prior;
    }
    return preferences[clusterId] ?? prior;
  };
}
