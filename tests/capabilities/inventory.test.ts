/// <reference types="bun" />
//
// SEC-4.a: cross-field verification for the frontend Tauri call-site
// inventory at `src-tauri/capabilities/inventory.json`.
//
// The issue's verification rule is bidirectional:
//   1. Every distinct `invoke('<name>', ...)` literal in `src/` must appear
//      exactly once in the inventory's `commands` array.
//   2. Every `commands[*].command` in the inventory must be backed by a real
//      grep hit in `src/`.
//   3. Every annotated `call_sites` entry must point to a real file/line
//      that does in fact contain that command literal (or, for plugin
//      imports, the named symbol).
//
// SEC-4.b consumes this same file to drive the diff against
// `default.json`, so a regression in either direction (a stray invoke that
// never reaches the inventory, or a stale inventory entry whose call site
// has been deleted) must fail loudly here before it can mask real
// over-permissive capability rows.

import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type CallSite = { file: string; line: number; note?: string };
type CommandEntry = {
  command: string;
  permission: string;
  call_sites: CallSite[];
};
type PluginImport = {
  plugin: string;
  symbol: string;
  permission: string;
  note?: string;
  call_sites: CallSite[];
};
type Inventory = {
  scan: { root: string };
  commands: CommandEntry[];
  plugin_imports: PluginImport[];
  permissions_used: string[];
  custom_commands: {
    registered_in_handler: string[];
    registered_but_unused_by_spa: string[];
  };
};

const REPO_ROOT = resolve(__dirname, "..", "..");
const INVENTORY_PATH = join(
  REPO_ROOT,
  "src-tauri",
  "capabilities",
  "inventory.json",
);
const SRC_ROOT = join(REPO_ROOT, "src");

const inventory: Inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));

/** Recursively walk a directory, returning absolute file paths. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".svelte"]);
const sourceFiles = walk(SRC_ROOT).filter((f) =>
  [...SOURCE_EXTS].some((ext) => f.endsWith(ext)),
);

/** Map of `relative-path -> file contents (split by \n, 1-based via index+1)`. */
const fileContents = new Map<string, string[]>();
for (const abs of sourceFiles) {
  const rel = relative(REPO_ROOT, abs).replaceAll("\\", "/");
  fileContents.set(rel, readFileSync(abs, "utf8").split("\n"));
}

/** Pull every `invoke('<name>', ...)` (or `invoke<T>('<name>', ...)`) call
 *  out of `src/`. The regex must work across newlines because the codebase
 *  uses both single-line `invoke('foo', ...)` and multi-line forms where
 *  the type parameter wraps before the literal — e.g.
 *
 *    const creds = await invoke<{
 *      accessKeyId: string;
 *      secretAccessKey: string;
 *    }>("get_s3_credentials");
 *
 *  We strip block-comment bodies and `//` line comments before scanning so
 *  doc references like "Calls `invoke('backup_database')`" don't pollute
 *  the grep set. */
const INVOKE_RE =
  /\binvoke\s*(?:<[^()]*?>)?\s*\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/gs;

type GrepHit = { file: string; line: number; command: string };
const grepHits: GrepHit[] = [];

/** Replace the contents of every `/* ... *\/` block and every `//` line
 *  comment with spaces of equal length, so newlines and column offsets are
 *  preserved (line numbers stay aligned with the original file). */
function stripCommentsPreservingOffsets(src: string): string {
  // Block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replaceAll(/[^\n]/g, " "),
  );
  // Line comments — only the comment body, leave the newline intact.
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

for (const [relPath, lines] of fileContents) {
  if (!relPath.startsWith("src/")) continue;
  const original = lines.join("\n");
  const stripped = stripCommentsPreservingOffsets(original);
  INVOKE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INVOKE_RE.exec(stripped)) !== null) {
    // The literal sits at `match.index + offsetOfStringInMatch`. Recompute
    // by finding the captured group within the match text; quicker is to
    // search forward from `match.index` for the opening quote of the
    // captured command name.
    const quoted = `'${match[1]}'`;
    const dquoted = `"${match[1]}"`;
    const localStart = match.index;
    const literalIdx = (() => {
      const a = stripped.indexOf(quoted, localStart);
      const b = stripped.indexOf(dquoted, localStart);
      if (a === -1) return b;
      if (b === -1) return a;
      return Math.min(a, b);
    })();
    const idx = literalIdx === -1 ? localStart : literalIdx;
    // Translate offset -> 1-based line number by counting newlines.
    const line = stripped.slice(0, idx).split("\n").length;
    grepHits.push({
      file: relPath,
      line,
      command: match[1]!,
    });
  }
}

