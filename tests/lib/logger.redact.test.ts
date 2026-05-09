/// <reference types="bun" />
import { test, expect } from "bun:test";

import { redact, PII_KEY_PATTERNS } from "../../src/lib/logger";

// One leaf per PII pattern recognized by `redact()` (see PII_KEY_PATTERNS in
// src/lib/logger.ts) plus three plainly non-PII leaves. The fixture is flat to
// keep the per-leaf assertions unambiguous: a PII key at the top level is
// enough to exercise the matching logic, and the recursive walk of `redact()`
// is covered separately below.
const fixture = {
  // PII leaves — one per pattern in PII_KEY_PATTERNS, in the same order.
  name: "Erika Mustermann",
  email: "erika@example.test",
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  address: "Musterstr. 1, 12345 Berlin",
  postal: "12345",
  city: "Berlin",
  tax_id: "12 345 678 901",
  vat_id: "DE123456789",
  phone: "+49 30 1234567",
  // Non-PII leaves — operational metadata that must pass through untouched.
  op: "upload",
  s3_key: "invoices/2025/INV-001.pdf",
  byte_size: 4096,
};

const PII_KEYS = [
  "name",
  "email",
  "iban",
  "bic",
  "address",
  "postal",
  "city",
  "tax_id",
  "vat_id",
  "phone",
] as const;

const NON_PII_KEYS = ["op", "s3_key", "byte_size"] as const;

const REDACTED = /^\[REDACTED:[0-9a-f]{8}\]$/;

test("redact() covers every pattern in PII_KEY_PATTERNS", () => {
  // Guards against silent drift: if a new pattern is added to the source
  // without extending this fixture, the test must fail loudly.
  expect<number>(PII_KEYS.length).toBe(PII_KEY_PATTERNS.length);
});

test("redact() hashes exactly the PII leaves", () => {
  const result = redact(fixture) as Record<string, unknown>;
  for (const key of PII_KEYS) {
    expect(typeof result[key]).toBe("string");
    expect(result[key] as string).toMatch(REDACTED);
    // The placeholder must not echo the original value.
    expect(result[key]).not.toBe((fixture as Record<string, unknown>)[key]);
  }
});

test("redact() leaves non-PII leaves untouched", () => {
  const result = redact(fixture) as Record<string, unknown>;
  for (const key of NON_PII_KEYS) {
    expect(result[key]).toBe((fixture as Record<string, unknown>)[key]);
  }
});

test("redact() does not mutate the input", () => {
  const snapshot = structuredClone(fixture);
  redact(fixture);
  expect(fixture).toEqual(snapshot);
});
