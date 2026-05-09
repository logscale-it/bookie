/// <reference types="bun" />
import { test, expect } from "bun:test";

import { safeFields } from "../../../src/lib/db/connection";

const ALLOWED = ["name", "email", "vat_id"] as const;

test("safeFields keeps allowed columns", () => {
  const result = safeFields({ name: "Acme", email: "hi@acme.test" }, ALLOWED);
  expect(result).toEqual([
    ["name", "Acme"],
    ["email", "hi@acme.test"],
  ]);
});

test("safeFields drops disallowed columns", () => {
  const result = safeFields(
    { name: "Acme", evil: "DROP TABLE customers" },
    ALLOWED,
  );
  expect(result).toEqual([["name", "Acme"]]);
});

test("safeFields drops undefined values but keeps null and empty string", () => {
  const result = safeFields(
    { name: null, email: "", vat_id: undefined },
    ALLOWED,
  );
  expect(result).toEqual([
    ["name", null],
    ["email", ""],
  ]);
});

test("safeFields is case-sensitive on column names", () => {
  // Column allowlists in this codebase are lowercase snake_case; a key with
  // different casing must not be accepted.
  const result = safeFields({ Name: "Acme", VAT_ID: "DE123" }, ALLOWED);
  expect(result).toEqual([]);
});

test("safeFields returns empty array for empty input", () => {
  expect(safeFields({}, ALLOWED)).toEqual([]);
});
