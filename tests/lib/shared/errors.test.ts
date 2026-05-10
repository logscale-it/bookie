/// <reference types="bun" />
import { test, expect, describe } from "bun:test";

import {
  isBookieError,
  parseBookieError,
  messageFor,
  messageForUnknown,
  type BookieError,
  type BookieErrorKind,
} from "../../../src/lib/shared/errors";

// Single source of truth for the variant set the TS mirror claims to support.
// Keeping this list explicit (rather than reusing the type alias) is what makes
// the tests below catch silent drift between the Rust enum and the TS mirror.
const UNIT_KINDS: ReadonlyArray<BookieErrorKind> = [
  "S3CredsInvalid",
  "S3Unreachable",
  "S3BucketMissing",
  "S3EndpointInvalid",
  "BackupCorrupt",
  "BackupSidecarMismatch",
  "BackupSidecarMissing",
  "KeyringUnavailable",
  "MigrationOutOfDate",
  "InvoiceImmutable",
];

const STRUCT_KINDS: ReadonlyArray<
  Extract<BookieError, { message: string }>["kind"]
> = ["IoError", "Unknown"];

describe("isBookieError()", () => {
  test("accepts every unit variant shape", () => {
    for (const kind of UNIT_KINDS) {
      expect(isBookieError({ kind })).toBe(true);
    }
  });

  test("accepts every struct variant shape", () => {
    for (const kind of STRUCT_KINDS) {
      expect(isBookieError({ kind, message: "boom" })).toBe(true);
    }
  });

  test("rejects struct variant without message", () => {
    for (const kind of STRUCT_KINDS) {
      expect(isBookieError({ kind })).toBe(false);
    }
  });

  test("rejects struct variant with non-string message", () => {
    expect(isBookieError({ kind: "IoError", message: 42 })).toBe(false);
    expect(isBookieError({ kind: "Unknown", message: null })).toBe(false);
  });

  test("rejects unknown kinds", () => {
    expect(isBookieError({ kind: "NotARealVariant" })).toBe(false);
    expect(isBookieError({ kind: "" })).toBe(false);
  });

  test("rejects non-objects and missing kind", () => {
    expect(isBookieError(null)).toBe(false);
    expect(isBookieError(undefined)).toBe(false);
    expect(isBookieError("S3CredsInvalid")).toBe(false);
    expect(isBookieError(42)).toBe(false);
    expect(isBookieError({})).toBe(false);
    expect(isBookieError({ kind: 123 })).toBe(false);
  });
});

describe("parseBookieError()", () => {
  test("returns the input when it is already a BookieError", () => {
    const err: BookieError = { kind: "S3BucketMissing" };
    expect(parseBookieError(err)).toBe(err);
  });

  test('parses the JSON shape produced by `serde(tag = "kind")` for unit variants', () => {
    // This is exactly what `serde_json::to_string(&BookieError::S3CredsInvalid)`
    // emits — see the Rust round-trip test in src-tauri/src/lib.rs.
    const json = '{"kind":"S3CredsInvalid"}';
    expect(parseBookieError(json)).toEqual({ kind: "S3CredsInvalid" });
  });

  test('parses the JSON shape produced by `serde(tag = "kind")` for struct variants', () => {
    const json = '{"kind":"IoError","message":"file not found"}';
    expect(parseBookieError(json)).toEqual({
      kind: "IoError",
      message: "file not found",
    });
  });

  test("falls back to Unknown for non-JSON strings", () => {
    const result = parseBookieError("not json at all");
    expect(result).toEqual({ kind: "Unknown", message: "not json at all" });
  });

  test("falls back to Unknown for JSON that isn't a BookieError", () => {
    const result = parseBookieError('{"foo":"bar"}');
    expect(result.kind).toBe("Unknown");
    // The original payload is preserved verbatim so it can be surfaced for
    // debugging instead of silently swallowed.
    expect((result as { message: string }).message).toBe('{"foo":"bar"}');
  });

  test("extracts message from Error instances", () => {
    const result = parseBookieError(new Error("whoops"));
    expect(result).toEqual({ kind: "Unknown", message: "whoops" });
  });

  test("stringifies arbitrary objects into Unknown", () => {
    const result = parseBookieError({ random: "shape" });
    expect(result.kind).toBe("Unknown");
    expect((result as { message: string }).message).toContain("random");
  });

  test("never throws on hostile input", () => {
    // A circular object cannot be JSON.stringified — the helper must still
    // produce a usable BookieError rather than propagating the TypeError.
    type Circular = { self?: Circular };
    const cyclic: Circular = {};
    cyclic.self = cyclic;
    expect(() => parseBookieError(cyclic)).not.toThrow();
    const result = parseBookieError(cyclic);
    expect(result.kind).toBe("Unknown");
    expect(typeof (result as { message: string }).message).toBe("string");
  });
});

describe("messageFor()", () => {
  test("returns a non-empty German message for every variant", () => {
    const samples: ReadonlyArray<BookieError> = [
      ...UNIT_KINDS.map((kind) => ({ kind }) as BookieError),
      { kind: "IoError", message: "disk full" },
      { kind: "Unknown", message: "ufo" },
    ];
    for (const err of samples) {
      const msg = messageFor(err);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test("interpolates the message field for struct variants", () => {
    expect(messageFor({ kind: "IoError", message: "EACCES" })).toContain(
      "EACCES",
    );
    expect(messageFor({ kind: "Unknown", message: "boom-42" })).toContain(
      "boom-42",
    );
  });

  test("returns the German wording for the seed S3 case", () => {
    // This is the failure mode the issue's verification step calls out
    // explicitly ("provoking an S3 cred failure shows the German messageFor(err)
    // text instead of the raw stringified error"). Pin the wording so a
    // future translation refactor doesn't silently regress it.
    const msg = messageFor({ kind: "S3CredsInvalid" });
    expect(msg).toContain("S3-Zugangsdaten");
    expect(msg).toContain("ungültig");
  });

  test("returns distinct messages for distinct kinds", () => {
    // Distinguishability is the whole point of the typed-error surface — if
    // two kinds collapse to the same string the UX gain is lost.
    const messages = new Set<string>();
    for (const kind of UNIT_KINDS) {
      messages.add(messageFor({ kind } as BookieError));
    }
    expect(messages.size).toBe(UNIT_KINDS.length);
  });
});

describe("messageForUnknown()", () => {
  test("composes parse + render for raw rejection values", () => {
    expect(messageForUnknown('{"kind":"S3BucketMissing"}')).toContain(
      "S3-Bucket",
    );
    expect(messageForUnknown(new Error("nope"))).toContain("nope");
    expect(messageForUnknown({ kind: "IoError", message: "x" })).toContain("x");
  });

  test("never throws regardless of input", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      "",
      [],
      { kind: "NotReal" },
    ];
    for (const value of hostile) {
      expect(() => messageForUnknown(value)).not.toThrow();
      expect(typeof messageForUnknown(value)).toBe("string");
    }
  });
});
