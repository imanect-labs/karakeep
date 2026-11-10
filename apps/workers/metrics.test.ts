import { beforeEach, expect, test, vi } from "vitest";
vi.mock("@karakeep/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const schema = await import("@karakeep/db/schema");
  const db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "../../packages/db/drizzle" });
  return { db };
});
import { db } from "@karakeep/db";
import { users, recBriefings } from "@karakeep/db/schema";
import { registry } from "./metrics";
const value = async () => {
  const result = (await registry.getMetricsAsJSON()).find(
    (m) => m.name === "karakeep_recommender_last_briefing_timestamp_seconds",
  );
  return result?.values[0].value;
};
beforeEach(async () => {
  await db.delete(users);
  await db
    .insert(users)
    .values({ id: "u", name: "Test", email: "u@example.com" });
});
test("exports persisted completion time without any process counter increments", async () => {
  await db.insert(recBriefings).values([
    {
      id: "ready",
      userId: "u",
      briefingDate: "2026-11-10",
      status: "ready",
      generatedAt: new Date("2026-11-09T20:30:03Z"),
    },
    {
      id: "failed",
      userId: "u",
      briefingDate: "2026-11-11",
      status: "failed",
      generatedAt: new Date("2026-11-10T20:30:03Z"),
    },
    {
      id: "running",
      userId: "u",
      briefingDate: "2026-11-12",
      status: "generating",
      generatedAt: new Date("2026-11-11T20:30:03Z"),
    },
  ]);
  expect(await value()).toBe(Date.parse("2026-11-09T20:30:03Z") / 1000);
  await db
    .update(recBriefings)
    .set({ generatedAt: new Date("2026-11-09T20:31:00Z") });
  expect(await value()).toBe(Date.parse("2026-11-09T20:31:00Z") / 1000);
});
test("exports zero if there has never been a completed briefing", async () => {
  expect(await value()).toBe(0);
});