test("every invoke() literal in src/ is represented in inventory.commands", () => {
  const inventoryCommandNames = new Set(
    inventory.commands.map((c) => c.command),
  );
  const missing = grepHits
    .filter((h) => !inventoryCommandNames.has(h.command))
    .map((h) => `${h.file}:${h.line} -> '${h.command}'`);
  expect(missing).toEqual([]);
});

test("every inventory.commands entry has a backing invoke() literal in src/", () => {
  const grepNames = new Set(grepHits.map((h) => h.command));
  const orphans = inventory.commands
    .map((c) => c.command)
    .filter((name) => !grepNames.has(name));
  expect(orphans).toEqual([]);
});

test("every inventory.commands entry's call_sites point to real invoke() literals", () => {
  const failures: string[] = [];
  for (const entry of inventory.commands) {
    for (const site of entry.call_sites) {
      const lines = fileContents.get(site.file);
      if (!lines) {
        failures.push(`${entry.command}: ${site.file} not found`);
        continue;
      }
      const line = lines[site.line - 1];
      if (line === undefined) {
        failures.push(
          `${entry.command}: ${site.file}:${site.line} out of range`,
        );
        continue;
      }
      if (
        !line.includes(`'${entry.command}'`) &&
        !line.includes(`"${entry.command}"`)
      ) {
        failures.push(
          `${entry.command}: ${site.file}:${site.line} does not contain literal -> ${line.trim()}`,
        );
      }
    }
  }
  expect(failures).toEqual([]);
});

test("inventory.commands is sorted alphabetically (stable diff for SEC-4.b)", () => {
  const names = inventory.commands.map((c) => c.command);
  const sorted = [...names].sort();
  expect(names).toEqual(sorted);
});

test("permissions_used is the union of all command + plugin permissions", () => {
  const declared = new Set(inventory.permissions_used);
  const referenced = new Set<string>();
  for (const c of inventory.commands) referenced.add(c.permission);
  for (const p of inventory.plugin_imports) referenced.add(p.permission);
  // The SQL plugin's allow-execute / allow-select permissions are declared
  // in `sql_plugin_methods_used` rather than `plugin_imports`, so include
  // them explicitly so this test stays a useful regression guard.
  referenced.add("sql:allow-execute");
  referenced.add("sql:allow-select");
  // Both directions must agree.
  for (const p of referenced) {
    expect(declared.has(p)).toBe(true);
  }
  for (const p of declared) {
    expect(referenced.has(p)).toBe(true);
  }
});

test("plugin_imports point to real import lines", () => {
  const failures: string[] = [];
  for (const entry of inventory.plugin_imports) {
    for (const site of entry.call_sites) {
      const lines = fileContents.get(site.file);
      if (!lines) {
        failures.push(`${entry.plugin}: ${site.file} not found`);
        continue;
      }
      const line = lines[site.line - 1];
      if (line === undefined) {
        failures.push(
          `${entry.plugin}: ${site.file}:${site.line} out of range`,
        );
        continue;
      }
      if (!line.includes(entry.plugin)) {
        failures.push(
          `${entry.plugin}: ${site.file}:${site.line} does not import the plugin -> ${line.trim()}`,
        );
      }
    }
  }
  expect(failures).toEqual([]);
});

test("custom_commands.registered_but_unused_by_spa items have no invoke() hits", () => {
  const grepNames = new Set(grepHits.map((h) => h.command));
  for (const cmd of inventory.custom_commands.registered_but_unused_by_spa) {
    expect(grepNames.has(cmd)).toBe(false);
  }
});

test("custom_commands.registered_in_handler is the disjoint union of used + unused", () => {
  const used = new Set(inventory.commands.map((c) => c.command));
  const unused = new Set(
    inventory.custom_commands.registered_but_unused_by_spa,
  );
  for (const cmd of inventory.custom_commands.registered_in_handler) {
    const isUsed = used.has(cmd);
    const isUnused = unused.has(cmd);
    expect(isUsed !== isUnused).toBe(true); // exactly one
  }
  // And every used command should be in the registered set, otherwise the
  // SPA is calling a command the backend doesn't expose.
  for (const cmd of used) {
    expect(inventory.custom_commands.registered_in_handler.includes(cmd)).toBe(
      true,
    );
  }
});
