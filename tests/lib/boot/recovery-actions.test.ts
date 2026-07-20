/// <reference types="bun" />
/**
 * OBS-3.b: tests for `saveAppDataAndClose`. The `RecoveryDeps` injection
 * point lets us drive every branch — happy path, save dialog cancel, and
 * each failure mode — without touching the Tauri runtime.
 *
 * The recovery action is the verification step the issue spells out:
 * "clicking 'App-Daten sichern und schließen' produces a copy of the DB
 * file in the user's chosen location." The backend copies the DB to the
 * chosen path itself (path-based `backup_database`), so the happy path
 * asserts the chosen path reaches the backup command and the window is
 * closed afterwards.
 */
import { test, expect, describe } from "bun:test";

import {
  saveAppDataAndClose,
  type RecoveryDeps,
} from "../../../src/lib/boot/recovery-actions";

function makeDeps(overrides: Partial<RecoveryDeps> = {}): {
  deps: RecoveryDeps;
  calls: {
    pickArg: string | null;
    backupTarget: string | null;
    closeCalled: number;
  };
} {
  const calls = {
    pickArg: null as string | null,
    backupTarget: null as string | null,
    closeCalled: 0,
  };
  const deps: RecoveryDeps = {
    pickSavePath: async (defaultFileName) => {
      calls.pickArg = defaultFileName;
      return "/tmp/saved-bookie.db";
    },
    backupDatabaseTo: async (targetPath) => {
      calls.backupTarget = targetPath;
      return 4096;
    },
    closeWindow: async () => {
      calls.closeCalled += 1;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("saveAppDataAndClose()", () => {
  test("happy path: picks a path, backs up to it, closes window", async () => {
    const { deps, calls } = makeDeps();

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome).toEqual({ kind: "saved" });
    // The save dialog is seeded with the DB's canonical file name so the
    // user can override it but defaults to the backend's convention.
    expect(calls.pickArg).toBe("bookie.db");
    expect(calls.backupTarget).toBe("/tmp/saved-bookie.db");
    expect(calls.closeCalled).toBe(1);
  });

  test("returns 'cancelled' (and skips backup/close) when the user dismisses the save dialog", async () => {
    const { deps, calls } = makeDeps({
      pickSavePath: async () => null,
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(calls.backupTarget).toBeNull();
    expect(calls.closeCalled).toBe(0);
  });

  test("returns 'failed' with backup_database error and does not close the window", async () => {
    const { deps, calls } = makeDeps({
      backupDatabaseTo: async () => {
        throw new Error("disk read denied");
      },
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("disk read denied");
    }
    // Critical: a failed backup must NOT terminate the app — otherwise
    // the user loses the recovery option without a saved copy.
    expect(calls.closeCalled).toBe(0);
  });

  test("returns 'failed' if the save dialog itself throws", async () => {
    const { deps, calls } = makeDeps({
      pickSavePath: async () => {
        throw new Error("dialog plugin unavailable");
      },
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("dialog plugin unavailable");
    }
    expect(calls.backupTarget).toBeNull();
    expect(calls.closeCalled).toBe(0);
  });

  test("still returns 'saved' if closeWindow rejects (data is preserved)", async () => {
    // Some platforms reject window.close() in development webviews.
    // The data is on disk; the dialog must report success and let the
    // user close manually.
    const { deps, calls } = makeDeps({
      closeWindow: async () => {
        throw new Error("close not supported");
      },
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome).toEqual({ kind: "saved" });
    expect(calls.backupTarget).not.toBeNull();
  });

  test("describes string rejections without wrapping them in JSON", async () => {
    const { deps } = makeDeps({
      backupDatabaseTo: async () => {
        // Tauri rejections for unit-variant BookieError sometimes surface
        // as strings; the dialog needs a usable message regardless.
        throw "raw string rejection";
      },
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toBe("raw string rejection");
    }
  });
});
