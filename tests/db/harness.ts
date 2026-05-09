import { Database as BunSqlite } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS_DIR = resolve(
  import.meta.dir,
  "../../src-tauri/migrations",
);

/**
 * Test-only adapter that mimics the subset of `@tauri-apps/plugin-sql`'s
 * `Database` interface used by `src/lib/db/*`. Backed by an in-memory
 * `bun:sqlite` so each test gets a clean schema with the real production
 * migrations applied.
 */
export interface TestDb {
  select<T = unknown[]>(sql: string, params?: unknown[]): Promise<T>;
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rowsAffected: number; lastInsertId: number | undefined }>;
  close(): Promise<void>;
  raw: BunSqlite;
}

function listUpMigrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => {
      if (name.endsWith("_down")) return false;
      const full = join(MIGRATIONS_DIR, name);
      return statSync(full).isDirectory() && /^\d+$/.test(name);
    })
    .sort();
}

function readMigrationSql(dir: string): string {
  const full = join(MIGRATIONS_DIR, dir);
  const files = readdirSync(full)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();
  return files.map((f: string) => readFileSync(join(full, f), "utf8")).join("\n");
}

function paramsToBindings(params: unknown[] | undefined): Record<string, unknown> {
  if (!params || params.length === 0) return {};
  const out: Record<string, unknown> = {};
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    // bun:sqlite cannot bind booleans directly — store as 0/1 like Tauri does.
    out[`$${i + 1}`] =
      typeof v === "boolean" ? (v ? 1 : 0) : (v as never);
  }
  return out;
}

export function createTestDb(): TestDb {
  const raw = new BunSqlite(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");

  for (const dir of listUpMigrationDirs()) {
    const sql = readMigrationSql(dir);
    try {
      raw.exec(sql);
    } catch (err) {
      throw new Error(
        `Migration ${dir} failed: ${(err as Error).message}\n--- SQL ---\n${sql}`,
      );
    }
  }

  return {
    raw,
    async select<T = unknown[]>(sql: string, params?: unknown[]): Promise<T> {
      return raw.query(sql).all(paramsToBindings(params) as never) as T;
    },
    async execute(sql: string, params?: unknown[]) {
      const stmt = raw.query(sql);
      const result = stmt.run(paramsToBindings(params) as never);
      return {
        rowsAffected: result.changes,
        lastInsertId:
          result.lastInsertRowid === undefined ||
          result.lastInsertRowid === null
            ? undefined
            : Number(result.lastInsertRowid),
      };
    },
    async close() {
      raw.close();
    },
  };
}
