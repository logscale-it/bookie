import { test, expect } from "bun:test";
import { safeFields } from "../../../src/lib/db/connection";

const ALLOWED = ["name", "email", "city"] as const;

test("safeFields keeps only allowlisted keys", () => {
  const input = { name: "Acme", email: "a@b.de", city: "Berlin" };
  const result = safeFields(input, ALLOWED);
  expect(result).toEqual([
    ["name", "Acme"],
    ["email", "a@b.de"],
    ["city", "Berlin"],
  ]);
});

test("safeFields drops keys not in the allowlist (SQL injection guard)", () => {
  const input = {
    name: "Acme",
    "; DROP TABLE customers; --": "evil",
    password: "secret",
  };
  const result = safeFields(input, ALLOWED);
  expect(result).toEqual([["name", "Acme"]]);
});

test("safeFields drops undefined values but keeps null and empty strings", () => {
  const input = { name: "Acme", email: undefined, city: null as unknown };
  const result = safeFields(input, ALLOWED);
  expect(result).toEqual([
    ["name", "Acme"],
    ["city", null],
  ]);
});

test("safeFields returns an empty array when nothing matches", () => {
  const result = safeFields({ foo: 1, bar: 2 }, ALLOWED);
  expect(result).toEqual([]);
});
