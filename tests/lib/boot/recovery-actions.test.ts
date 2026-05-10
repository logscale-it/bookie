/// <reference types="bun" />
/**
 * OBS-3.b: tests for `saveAppDataAndClose`. The `RecoveryDeps` injection
 * point lets us drive every branch — happy path, save dialog cancel, and
 * each of the three failure modes — without touching the Tauri runtime.
 *
 * The recovery action is the verification step the issue spells out:
 * "clicking 'App-Daten sichern und schließen' produces a copy of the DB
 * file in the user's chosen location." So the happy path test asserts
 * exactly that: the chosen path receives the bytes the backup command
 * produced, and the window is closed afterwards.
 */
import { test, expect, describe } from "bun:test";

import {
  saveAppDataAndClose,
  type RecoveryDeps,
} from "../../../src/lib/boot/recovery-actions";

function makeDeps(overrides: Partial<RecoveryDeps> = {}): {
  deps: RecoveryDeps;
  calls: {
    backupCalled: number;
    pickArg: string | null;
    writeArgs: { path: string; data: number[] } | null;
    closeCalled: number;
  };
} {
  const calls = {
    backupCalled: 0,
    pickArg: null as string | null,
    writeArgs: null as { path: string; data: number[] } | null,
    closeCalled: 0,
  };
  const deps: RecoveryDeps = {
    backupDatabase: async () => {
      calls.backupCalled += 1;
      return { file_name: "bookie.db", bytes: [0x53, 0x51, 0x4c] };
    },
    pickSavePath: async (defaultFileName) => {
      calls.pickArg = defaultFileName;
      return "/tmp/saved-bookie.db";
    },
    writeFile: async (path, data) => {
      calls.writeArgs = { path, data };
    },
    closeWindow: async () => {
      calls.closeCalled += 1;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("saveAppDataAndClose()", () => {
  test("happy path: invokes backup, writes chosen path, closes window", async () => {
    const { deps, calls } = makeDeps();

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome).toEqual({ kind: "saved" });
    expect(calls.backupCalled).toBe(1);
    // The save dialog is seeded with the backend-provided file name so
    // the user can override it but defaults to the backend's convention.
    expect(calls.pickArg).toBe("bookie.db");
    expect(calls.writeArgs).toEqual({
      path: "/tmp/saved-bookie.db",
      data: [0x53, 0x51, 0x4c],
    });
    expect(calls.closeCalled).toBe(1);
  });

  test("returns 'cancelled' (and skips write/close) when the user dismisses the save dialog", async () => {
    const { deps, calls } = makeDeps({
      pickSavePath: async () => null,
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(calls.backupCalled).toBe(1);
    expect(calls.writeArgs).toBeNull();
    expect(calls.closeCalled).toBe(0);
  });

  test("returns 'failed' with backup_database error", async () => {
    const { deps, calls } = makeDeps({
      backupDatabase: async () => {
        throw new Error("disk read denied");
      },
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("disk read denied");
    }
    expect(calls.pickArg).toBeNull();
    expect(calls.writeArgs).toBeNull();
    expect(calls.closeCalled).toBe(0);
  });

  test("returns 'failed' with write_binary_file error and does not close the window", async () => {
    const { deps, calls } = makeDeps({
      writeFile: async () => {
        throw new Error("EACCES");
      },
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("EACCES");
    }
    // Critical: a failed write must NOT terminate the app — otherwise
    // the user loses the recovery option without a saved copy.
    expect(calls.closeCalled).toBe(0);
  });

  test("returns 'failed' if the save dialog itself throws", async () => {
    const { deps } = makeDeps({
      pickSavePath: async () => {
        throw new Error("dialog plugin unavailable");
      },
    });

    const outcome = await saveAppDataAndClose(deps);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("dialog plugin unavailable");
    }
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
    expect(calls.writeArgs).not.toBeNull();
  });

  test("describes string rejections without wrapping them in JSON", async () => {
    const { deps } = makeDeps({
      backupDatabase: async () => {
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
