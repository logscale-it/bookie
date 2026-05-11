/// <reference types="bun" />
//
// REL-4.b: static check that `tauri_plugin_single_instance::init` is wired
// into the Tauri builder chain in `src-tauri/src/lib.rs`.
//
// Rationale for a string-grep test rather than a true integration test:
// the meaningful runtime behavior (refusing a second launch and focusing
// the existing main window) is impossible to exercise from `cargo test`
// or `bun test`, because it requires two real OS processes contending
// for the single-instance lock file. That manual smoke test is tracked
// separately as REL-4.c (#193).
//
// The next-cheapest verification, then, is to assert that the wiring is
// physically present in the source — i.e. the plugin is registered. If
// someone removes the plugin call from the builder chain, this test
// fails loudly long before anyone has a chance to ship a regression.
// Tauri v2 also requires the single-instance plugin to be registered
// FIRST so that the second invocation is refused before any other
// plugin (notably tauri-plugin-sql) tries to attach to the database
// — we assert that ordering constraint too.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const LIB_RS = join(REPO_ROOT, "src-tauri", "src", "lib.rs");
const CARGO_TOML = join(REPO_ROOT, "src-tauri", "Cargo.toml");

const libSource = readFileSync(LIB_RS, "utf8");
const cargoToml = readFileSync(CARGO_TOML, "utf8");

test("Cargo.toml declares tauri-plugin-single-instance dependency (REL-4.a)", () => {
  // Prerequisite from REL-4.a (PR #204). REL-4.b only wires the plugin;
  // if the dependency disappears, both PRs' value is gone, so guard it
  // here so the failure is unambiguous.
  expect(cargoToml).toMatch(/tauri-plugin-single-instance\s*=/);
});

test("lib.rs registers tauri_plugin_single_instance::init in the builder", () => {
  expect(libSource).toContain("tauri_plugin_single_instance::init");
});

test("single-instance plugin is registered before tauri_plugin_sql", () => {
  // Ordering matters: the lock must be acquired before the SQL plugin
  // opens `bookie.db`, otherwise two processes can briefly race on the
  // SQLite WAL/SHM files before the second one is rejected.
  const singleInstanceIdx = libSource.indexOf("tauri_plugin_single_instance");
  const sqlPluginIdx = libSource.indexOf("tauri_plugin_sql::Builder");
  expect(singleInstanceIdx).toBeGreaterThan(-1);
  expect(sqlPluginIdx).toBeGreaterThan(-1);
  expect(singleInstanceIdx).toBeLessThan(sqlPluginIdx);
});

test("single-instance init handler focuses the existing main window", () => {
  // The handler's whole job on second-launch is to bring the existing
  // window to the front. The exact API (`get_webview_window("main")` +
  // `show` / `unminimize` / `set_focus`) is what `docs/operations.md`
  // §5.3 promises the user will see, so assert the calls are present.
  expect(libSource).toMatch(/get_webview_window\(\s*"main"\s*\)/);
  expect(libSource).toMatch(/\.set_focus\(\)/);
});
