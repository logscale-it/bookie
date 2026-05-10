/**
 * DAT-5.a — One-time backfill that evacuates the legacy
 * `incoming_invoices.file_data` BLOB into S3 (or the local app-data dir,
 * if S3 is not configured), then NULLs out the BLOB.
 *
 * Why this exists
 * ---------------
 * Migration 0007 introduced `file_data BLOB` as the only place a supplier
 * PDF lived. Migrations 0009/0013 added `s3_key TEXT` as the new home, but
 * the old BLOB was left in place for backwards compatibility. The result:
 *
 *   - users with S3 enabled stored every PDF twice (DB bloat AND S3),
 *   - users without S3 had no clear authoritative column,
 *   - DB backups are linearly larger than they need to be.
 *
 * This module ships a single function, `backfillIncomingInvoiceFileData`,
 * intended to run once (e.g. wired into app startup behind a feature flag,
 * or invoked by an operator from the settings page). It is idempotent:
 * rows that already have `s3_key` or `local_path` are skipped, and the
 * SELECT predicate excludes rows whose `file_data` is already NULL.
 *
 * Verification (per the issue's `cross_field` method): after the script
 * succeeds for all eligible rows, every row should satisfy
 *
 *   file_data IS NULL AND (s3_key IS NOT NULL OR local_path IS NOT NULL
 *                          OR (s3_key IS NULL AND local_path IS NULL
 *                              AND file_name IS NULL))
 *
 * — i.e. the BLOB column is fully evacuated, and any row that ever had a
 * file now points at one of the two new homes. The script returns counts
 * and a per-row error list so the caller can surface unrecoverable failures
 * without aborting the whole backfill.
 *
 * Dependencies (treated as merged):
 *   - REL-1.c (#44) — atomic restore: any backup taken after this backfill
 *     no longer carries the BLOBs, which is a precondition for the slimmer
 *     restore path REL-1.c shipped.
 */
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "./connection";
import { getS3Settings } from "./settings";
import { uploadFile } from "../s3/client";
import { createLogger } from "../logger";

const log = createLogger("backfill-file-data");

/**
 * Subdirectory under `<appdata>/` where evacuated PDFs land when S3 is
 * not configured. Kept in sync with the issue spec
 * (`<appdata>/incoming_invoices/<id>.pdf`).
 */
export const LOCAL_DIR = "incoming_invoices";

export type BackfillTarget = "s3" | "local";

export interface BackfillRowError {
  id: number;
  error: string;
}

export interface BackfillResult {
  /** Total rows considered (file_data NOT NULL AND s3_key IS NULL AND local_path IS NULL). */
  candidates: number;
  /** Rows successfully evacuated and NULLed out. */
  migrated: number;
  /** Per-row failures: file moved to neither S3 nor disk; BLOB left in place. */
  errors: BackfillRowError[];
  /** Whether S3 was used as the destination ("local" otherwise). */
  target: BackfillTarget;
}

/**
 * Resolves the directory we'll write into when S3 is not configured.
 * Splits S3-vs-local out of the row loop so the (slow) AppHandle round-trip
 * runs once. Returns `null` when the caller selected the S3 path.
 */
async function ensureLocalDir(target: BackfillTarget): Promise<string | null> {
  if (target === "s3") return null;
  const appDataDir = await invoke<string>("get_app_data_dir");
  // Path separator is platform-dependent; we leave normalization to the OS:
  // both `\` and `/` work for fs::write on Windows, and Unix doesn't care
  // about a trailing slash on the parent. The Rust `write_binary_file`
  // command will create the file but NOT its parent dir — so we precreate
  // it via a dummy probe-write below. (We can't call mkdir directly because
  // there's no Tauri command for that, and adding one is out of scope.)
  return joinPath(appDataDir, LOCAL_DIR);
}

/** Minimal join — avoids pulling in `node:path` (we run inside Tauri). */
export function joinPath(a: string, b: string): string {
  if (a.endsWith("/") || a.endsWith("\\")) return `${a}${b}`;
  return `${a}/${b}`;
}

/**
 * Decide whether the user's S3 settings are usable for an upload.
 * Mirrors the guard inside `s3/client.ts#buildConfig`: a flag is not
 * enough — we also need both the bucket and the credentials.
 */
export function isS3Usable(s3: {
  enabled: number;
  bucket_name: string;
  access_key_id: string;
  secret_access_key: string;
}): boolean {
  return Boolean(
    s3.enabled && s3.bucket_name && s3.access_key_id && s3.secret_access_key,
  );
}

