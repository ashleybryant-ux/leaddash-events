import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "../../drizzle/schema";
import { ENV } from "./env";

export type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;
let _sqlite: Database.Database | null = null;

function migrationsFolder() {
  // Source checkout (dev, tests) or the built dist/ folder next to drizzle/.
  const candidates = [
    path.resolve(import.meta.dirname, "../../drizzle/migrations"),
    path.resolve(import.meta.dirname, "../drizzle/migrations"),
    path.resolve(process.cwd(), "drizzle/migrations"),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, "meta", "_journal.json"))) ?? candidates[0];
}

/** The database. Opened on first use; pending migrations run before anything else. */
export function getDb(): DB {
  if (_db) return _db;
  const file = ENV.databasePath;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  _sqlite = new Database(file);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  _sqlite.pragma("busy_timeout = 5000");
  _db = drizzle(_sqlite, { schema });
  migrate(_db, { migrationsFolder: migrationsFolder() });
  return _db;
}

/** Raw SQLite handle (transactions, backups). */
export function getSqlite() {
  getDb();
  return _sqlite!;
}

/**
 * Tests: a fresh in-memory database built straight from the schema files, so
 * tests never depend on generated migrations.
 */
export async function useTestDb(): Promise<DB> {
  // The CommonJS build: the ES module build of drizzle-kit/api cannot load under Vitest.
  const { createRequire } = await import("node:module");
  const kit = "drizzle-kit/api";
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = createRequire(import.meta.url)(kit);
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const empty = await generateSQLiteDrizzleJson({});
  const full = await generateSQLiteDrizzleJson(schema as unknown as Record<string, unknown>);
  const statements = await generateSQLiteMigration(empty, full);
  for (const s of statements) sqlite.exec(s);
  _sqlite = sqlite;
  _db = drizzle(sqlite, { schema });
  return _db;
}

export { schema };
