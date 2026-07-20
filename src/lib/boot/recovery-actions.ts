/**
 * OBS-3.b: recovery actions for the MigrationOutOfDate boot dialog.
 *
 * Two flows:
 *   - `goToRestore()`: navigate to the existing restore UI under
 *     `/einstellungen/backup`. The restore page already wires the
 *     `restore_database` Tauri command, so the dialog only needs to send
 *     the user there; it does not duplicate the restore logic.
 *   - `saveAppDataAndClose()`: prompt the user for a save location via
 *     `@tauri-apps/plugin-dialog`'s `save()`, then invoke the path-based
 *     `backup_database` command (the backend copies the DB straight to the
 *     chosen path — no bytes cross the IPC boundary), then close the window.
 *
 * The save action is the verification step the issue calls out: "clicking
 * 'App-Daten sichern und schließen' produces a copy of the DB file in the
 * user's chosen location."
 */

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Default file name seeded into the save dialog (the live DB's name). */
const DB_FILE_NAME = "bookie.db";

/**
 * Test seam: dependency-injection record for the side effects this module
 * performs (Tauri commands, file dialog, window close). The defaults wire
 * real Tauri APIs; tests pass stubs.
 *
 * Each field is a stable function reference so a `vi.fn()`/`mock(...)` can
 * stand in cleanly without monkey-patching the Tauri singletons.
 */
export type RecoveryDeps = {
  /** Opens a native save dialog; returns the chosen path or null on cancel. */
  pickSavePath: (defaultFileName: string) => Promise<string | null>;
  /** Calls `invoke('backup_database', { targetPath })` → bytes written. */
  backupDatabaseTo: (targetPath: string) => Promise<number>;
  /** Closes the current Tauri window (terminates the app). */
  closeWindow: () => Promise<void>;
};

export const defaultRecoveryDeps: RecoveryDeps = {
  pickSavePath: (defaultFileName) =>
    save({
      title: "App-Daten sichern",
      defaultPath: defaultFileName,
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    }),
  backupDatabaseTo: (targetPath) =>
    invoke<number>("backup_database", { targetPath }),
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
 * Ask the user where to put a copy of the live DB, have the backend copy it
 * there, then close the app. Pure aside from the injected deps — passing a
 * stub `RecoveryDeps` makes every branch deterministic in tests.
 */
export async function saveAppDataAndClose(
  deps: RecoveryDeps = defaultRecoveryDeps,
): Promise<SaveOutcome> {
  let path: string | null;
  try {
    path = await deps.pickSavePath(DB_FILE_NAME);
  } catch (err) {
    return { kind: "failed", message: describeError(err) };
  }
  if (!path) return { kind: "cancelled" };

  try {
    await deps.backupDatabaseTo(path);
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
