/**
 * OBS-3.b: boot-time schema version check + recovery state.
 *
 * Wraps the `schema_version_check` Tauri command (added by OBS-3.a, PR #159)
 * with a frontend-only narrowing layer that detects the
 * `BookieError::MigrationOutOfDate` rejection and surfaces it as a typed
 * shape the UI dialog can render.
 *
 * We deliberately avoid importing the cross-cutting `BookieError` mirror
 * (`src/lib/shared/errors.ts`, OBS-2.c, PR #153) for two reasons:
 *   1. PR #153 was authored before PR #159 changed `MigrationOutOfDate` from
 *      a unit variant to a struct variant carrying `{actual, expected}`. The
 *      mirror in #153 still types it as a unit variant. Until that mirror is
 *      reconciled with #159, this module needs its own narrow parser that
 *      accepts both the historical unit shape and the new struct shape — so
 *      the dialog renders correctly regardless of which PR lands first.
 *   2. The dialog only needs one error variant; pulling in the full mirror
 *      would couple boot-blocking UX to an evolving cross-cutting type.
 */

import { invoke } from "@tauri-apps/api/core";

import { getDb } from "$lib/db/connection";

/**
 * Narrow shape of the `MigrationOutOfDate` rejection. Matches the Rust
 * `BookieError::MigrationOutOfDate { actual, expected }` variant introduced
 * by OBS-3.a (PR #159) when serialized via `#[serde(tag = "kind")]`.
 *
 * Rust contract (PR #159 `src-tauri/src/lib.rs`):
 *   `{"kind":"MigrationOutOfDate","actual":<i64>,"expected":<i64>}`
 *
 * `actual` / `expected` are optional here so we degrade gracefully if
 * #159 has not yet landed and the legacy unit-variant shape arrives:
 *   `{"kind":"MigrationOutOfDate"}`
 */
export type MigrationOutOfDateError = {
  kind: "MigrationOutOfDate";
  actual?: number;
  expected?: number;
};

export type SchemaCheckResult =
  | { ok: true }
  | { ok: false; error: MigrationOutOfDateError }
  | { ok: false; error: { kind: "Unknown"; message: string } };

/**
 * Type guard: does this rejection look like
 * `BookieError::MigrationOutOfDate`? Accepts either the unit-variant shape
 * (legacy / pre-PR-#159) or the struct-variant shape (post-PR-#159).
 *
 * Tauri's command bridge can deliver the rejection as a parsed object or as
 * a JSON string holding the serialized `BookieError`; we accept both.
 */
export function parseMigrationOutOfDate(
  value: unknown,
): MigrationOutOfDateError | null {
  let candidate: unknown = value;

  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  if (candidate === null || typeof candidate !== "object") return null;
  const obj = candidate as {
    kind?: unknown;
    actual?: unknown;
    expected?: unknown;
  };
  if (obj.kind !== "MigrationOutOfDate") return null;

  const actual = typeof obj.actual === "number" ? obj.actual : undefined;
  const expected = typeof obj.expected === "number" ? obj.expected : undefined;
  return { kind: "MigrationOutOfDate", actual, expected };
}

/**
 * Best-effort fallback string for non-MigrationOutOfDate errors. Used for
 * logging / a generic "boot failed" branch — the dialog itself is only
 * mounted on the MigrationOutOfDate path.
 */
function describeUnknown(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Boot-time chokepoint:
 *   1. Force `Database.load()` (which is when `tauri-plugin-sql` actually
 *      applies pending migrations) by calling `getDb()`.
 *   2. Invoke the OBS-3.a `schema_version_check` Tauri command, which opens
 *      a side rusqlite connection and asserts
 *      `_sqlx_migrations.MAX(version) == EXPECTED_SCHEMA_VERSION`.
 *
 * Returns a discriminated union so the layout can render the recovery
 * dialog on `MigrationOutOfDate` and let everything else through.
 */
export async function runSchemaVersionCheck(): Promise<SchemaCheckResult> {
  // Step 1: trigger migrations. If the plugin itself fails (e.g. corrupt
  // file), surface that as an unknown so the layout can decide whether to
  // still show the dialog. We keep it generous because the dialog's two
  // recovery actions (restore from backup, save app data and exit) are
  // useful for ANY DB-side boot failure, not only the version-mismatch
  // path.
  try {
    await getDb();
  } catch (err) {
    const mod = parseMigrationOutOfDate(err);
    if (mod) return { ok: false, error: mod };
    return {
      ok: false,
      error: { kind: "Unknown", message: describeUnknown(err) },
    };
  }

  // Step 2: ask the backend whether the on-disk version matches the
  // version this binary was compiled against.
  try {
    await invoke("schema_version_check");
    return { ok: true };
  } catch (err) {
    const mod = parseMigrationOutOfDate(err);
    if (mod) return { ok: false, error: mod };
    return {
      ok: false,
      error: { kind: "Unknown", message: describeUnknown(err) },
    };
  }
}
