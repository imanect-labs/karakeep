import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { closeDatabase, db } from "./drizzle";

migrate(db, { migrationsFolder: "./drizzle" });

// 短命なスクリプトなので、SQLite のハンドルは明示的に閉じてから終える。
closeDatabase();
