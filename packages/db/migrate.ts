import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { closeDatabase, db } from "./drizzle";

migrate(db, { migrationsFolder: "./drizzle" });

// 閉じずに終えると、better-sqlite3 の Statement が Node の環境破棄後に
// ファイナライズされて abort する（exit 134）。s6 はこれを
// 「init-db-migration の起動失敗」とみなし、web と workers が延々と
// 再起動を繰り返す。マイグレーション自体は成功しているのに、コンテナが
// 永久にヘルシーにならない。
closeDatabase();
