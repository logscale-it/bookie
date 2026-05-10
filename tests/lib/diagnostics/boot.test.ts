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
  s3ConfigFromSettings,
  type BootStatus,
} from "../../../src/lib/diagnostics/boot";

function freshStatus(overrides: Partial<BootStatus> = {}): BootStatus {
  return {
    app_data_dir: { status: "ok", info: "/tmp/bookie" },
    keyring: { status: "ok" },
    s3: { status: "skipped", reason: "s3 not configured" },
    schema: { status: "delegated", to: "schema_version_check" },
    ...overrides,
  };
}

describe("isFailure", () => {
  test("ok / skipped / delegated are not failures", () => {
    expect(isFailure({ status: "ok" })).toBe(false);
    expect(isFailure({ status: "ok", info: "x" })).toBe(false);
    expect(isFailure({ status: "skipped", reason: "n/a" })).toBe(false);
    expect(isFailure({ status: "delegated", to: "other" })).toBe(false);
  });

  test("err is a failure regardless of error kind", () => {
    expect(
      isFailure({ status: "err", error: { kind: "IoError", message: "x" } }),
    ).toBe(true);
    expect(isFailure({ status: "err", error: { kind: "Unknown" } })).toBe(true);
  });
});

describe("hasBlockingFailure", () => {
  test("all-ok status has no blocking failure", () => {
    expect(hasBlockingFailure(freshStatus())).toBe(false);
  });

  test("S3 failure alone is NOT blocking (per OPS-1.b: warning only)", () => {
    const s = freshStatus({
      s3: { status: "err", error: { kind: "S3Unreachable" } },
    });
    expect(hasBlockingFailure(s)).toBe(false);
  });

  test("schema delegated is never blocking", () => {
    const s = freshStatus({
      schema: { status: "delegated", to: "schema_version_check" },
    });
    expect(hasBlockingFailure(s)).toBe(false);
  });

  test("app_data_dir failure IS blocking", () => {
    const s = freshStatus({
      app_data_dir: {
        status: "err",
        error: { kind: "IoError", message: "read-only" },
      },
    });
    expect(hasBlockingFailure(s)).toBe(true);
  });

  test("keyring failure IS blocking", () => {
    const s = freshStatus({
      keyring: { status: "err", error: { kind: "KeyringUnavailable" } },
    });
    expect(hasBlockingFailure(s)).toBe(true);
  });

  test("BLOCKING_SLOTS pins the contract: only app_data_dir + keyring", () => {
    expect([...BLOCKING_SLOTS].sort()).toEqual(["app_data_dir", "keyring"]);
  });

  test("ALL_SLOTS covers the four BootStatus fields", () => {
    expect([...ALL_SLOTS].sort()).toEqual([
      "app_data_dir",
      "keyring",
      "s3",
      "schema",
    ]);
  });
});

describe("hasS3Warning", () => {
  test("S3 ok / skipped is not a warning", () => {
    expect(hasS3Warning(freshStatus())).toBe(false);
    expect(hasS3Warning(freshStatus({ s3: { status: "ok" } }))).toBe(false);
  });

  test("S3 err is a warning", () => {
    const s = freshStatus({
      s3: { status: "err", error: { kind: "S3CredsInvalid" } },
    });
    expect(hasS3Warning(s)).toBe(true);
  });
});

describe("s3ConfigFromSettings", () => {
  test("null settings -> null (probe will be skipped)", () => {
    expect(s3ConfigFromSettings(null)).toBeNull();
  });

  test("disabled -> null (probe will be skipped)", () => {
    expect(
      s3ConfigFromSettings({
        enabled: 0,
        endpoint_url: "https://s3.example.com",
        region: "eu-central-1",
        bucket_name: "b",
        access_key_id: "k",
        secret_access_key: "s",
      }),
    ).toBeNull();
  });

  test("missing creds -> null (don't fail probe on empty fields)", () => {
    expect(
      s3ConfigFromSettings({
        enabled: 1,
        endpoint_url: "https://s3.example.com",
        region: "eu-central-1",
        bucket_name: "b",
        access_key_id: "",
        secret_access_key: "",
      }),
    ).toBeNull();
  });

  test("missing bucket -> null", () => {
    expect(
      s3ConfigFromSettings({
        enabled: 1,
        endpoint_url: "https://s3.example.com",
        region: "eu-central-1",
        bucket_name: "",
        access_key_id: "k",
        secret_access_key: "s",
      }),
    ).toBeNull();
  });

  test("complete settings -> camelCase config matching Rust S3Config", () => {
    const cfg = s3ConfigFromSettings({
      enabled: 1,
      endpoint_url: "https://s3.example.com",
      region: "eu-central-1",
      bucket_name: "my-bucket",
      access_key_id: "AKIA",
      secret_access_key: "secret",
    });
    expect(cfg).toEqual({
      endpointUrl: "https://s3.example.com",
      region: "eu-central-1",
      bucketName: "my-bucket",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
    });
  });
});

describe("runBootCheck", () => {
  test("invokes 'boot_check' with s3Config: null when no config given", async () => {
    setNextResult(freshStatus());
    setShouldThrow(null);
    setLast(null);

    await runBootCheck();

    expect(getLast()?.cmd).toBe("boot_check");
    expect(getLast()?.args).toEqual({ s3Config: null });
  });

  test("forwards an explicit s3Config to the backend", async () => {
    setNextResult(freshStatus());
    setShouldThrow(null);
    setLast(null);

    const cfg = {
      endpointUrl: "https://s3.example.com",
      region: "eu-central-1",
      bucketName: "b",
      accessKeyId: "k",
      secretAccessKey: "s",
    };
    await runBootCheck(cfg);

    expect(getLast()?.args).toEqual({ s3Config: cfg });
  });

  test("returns the backend's BootStatus shape unmodified", async () => {
    const expected = freshStatus({
      keyring: { status: "err", error: { kind: "KeyringUnavailable" } },
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
