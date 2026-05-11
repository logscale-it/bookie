/// <reference types="bun" />
//
// SEC-4.b: cross-field verification for the over-permissive capability
// artifact at `src-tauri/capabilities/over_permissive.json`.
//
// The issue's verification rule:
//   Output is a JSON array of strings, each appearing in `default.json`'s
//   `permissions` array and absent from the SEC-4.a inventory's
//   `permissions_used`.
//
// This test enforces that contract bidirectionally so SEC-4.c (which will
// consume `over_permissive.json` to prune `default.json`) cannot regress
// silently: if anyone touches `default.json` or `inventory.json` without
// regenerating the diff, the test fails loudly.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CAPS_DIR = join(REPO_ROOT, "src-tauri", "capabilities");
const DEFAULT_PATH = join(CAPS_DIR, "default.json");
const INVENTORY_PATH = join(CAPS_DIR, "inventory.json");
const OVER_PERMISSIVE_PATH = join(CAPS_DIR, "over_permissive.json");

/** `default.json`'s `permissions` array may contain plain strings or scoped
 *  permission objects of shape `{ identifier: string, allow?: ..., deny?: ... }`.
 *  This helper normalises both forms to a flat list of identifier strings. */
type ScopedPermission = { identifier: string };
type PermissionEntry = string | ScopedPermission;

function permissionId(entry: PermissionEntry): string {
  if (typeof entry === "string") return entry;
  if (
    entry &&
    typeof entry === "object" &&
    typeof entry.identifier === "string"
  )
    return entry.identifier;
  throw new Error(
    `default.json contains a permission entry of unknown shape: ${JSON.stringify(entry)}`,
  );
}

type DefaultCapability = {
  permissions: PermissionEntry[];
};
type Inventory = {
  permissions_used: string[];
};
type OverPermissive = {
  generated_at: string;
  over_permissive: string[];
  rationale: Record<string, string>;
};

const defaultCap: DefaultCapability = JSON.parse(
  readFileSync(DEFAULT_PATH, "utf8"),
);
const inventory: Inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
const overPermissive: OverPermissive = JSON.parse(
  readFileSync(OVER_PERMISSIVE_PATH, "utf8"),
);

const grantedIds = new Set(defaultCap.permissions.map(permissionId));
const usedIds = new Set(inventory.permissions_used);

test("over_permissive.json has the required top-level keys", () => {
  expect(typeof overPermissive.generated_at).toBe("string");
  expect(overPermissive.generated_at.length).toBeGreaterThan(0);
  expect(Array.isArray(overPermissive.over_permissive)).toBe(true);
  expect(
    typeof overPermissive.rationale === "object" &&
      overPermissive.rationale !== null,
  ).toBe(true);
});

test("over_permissive entries are all strings", () => {
  for (const id of overPermissive.over_permissive) {
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  }
});

test("over_permissive is sorted alphabetically (stable diff for SEC-4.c)", () => {
  const sorted = [...overPermissive.over_permissive].sort();
  expect(overPermissive.over_permissive).toEqual(sorted);
});

test("over_permissive has no duplicate entries", () => {
  const unique = new Set(overPermissive.over_permissive);
  expect(unique.size).toBe(overPermissive.over_permissive.length);
});

test("every over_permissive entry is granted by default.json", () => {
  const missing = overPermissive.over_permissive.filter(
    (id) => !grantedIds.has(id),
  );
  expect(missing).toEqual([]);
});

test("no over_permissive entry appears in inventory.permissions_used", () => {
  const leaked = overPermissive.over_permissive.filter((id) => usedIds.has(id));
  expect(leaked).toEqual([]);
});

test("rationale covers every over_permissive entry (no stale or missing keys)", () => {
  const rationaleKeys = new Set(Object.keys(overPermissive.rationale));
  const overSet = new Set(overPermissive.over_permissive);
  // Every over_permissive entry has a rationale string.
  for (const id of overSet) {
    expect(rationaleKeys.has(id)).toBe(true);
    expect(typeof overPermissive.rationale[id]).toBe("string");
    expect(overPermissive.rationale[id]!.length).toBeGreaterThan(0);
  }
  // No stale rationale entries either.
  for (const key of rationaleKeys) {
    expect(overSet.has(key)).toBe(true);
  }
});

test("over_permissive is the exact diff (granted \\ used) — guards against missed entries", () => {
  // Compute the diff the same way SEC-4.c will, and assert the artifact is
  // complete. This catches the case where someone adds a permission to
  // default.json (e.g. dialog:allow-open) without re-running the diff —
  // without this check, `over_permissive` could silently under-report.
  const computedDiff = [...grantedIds].filter((id) => !usedIds.has(id)).sort();
  expect(overPermissive.over_permissive).toEqual(computedDiff);
});

test("generated_at is a parseable ISO-8601 timestamp", () => {
  const parsed = Date.parse(overPermissive.generated_at);
  expect(Number.isFinite(parsed)).toBe(true);
});
