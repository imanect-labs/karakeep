import { sql } from "drizzle-orm";

import { db } from "@karakeep/db";
import { recSources } from "@karakeep/db/schema";
import { buildUserAgent } from "@karakeep/recommender";
import serverConfig from "@karakeep/shared/config";

/**
 * 推薦機能を有効にしているユーザー。1 人運用が前提だが、テーブルは `userId`
 * を持つので列挙できるようにしておく。
 *
 * 「収集元を 1 つでも登録している」を有効の signal とする。専用のフラグを
 * 足すより、ソースが無ければ何も起きないという自然な条件のほうが良い。
 */
export async function recommenderUserIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: recSources.userId })
    .from(recSources);
  return rows.map((r) => r.userId);
}

export function recommenderFetchContext(overrides: {
  limit: number;
  since?: Date | null;
  signal?: AbortSignal;
}) {
  return {
    fetch: globalThis.fetch,
    userAgent: buildUserAgent(serverConfig.recommender.contactUrl),
    ...overrides,
  };
}

/**
 * SQLite への書き込みは 200 件ずつに切る（NFR-04）。1 トランザクションを
 * 大きくすると、同時に走っている crawler が `database is locked` を踏む。
 */
export const DB_CHUNK_SIZE = 200;

export function chunk<T>(items: T[], size = DB_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * ローカル日付を `YYYY-MM-DD` で返す。`recBriefings.briefingDate` の型。
 * timestamp にすると「その日の briefing」の同一性がタイムゾーンに引きずられる。
 */
export function localDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** ベータ事後の平均。未知ドメインは事前分布 Beta(1, 4) の 0.2 になる。 */
export function posteriorMean(alpha: number, beta: number): number {
  const total = alpha + beta;
  return total > 0 ? alpha / total : 0.2;
}

/**
 * ドメインあたり 1 リクエスト / 5 秒（FR-D-16c）。
 *
 * 収集は夜間の一括処理なので、待たされても困らない。相手のサーバーに
 * 迷惑をかけてブロックされるほうがはるかに高くつく。
 */
export class DomainThrottle {
  private lastRequestAt = new Map<string, number>();

  constructor(private readonly minIntervalMs = 5000) {}

  async wait(domain: string): Promise<void> {
    const last = this.lastRequestAt.get(domain);
    const now = Date.now();
    if (last !== undefined) {
      const elapsed = now - last;
      if (elapsed < this.minIntervalMs) {
        await sleep(this.minIntervalMs - elapsed);
      }
    }
    this.lastRequestAt.set(domain, Date.now());
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `IN (...)` を SQLite のパラメータ上限に収まる大きさに割る。 */
export const IN_CLAUSE_CHUNK = 400;

export const nowSql = sql`(unixepoch())`;
