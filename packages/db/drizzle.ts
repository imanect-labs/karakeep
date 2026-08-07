import "dotenv/config";

import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import serverConfig from "@karakeep/shared/config";

import dbConfig from "./drizzle.config";
import { instrumentDatabase } from "./instrumentation";
import * as schema from "./schema";

const sqlite = new Database(dbConfig.dbCredentials.url);

if (serverConfig.database.walMode) {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
} else {
  sqlite.pragma("journal_mode = DELETE");
}
sqlite.pragma("cache_size = -65536");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("temp_store = MEMORY");

instrumentDatabase(sqlite);

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

/**
 * SQLite のハンドルを明示的に閉じる。
 *
 * 閉じずにプロセスを終えると、better-sqlite3 の `Statement` が Node の
 * 環境破棄後にファイナライズされ、`RemoveEnvironmentCleanupHook(env=nullptr)`
 * で abort する（exit 134）。プリペアドステートメントが多いほど確実に踏む。
 *
 * 長生きするプロセス（web / workers）は終了時に OS がまとめて片付けるので
 * 問題にならないが、**短命なスクリプトは必ずこれを呼ぶこと**。
 */
export function closeDatabase() {
  sqlite.close();
}

export function getInMemoryDB(runMigrations: boolean) {
  const mem = new Database(":memory:");
  const db = drizzle(mem, { schema, logger: false });
  if (runMigrations) {
    migrate(db, { migrationsFolder: path.resolve(__dirname, "./drizzle") });
  }
  return db;
}
