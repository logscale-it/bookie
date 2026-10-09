import { test, expect, describe, mock } from "bun:test";

// OPS-1.b: tests for the boot diagnostics decision module.
//
// Mock the Tauri invoke boundary BEFORE importing the module under test;
// `runBootCheck` calls `invoke("boot_check", ...)` and we want to assert
// the request shape AND drive the response without a live Tauri runtime.
type CapturedInvoke = { cmd: string; args: unknown };
// Mutable test fixtures shared with the mocked invoke. These are wrapped in
// getter/setter helpers so svelte-check does not narrow them to `never`
// after the initial `null` assignment; the mock callback captures via the
// setters at runtime, which TS cannot reason about statically.
let _last: CapturedInvoke | null = null;
let _nextResult: unknown = null;
let _shouldThrow: Error | null = null;
function setLast(v: CapturedInvoke | null): void {
  _last = v;
}
function getLast(): CapturedInvoke | null {
  return _last;
}
function setNextResult(v: unknown): void {
  _nextResult = v;
}
function setShouldThrow(v: Error | null): void {
  _shouldThrow = v;
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    setLast({ cmd, args });
    if (_shouldThrow) throw _shouldThrow;
    return _nextResult;
  },
}));

import {
  ALL_SLOTS,
  BLOCKING_SLOTS,
  hasBlockingFailure,
  hasS3Warning,
  isFailure,
  runBootCheck,
  type BootStatus,
} from "../../../src/lib/diagnostics/boot";

function freshStatus(overrides: Partial<BootStatus> = {}): BootStatus {
  return {
    app_data: { kind: "Ok" },
    keyring: { kind: "Ok" },
    s3: { kind: "Skipped" },
    schema: { kind: "Ok" },
    ...overrides,
  };
}

describe("isFailure", () => {
  test("Ok / Skipped are not failures", () => {
    expect(isFailure({ kind: "Ok" })).toBe(false);
    expect(isFailure({ kind: "Skipped" })).toBe(false);
  });

  test("Failed is a failure regardless of error kind", () => {
    expect(
      isFailure({ kind: "Failed", error: { kind: "IoError", message: "x" } }),
    ).toBe(true);
    expect(isFailure({ kind: "Failed", error: { kind: "Unknown" } })).toBe(
      true,
    );
  });
});

describe("hasBlockingFailure", () => {
  test("all-ok status has no blocking failure", () => {
    expect(hasBlockingFailure(freshStatus())).toBe(false);
  });

  test("S3 failure alone is NOT blocking (per OPS-1.b: warning only)", () => {
    const s = freshStatus({
      s3: { kind: "Failed", error: { kind: "S3Unreachable" } },
    });
    expect(hasBlockingFailure(s)).toBe(false);
  });

  test("schema failure is not gated here (handled by schema-version flow)", () => {
    const s = freshStatus({
      schema: {
        kind: "Failed",
        error: { kind: "MigrationOutOfDate" },
      },
    });
    expect(hasBlockingFailure(s)).toBe(false);
  });

  test("app_data failure IS blocking", () => {
    const s = freshStatus({
      app_data: {
        kind: "Failed",
        error: { kind: "IoError", message: "read-only" },
      },
    });
    expect(hasBlockingFailure(s)).toBe(true);
  });

  test("keyring failure IS blocking", () => {
    const s = freshStatus({
      keyring: { kind: "Failed", error: { kind: "KeyringUnavailable" } },
    });
    expect(hasBlockingFailure(s)).toBe(true);
  });

  test("BLOCKING_SLOTS pins the contract: only app_data + keyring", () => {
    expect([...BLOCKING_SLOTS].sort()).toEqual(["app_data", "keyring"]);
  });

  test("ALL_SLOTS covers the four BootStatus fields", () => {
    expect([...ALL_SLOTS].sort()).toEqual([
      "app_data",
      "keyring",
      "s3",
      "schema",
    ]);
  });
});

describe("hasS3Warning", () => {
  test("S3 Ok / Skipped is not a warning", () => {
    expect(hasS3Warning(freshStatus())).toBe(false);
    expect(hasS3Warning(freshStatus({ s3: { kind: "Ok" } }))).toBe(false);
  });

  test("S3 Failed is a warning", () => {
    const s = freshStatus({
      s3: { kind: "Failed", error: { kind: "S3CredsInvalid" } },
    });
    expect(hasS3Warning(s)).toBe(true);
  });
});

describe("runBootCheck", () => {
  test("invokes 'boot_check' with no args (backend reads S3 settings itself)", async () => {
    setNextResult(freshStatus());
    setShouldThrow(null);
    setLast(null);

    await runBootCheck();

    expect(getLast()?.cmd).toBe("boot_check");
    expect(getLast()?.args).toBeUndefined();
  });

  test("returns the backend's BootStatus shape unmodified", async () => {
    const expected = freshStatus({
      keyring: { kind: "Failed", error: { kind: "KeyringUnavailable" } },
    });
    setNextResult(expected);
    setShouldThrow(null);

    const got = await runBootCheck();
    expect(got).toEqual(expected);
  });

  test("propagates invoke errors so the caller can render a synthetic failure", async () => {
    setShouldThrow(new Error("bridge dead"));
    await expect(runBootCheck()).rejects.toThrow("bridge dead");
  });
});
