/**
 * 候補プールへの日次取り込み配分（FR-C-03 / FR-D-16 / FR-D-16b）。
 *
 * ここが設計上いちばん効く歯止めになる。取り込み件数を全体で固定し、
 * ドメインの事後平均で配分することで、**候補プールのサイズをドメイン数から
 * 切り離す**。ドメインが 80 件でも 300 件でも、埋め込みコストもランキング
 * 時間も SQLite のサイズも変わらない。
 */

/** 1 日に候補プールへ入れる件数の上限（FR-D-16b）。 */
export const DEFAULT_DAILY_INTAKE_CAP = 400;

/** プロフィール非依存ソースの下限比率（FR-C-03）。設定で下回れない。 */
export const PROFILE_INDEPENDENT_FLOOR = 0.2;

/**
 * 配分に使う重みの下限。事後平均が 0 に張り付いたドメインでも、購読して
 * いるあいだは取り込みを完全には止めない。
 *
 * 悪いドメインを追い出す仕組みは降格（FR-D-15）であって、兵糧攻めではない。
 * 取り込みが 0 になると新しい記事が入らず、事後が更新されず、良くなったか
 * どうかを二度と確かめられない状態で購読席だけ占め続けることになる。
 */
const MIN_WEIGHT = 0.01;

export interface IntakeBucket {
  /** 配分の単位。実装上は sourceId。 */
  id: string;
  /**
   * 配分の重み。ドメインのベータ事後平均を渡す。未知ドメインは事前値 0.2。
   * 0 以下は 0 として扱う（重み 0 のバケットは余りが出たときだけ拾われる）。
   */
  weight: number;
  /** そのソースから今日取得できた新着の件数。これを超えては配れない。 */
  available: number;
  /** プロフィール非依存ソースか。フィードバックループへのハードフロア。 */
  profileIndependent: boolean;
}

export interface IntakeOptions {
  totalCap?: number;
  profileIndependentFloor?: number;
}

/**
 * 各バケットに何件取り込むかを決める。
 *
 * 配分は D'Hondt 方式（最大商法）。1 件ずつ `weight / (割当済み + 1)` が最大の
 * バケットへ渡す。比例配分がそのまま出るうえ、上限（`available`）を超えない
 * ことが構造的に保証され、端数処理の恣意性も入らない。
 *
 * プロフィール非依存の枠は**先に確保してから**残りを全体に配る。後から
 * 帳尻を合わせる方式だと、事後の高いドメインが強いときに下限を割る。
 */
export function allocateIntake(
  buckets: IntakeBucket[],
  opts: IntakeOptions = {},
): Map<string, number> {
  const totalCap = opts.totalCap ?? DEFAULT_DAILY_INTAKE_CAP;
  const floorRatio = opts.profileIndependentFloor ?? PROFILE_INDEPENDENT_FLOOR;

  const allocation = new Map<string, number>();
  for (const b of buckets) {
    allocation.set(b.id, 0);
  }

  const totalAvailable = buckets.reduce(
    (sum, b) => sum + Math.max(0, b.available),
    0,
  );
  if (totalCap <= 0 || totalAvailable === 0) {
    return allocation;
  }

  // 上限に届いていない日は、そもそも配分の問題が発生しない。全部取る。
  if (totalAvailable <= totalCap) {
    for (const b of buckets) {
      allocation.set(b.id, Math.max(0, b.available));
    }
    return allocation;
  }

  const independent = buckets.filter((b) => b.profileIndependent);
  const independentAvailable = independent.reduce(
    (sum, b) => sum + Math.max(0, b.available),
    0,
  );
  // 下限は「確保したい量」であって「取れない量まで確保する」ではない。
  // 非依存ソースが枯れている日に全体の枠を空けたままにしない。
  const reserved = Math.min(
    Math.ceil(totalCap * floorRatio),
    independentAvailable,
  );

  distribute(independent, allocation, reserved);
  const remaining = totalCap - sumAllocated(allocation);
  distribute(buckets, allocation, remaining);

  return allocation;
}

function sumAllocated(allocation: Map<string, number>): number {
  let total = 0;
  for (const v of allocation.values()) {
    total += v;
  }
  return total;
}

/** D'Hondt 方式で `budget` 件を配る。既存の割当量を引き継いで積み増す。 */
function distribute(
  buckets: IntakeBucket[],
  allocation: Map<string, number>,
  budget: number,
): void {
  if (budget <= 0) {
    return;
  }

  for (let given = 0; given < budget; given++) {
    let bestId: string | null = null;
    let bestQuotient = -Infinity;

    for (const b of buckets) {
      const current = allocation.get(b.id) ?? 0;
      if (current >= Math.max(0, b.available)) {
        continue;
      }
      const quotient = Math.max(MIN_WEIGHT, b.weight) / (current + 1);
      // 同点は id 順で決める。日ごとに配分が揺れないようにするため。
      if (
        quotient > bestQuotient ||
        (quotient === bestQuotient && bestId !== null && b.id < bestId)
      ) {
        bestQuotient = quotient;
        bestId = b.id;
      }
    }

    if (bestId === null) {
      // 全バケットが上限に達した。
      return;
    }
    allocation.set(bestId, (allocation.get(bestId) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------------------
// 取得頻度の 3 層化 (FR-D-16)
// ---------------------------------------------------------------------------

export type FetchTier = "daily" | "every3days" | "weekly";

const TIER_INTERVAL_HOURS: Record<FetchTier, number> = {
  daily: 20,
  every3days: 68,
  weekly: 164,
};

/**
 * 購読ドメインを事後平均で 3 層に分ける。上位 25% は毎日、中位 50% は 3 日
 * ごと、下位 25% は週 1。ドメインが増えてもクロール総量が線形に増えない。
 */
export function assignFetchTiers(
  domains: { id: string; posteriorMean: number }[],
): Map<string, FetchTier> {
  const tiers = new Map<string, FetchTier>();
  if (domains.length === 0) {
    return tiers;
  }

  // 事後の高い順。同点は id 順で決めて、日ごとに層が入れ替わらないようにする。
  const sorted = [...domains].sort(
    (a, b) => b.posteriorMean - a.posteriorMean || (a.id < b.id ? -1 : 1),
  );
  const topEnd = Math.ceil(sorted.length * 0.25);
  const midEnd = Math.ceil(sorted.length * 0.75);

  sorted.forEach((d, i) => {
    tiers.set(
      d.id,
      i < topEnd ? "daily" : i < midEnd ? "every3days" : "weekly",
    );
  });
  return tiers;
}

/**
 * そのドメインを今日取りにいくか。
 *
 * 間隔をぴったり 24 / 72 / 168 時間にすると、ジョブが数分遅れた日に 1 日
 * まるごと飛ぶ。少し短めに取ってある。
 */
export function isDueForFetch(
  tier: FetchTier,
  lastCrawledAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!lastCrawledAt) {
    return true;
  }
  const elapsedHours = (now.getTime() - lastCrawledAt.getTime()) / 3_600_000;
  return elapsedHours >= TIER_INTERVAL_HOURS[tier];
}
