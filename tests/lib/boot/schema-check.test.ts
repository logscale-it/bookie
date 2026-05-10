/// <reference types="bun" />
/**
 * OBS-3.b: tests for `parseMigrationOutOfDate`. The parser is the
 * load-bearing part of the boot check — if a `BookieError::MigrationOutOfDate`
 * rejection isn't recognised, the recovery dialog never mounts and the user
 * sees a generic "boot failed" silently.
 *
 * We do NOT exercise `runSchemaVersionCheck()` itself here because that
 * requires the Tauri runtime (the `@tauri-apps/api/core` `invoke()` call).
 * The parser captures the failure mode that's worth pinning in unit tests:
 * the field-shape of the rejection.
 */
import { test, expect, describe } from "bun:test";

import { parseMigrationOutOfDate } from "../../../src/lib/boot/schema-check";

describe("parseMigrationOutOfDate()", () => {
  test("recognises the post-PR-#159 struct-variant shape", () => {
    // The Rust shape introduced by OBS-3.a:
    //   {"kind":"MigrationOutOfDate","actual":21,"expected":22}
    const result = parseMigrationOutOfDate({
      kind: "MigrationOutOfDate",
      actual: 21,
      expected: 22,
    });
    expect(result).toEqual({
      kind: "MigrationOutOfDate",
      actual: 21,
      expected: 22,
    });
  });

  test("recognises the pre-PR-#159 unit-variant shape with no fields", () => {
    // Until OBS-3.a (PR #159) lands on master, BookieError::MigrationOutOfDate
    // is a unit variant and serialises as {"kind":"MigrationOutOfDate"}.
    // The parser must still recognise this so the dialog can mount; the
    // version numbers will simply be omitted from the body copy.
    const result = parseMigrationOutOfDate({ kind: "MigrationOutOfDate" });
    expect(result).toEqual({
      kind: "MigrationOutOfDate",
      actual: undefined,
      expected: undefined,
    });
  });

  test("accepts the JSON-string form some Tauri bridges deliver", () => {
    const json = '{"kind":"MigrationOutOfDate","actual":5,"expected":22}';
    const result = parseMigrationOutOfDate(json);
    expect(result).toEqual({
      kind: "MigrationOutOfDate",
      actual: 5,
      expected: 22,
    });
  });

  test("ignores non-numeric actual/expected fields", () => {
    // A misbehaving backend that ships strings for the version numbers
    // shouldn't crash the dialog. The parser drops the suspect fields
    // and the dialog falls back to the unit-variant rendering path.
    const result = parseMigrationOutOfDate({
      kind: "MigrationOutOfDate",
      actual: "21",
      expected: null,
    });
    expect(result).toEqual({
      kind: "MigrationOutOfDate",
      actual: undefined,
      expected: undefined,
    });
  });

  test("returns null for other BookieError variants", () => {
    expect(parseMigrationOutOfDate({ kind: "S3CredsInvalid" })).toBeNull();
    expect(
      parseMigrationOutOfDate({ kind: "IoError", message: "x" }),
    ).toBeNull();
    expect(
      parseMigrationOutOfDate({ kind: "Unknown", message: "x" }),
    ).toBeNull();
  });

  test("returns null for non-object / non-JSON inputs", () => {
    expect(parseMigrationOutOfDate(null)).toBeNull();
    expect(parseMigrationOutOfDate(undefined)).toBeNull();
    expect(parseMigrationOutOfDate(42)).toBeNull();
    expect(parseMigrationOutOfDate("not json at all")).toBeNull();
    expect(parseMigrationOutOfDate(new Error("boom"))).toBeNull();
    expect(parseMigrationOutOfDate({})).toBeNull();
  });
});
