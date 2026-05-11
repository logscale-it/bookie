/// <reference types="bun" />
//
// SEC-4.c (issue #190): least-privilege verification for
// `src-tauri/capabilities/default.json` post-pruning.
//
// SEC-4.b (PR #208) produced `over_permissive.json` listing the aggregates
// (`dialog:default`, `opener:default`, `sql:default`) that `default.json`
// granted but the SPA did not exercise. SEC-4.c consumes that artifact:
// removes the over-permissive aggregates and explicitly re-adds the
// narrower permissions they were transitively granting.
//
// This test enforces the two invariants SEC-4.c must uphold so the
// least-privilege state cannot regress silently:
//
//   1. Coverage: every permission the SPA actually uses
//      (`inventory.permissions_used`) is explicitly granted by
//      `default.json`. If this fails, the SPA will hit a Tauri
//      permission-denied error at runtime on the corresponding call site.
//
//   2. Tightness: no over-permissive aggregate (anything ending in
//      `:default` other than `core:default`) is granted by `default.json`.
//      `core:default` is exempt because Tauri v2 requires it to gate the
//      custom `#[tauri::command]` handlers registered via
//      `generate_handler!` (see inventory.json `custom_commands`).
//
// If a future change exercises a new permission, the SEC-4.a inventory
// must be updated alongside `default.json` and this test will keep the two
// in sync.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CAPS_DIR = join(REPO_ROOT, "src-tauri", "capabilities");
const DEFAULT_PATH = join(CAPS_DIR, "default.json");
const INVENTORY_PATH = join(CAPS_DIR, "inventory.json");

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
  identifier: string;
  permissions: PermissionEntry[];
};
type Inventory = {
  permissions_used: string[];
};

const defaultCap: DefaultCapability = JSON.parse(
  readFileSync(DEFAULT_PATH, "utf8"),
);
const inventory: Inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));

const grantedIds = new Set(defaultCap.permissions.map(permissionId));
const usedIds = new Set(inventory.permissions_used);

test("default.json has the required identifier and permissions array", () => {
  expect(defaultCap.identifier).toBe("default");
  expect(Array.isArray(defaultCap.permissions)).toBe(true);
  expect(defaultCap.permissions.length).toBeGreaterThan(0);
});

test("every permission used by the SPA is explicitly granted by default.json (coverage)", () => {
  // Any permission appearing in inventory.permissions_used must appear as a
  // literal entry in default.json — no relying on transitive `*:default`
  // aggregates after SEC-4.c.
  const uncovered = inventory.permissions_used.filter(
    (id) => !grantedIds.has(id),
  );
  expect(uncovered).toEqual([]);
});

test("no over-permissive aggregate is granted by default.json (tightness)", () => {
  // Per SEC-4.b, every `*:default` aggregate except `core:default` was
  // flagged as granting permissions the SPA does not use. SEC-4.c must
  // keep them out. `core:default` is exempt because it gates the 17 custom
  // commands (see inventory.json `custom_commands.registered_in_handler`).
  const overPermissiveAggregates = [...grantedIds].filter(
    (id) => id.endsWith(":default") && id !== "core:default",
  );
  expect(overPermissiveAggregates).toEqual([]);
});

test("default.json permissions list has no duplicates", () => {
  const ids = defaultCap.permissions.map(permissionId);
  const unique = new Set(ids);
  expect(unique.size).toBe(ids.length);
});

test("default.json permissions list is sorted (stable diffs)", () => {
  const ids = defaultCap.permissions.map(permissionId);
  const sorted = [...ids].sort();
  expect(ids).toEqual(sorted);
});

test("granted set equals used set exactly (no slack either direction)", () => {
  // Post-SEC-4.c, `granted` and `used` should be identical: no extra
  // permissions beyond what the SPA exercises, and no missing permissions.
  // If this fails, either default.json has drifted over-permissive again,
  // or a call site has been removed without pruning its permission.
  const grantedSorted = [...grantedIds].sort();
  const usedSorted = [...usedIds].sort();
  expect(grantedSorted).toEqual(usedSorted);
});
