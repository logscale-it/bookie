/// <reference types="bun" />
import { test, expect } from "bun:test";

import { entryForIpc, type LogEntry } from "../../src/lib/logger";

test("entryForIpc passes plain entries through unchanged", () => {
  const entry: LogEntry = {
    level: "warn",
    module: "ui/invoice",
    message: "validation failed",
    timestamp: "2026-05-10T12:00:00.000Z",
    data: { field: "amount", reason: "negative" },
  };
  expect(entryForIpc(entry)).toBe(entry);
});

test("entryForIpc projects Error data into a JSON-safe shape", () => {
  const err = new Error("boom");
  const entry: LogEntry = {
    level: "error",
    module: "ui/s3",
    message: "upload failed",
    timestamp: "2026-05-10T12:00:00.000Z",
    data: err,
  };
  const projected = entryForIpc(entry);
  expect(projected.data).toBeDefined();
  expect((projected.data as { name: string }).name).toBe("Error");
  expect((projected.data as { message: string }).message).toBe("boom");
  // Stack is environment-dependent (may be undefined in some Bun builds), so
  // we only assert the field is present in the projected object.
  expect("stack" in (projected.data as object)).toBe(true);
});

test("entryForIpc produces JSON-serialisable output for Error data", () => {
  const entry: LogEntry = {
    level: "error",
    module: "ui/s3",
    message: "upload failed",
    timestamp: "2026-05-10T12:00:00.000Z",
    data: new Error("boom"),
  };
  // The original entry would serialise data to `{}` because Error fields are
  // non-enumerable; the projection guarantees the round-trip preserves the
  // diagnostic message.
  const roundTripped = JSON.parse(
    JSON.stringify(entryForIpc(entry)),
  ) as LogEntry;
  expect((roundTripped.data as { message: string }).message).toBe("boom");
});

test("entryForIpc preserves entry metadata fields", () => {
  const entry: LogEntry = {
    level: "warn",
    module: "ui/invoice",
    message: "deadline approaching",
    timestamp: "2026-05-10T12:00:00.000Z",
    data: new Error("late"),
  };
  const projected = entryForIpc(entry);
  expect(projected.level).toBe("warn");
  expect(projected.module).toBe("ui/invoice");
  expect(projected.message).toBe("deadline approaching");
  expect(projected.timestamp).toBe("2026-05-10T12:00:00.000Z");
});
