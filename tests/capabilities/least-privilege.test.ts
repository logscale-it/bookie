/// <reference types="bun" />
//
// Least-privilege tripwire for `src-tauri/capabilities/default.json`: every
// granted permission must be exercised by a call site in `src/`, and every
// call site's permission must be granted. Custom `#[tauri::command]`s ride on
// `core:default`, so instead each `invoke("<cmd>")` literal must be a command
// registered in `generate_handler!`.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const defaultCap: { permissions: (string | { identifier: string })[] } =
  JSON.parse(
    readFileSync(
      join(REPO_ROOT, "src-tauri", "capabilities", "default.json"),
      "utf8",
    ),
  );
const granted = defaultCap.permissions.map((p) =>
  typeof p === "string" ? p : p.identifier,
);

const src = [...new Glob("src/**/*.{ts,svelte}").scanSync(REPO_ROOT)]
  .map((f) => readFileSync(join(REPO_ROOT, f), "utf8"))
  .join("\n");

// Permission -> pattern of the SPA call that needs it.
const CALL_SITES: Record<string, RegExp> = {
  "core:default": /\binvoke\s*[<(]/,
  "core:window:allow-close": /getCurrentWindow\(\)\.close\(/,
  "core:window:allow-set-theme": /getCurrentWindow\(\)\.setTheme\(/,
  "dialog:allow-open":
    /import\s*{[^}]*\bopen\b[^}]*}\s*from\s*["']@tauri-apps\/plugin-dialog/,
  "dialog:allow-save":
    /import\s*{[^}]*\bsave\b[^}]*}\s*from\s*["']@tauri-apps\/plugin-dialog/,
  "opener:allow-open-url": /\bopenUrl\(/,
  "process:allow-restart": /\brelaunch\(/,
  "sql:allow-execute": /\.execute\(/,
  "sql:allow-load": /Database\.load\(/,
  "sql:allow-select": /\.select</,
  "updater:allow-check": /from\s*["']@tauri-apps\/plugin-updater/,
  "updater:allow-download-and-install": /\.downloadAndInstall\(/,
};

test("granted permissions equal the permissions the SPA uses", () => {
  const used = Object.keys(CALL_SITES).filter((p) => CALL_SITES[p].test(src));
  expect([...granted].sort()).toEqual(used.sort());
});

test("default.json permissions are sorted and unique", () => {
  expect(granted).toEqual([...new Set(granted)].sort());
});

test("every invoked command is registered in generate_handler!", () => {
  const lib = readFileSync(
    join(REPO_ROOT, "src-tauri", "src", "lib.rs"),
    "utf8",
  );
  const handler = /generate_handler!\[([^\]]*)\]/.exec(lib)![1];
  const registered = new Set(
    handler
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const invoked = [
    ...src.matchAll(/\binvoke(?:<[^>]*>)?\(\s*["'](\w+)["']/g),
  ].map((m) => m[1]);
  expect(invoked.length).toBeGreaterThan(0);
  expect(invoked.filter((c) => !registered.has(c))).toEqual([]);
});
