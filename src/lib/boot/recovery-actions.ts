/**
 * OBS-3.b: recovery actions for the MigrationOutOfDate boot dialog.
 *
 * Two flows:
 *   - `goToRestore()`: navigate to the existing restore UI under
 *     `/einstellungen/backup`. The restore page already wires the
 *     `restore_database` Tauri command, so the dialog only needs to send
 *     the user there; it does not duplicate the restore logic.
 *   - `saveAppDataAndClose()`: invoke the existing `backup_database`
 *     Tauri command (returns the raw SQLite file bytes), prompt the user
 *     for a save location via `@tauri-apps/plugin-dialog`'s `save()`, write
 *     the bytes via `write_binary_file`, then close the window.
 *
 * The save action is the verification step the issue calls out: "clicking
 * 'App-Daten sichern und schließen' produces a copy of the DB file in the
 * user's chosen location."
 */

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Mirror of the backend `BackupPayload` returned by `backup_database`. */
type BackupPayload = { file_name: string; bytes: number[] };

/**
 * Test seam: dependency-injection record for the side effects this module
 * performs (Tauri commands, file dialog, window close). The defaults wire
 * real Tauri APIs; tests pass stubs.
 *
 * Each field is a stable function reference so a `vi.fn()`/`mock(...)` can
 * stand in cleanly without monkey-patching the Tauri singletons.
 */
export type RecoveryDeps = {
  /** Calls `invoke('backup_database')` → returns the SQLite bytes. */
  backupDatabase: () => Promise<BackupPayload>;
  /** Opens a native save dialog; returns the chosen path or null on cancel. */
  pickSavePath: (defaultFileName: string) => Promise<string | null>;
  /** Calls `invoke('write_binary_file', { path, data })`. */
  writeFile: (path: string, data: number[]) => Promise<void>;
  /** Closes the current Tauri window (terminates the app). */
  closeWindow: () => Promise<void>;
};

export const defaultRecoveryDeps: RecoveryDeps = {
  backupDatabase: () => invoke<BackupPayload>("backup_database"),
  pickSavePath: (defaultFileName) =>
    save({
      title: "App-Daten sichern",
      defaultPath: defaultFileName,
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    }),
  writeFile: (path, data) => invoke("write_binary_file", { path, data }),
  closeWindow: () => getCurrentWindow().close(),
};

/**
 * Outcome of `saveAppDataAndClose`. The dialog uses this to render a
 * status message instead of swallowing failures silently.
 *   - `saved`: file written and window close was issued.
 *   - `cancelled`: user dismissed the save dialog; window stays open.
 *   - `failed`: backup or write failed; the dialog stays mounted with an
 *     error message so the user can retry or pick the restore flow.
 */
export type SaveOutcome =
  | { kind: "saved" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

/**
 * Pull the live DB into memory, ask the user where to put a copy, write
 * it, then close the app. Pure aside from the injected deps — passing a
 * stub `RecoveryDeps` makes every branch deterministic in tests.
 */
export async function saveAppDataAndClose(
  deps: RecoveryDeps = defaultRecoveryDeps,
): Promise<SaveOutcome> {
  let payload: BackupPayload;
  try {
    payload = await deps.backupDatabase();
  } catch (err) {
    return { kind: "failed", message: describeError(err) };
  }

  let path: string | null;
  try {
    path = await deps.pickSavePath(payload.file_name);
  } catch (err) {
    return { kind: "failed", message: describeError(err) };
  }
  if (!path) return { kind: "cancelled" };

  try {
    await deps.writeFile(path, payload.bytes);
  } catch (err) {
    return { kind: "failed", message: describeError(err) };
  }

  // Issue the close after the write so the user sees the file land before
  // the window disappears. We deliberately do NOT await indefinitely — if
  // the platform refuses to close, we still return `saved` since the data
  // was preserved.
  try {
    await deps.closeWindow();
  } catch {
    /* swallow: data is saved, the user can close the window manually */
  }
  return { kind: "saved" };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