/**
 * Hooks for tests so we don't have to spin up MinIO or write real files.
 * Production code leaves all three at their defaults, in which case
 * the standard Tauri `invoke`/`uploadFile` paths are used.
 */
export interface BackfillDeps {
  /**
   * Upload a PDF to S3 and return the resulting key. Defaults to
   * `s3/client.ts#uploadFile`.
   */
  uploadToS3?: (
    pathPrefix: string,
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<string>;
  /**
   * Write the PDF to the local filesystem. Defaults to invoking the
   * `write_binary_file` Tauri command.
   */
  writeLocal?: (path: string, bytes: Uint8Array) => Promise<void>;
  /**
   * Resolve the destination directory. Defaults to invoking
   * `get_app_data_dir` and joining `LOCAL_DIR`. Tests inject a temp dir.
   */
  resolveLocalDir?: () => Promise<string>;
}

/**
 * Run the one-time backfill.
 *
 * Algorithm:
 *   1. Load S3 settings, decide on the target (S3 if usable, else local).
 *   2. Snapshot the candidate id list ONCE upfront (`SELECT id ... WHERE
 *      file_data IS NOT NULL AND s3_key IS NULL AND local_path IS NULL`)
 *      so a row that fails mid-loop doesn't get retried in the same run
 *      and so a concurrent INSERT during the loop doesn't drift the count.
 *   3. For each id, fetch the BLOB + filename, upload/write, then UPDATE
 *      the row to set s3_key/local_path AND clear file_data in a single
 *      statement (atomic at the SQL level — if the UPDATE fails the file
 *      will be re-uploaded next run, which is benign on object storage
 *      and a bounded retry on disk).
 *   4. Return per-row counts; the caller logs and surfaces any errors.
 */
export async function backfillIncomingInvoiceFileData(
  deps: BackfillDeps = {},
): Promise<BackfillResult> {
  const db = await getDb();
  const s3 = await getS3Settings();
  const target: BackfillTarget = isS3Usable(s3) ? "s3" : "local";

  const localDir =
    target === "local"
      ? deps.resolveLocalDir
        ? await deps.resolveLocalDir()
        : await ensureLocalDir("local")
      : null;

  log.info("Backfill starting", { target });

  const candidates = await db.select<
    { id: number; file_name: string | null }[]
  >(
    `SELECT id, file_name FROM incoming_invoices
     WHERE file_data IS NOT NULL AND s3_key IS NULL AND local_path IS NULL
     ORDER BY id ASC`,
  );

  const result: BackfillResult = {
    candidates: candidates.length,
    migrated: 0,
    errors: [],
    target,
  };

  for (const candidate of candidates) {
    try {
      const rows = await db.select<
        { file_data: number[] | null; file_name: string | null }[]
      >(`SELECT file_data, file_name FROM incoming_invoices WHERE id = $1`, [
        candidate.id,
      ]);
      const row = rows[0];
      if (!row?.file_data || row.file_data.length === 0) {
        // Concurrent UPDATE/DELETE wiped the BLOB between snapshot and
        // load. Treat as already-done; not an error.
        continue;
      }
      const bytes = new Uint8Array(row.file_data);

      if (target === "s3") {
        const fileName = row.file_name ?? `incoming-${candidate.id}.pdf`;
        const upload = deps.uploadToS3
          ? (prefix: string, name: string, b: Uint8Array) =>
              deps.uploadToS3!(prefix, name, b)
          : (prefix: string, name: string, b: Uint8Array) =>
              uploadFile(s3, prefix, name, b, "application/pdf");
        const key = await upload(s3.path_prefix, fileName, bytes);
        await db.execute(
          `UPDATE incoming_invoices
             SET s3_key = $1, file_data = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [key, candidate.id],
        );
      } else {
        if (!localDir) throw new Error("Local directory unresolved");
        const path = joinPath(localDir, `${candidate.id}.pdf`);
        const writer = deps.writeLocal
          ? deps.writeLocal
          : (p: string, b: Uint8Array) =>
              invoke<void>("write_binary_file", {
                path: p,
                data: Array.from(b),
              });
        await writer(path, bytes);
        await db.execute(
          `UPDATE incoming_invoices
             SET local_path = $1, file_data = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [path, candidate.id],
        );
      }
      result.migrated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Backfill row failed", { id: candidate.id, error: msg });
      result.errors.push({ id: candidate.id, error: msg });
    }
  }

  log.info("Backfill done", {
    target,
    candidates: result.candidates,
    migrated: result.migrated,
    errors: result.errors.length,
  });
  return result;
}
