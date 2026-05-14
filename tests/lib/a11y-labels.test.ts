/// <reference types="bun" />
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Regression test for TEST-4.h.
//
// Every `<label>` element in `src/common/` must be associated with a form
// control. After TEST-4.a–f (PRs #240–246), this is the merged posture; this
// test locks it in so that reintroducing a bare `<label>Foo</label>` fails CI.
//
// A `<label>` is considered associated when either:
//   (a) Its opening tag carries a `for=` attribute (explicit association), OR
//   (b) It wraps an `<input>`, `<select>`, or `<textarea>` element
//       (implicit association — the control sits inside the label).
//
// Notes:
//   - `DisplayField.svelte` uses `<span class="label">` for read-only displays.
//     Those are not `<label>` elements and are correctly skipped by the regex.
//   - Intentionally dependency-free: plain `fs` + regex, no Svelte compiler.
//   - The label regex uses `[\s\S]*?` (not `.`) so it spans newlines without
//     requiring the `s` flag, and is non-greedy so it stops at the first
//     `</label>`.

const REPO_ROOT = join(import.meta.dir, "..", "..");
const COMMON_DIR = join(REPO_ROOT, "src", "common");

// Files in this allowlist are skipped entirely. Empty by design: there is no
// known-good reason for a bare `<label>` in `src/common/` today. If a future
// change legitimately requires one, add the file path (relative to the repo
// root) here with a justifying comment.
const ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

function listSvelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSvelteFiles(full));
    } else if (stat.isFile() && entry.endsWith(".svelte")) {
      out.push(full);
    }
  }
  return out;
}

// Match the full `<label ...> ... </label>` block, non-greedy, multiline.
// `\b` after `label` prevents matching `<labelish>` or similar.
const LABEL_BLOCK = /<label\b[\s\S]*?<\/label>/g;

// Match a `for=` attribute on the opening tag only. We slice off the opening
// tag (up to the first `>`) before testing so a child element's `for=` cannot
// satisfy the assertion.
const FOR_ATTR = /\bfor\s*=/i;

// Wrapped-control detector: any `<input`, `<select`, or `<textarea` opening
// tag inside the label body satisfies implicit association.
const WRAPPED_CONTROL = /<(input|select|textarea)\b/i;

function openingTagOf(labelBlock: string): string {
  const end = labelBlock.indexOf(">");
  return end === -1 ? labelBlock : labelBlock.slice(0, end + 1);
}

function isAssociated(labelBlock: string): boolean {
  if (FOR_ATTR.test(openingTagOf(labelBlock))) return true;
  if (WRAPPED_CONTROL.test(labelBlock)) return true;
  return false;
}

function shortExcerpt(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? collapsed.slice(0, 117) + "..." : collapsed;
}

test("every <label> in src/common has a `for` attribute or wraps a control", () => {
  const files = listSvelteFiles(COMMON_DIR);
  // Sanity: we expect to be scanning a non-empty directory. If src/common
  // ever moves, this guard makes the failure obvious instead of silently
  // passing on zero files.
  expect(files.length).toBeGreaterThan(0);

  const violations: { file: string; excerpt: string }[] = [];

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    const source = readFileSync(file, "utf8");
    const matches = source.match(LABEL_BLOCK) ?? [];
    for (const block of matches) {
      if (!isAssociated(block)) {
        violations.push({ file: rel, excerpt: shortExcerpt(block) });
      }
    }
  }

  if (violations.length > 0) {
    const lines = violations.map((v) => `  - ${v.file}: ${v.excerpt}`);
    throw new Error(
      `Found ${violations.length} <label> element(s) in src/common/ without an associated control.\n` +
        `Each <label> must either carry a \`for=\` attribute or wrap an <input>/<select>/<textarea>.\n` +
        lines.join("\n"),
    );
  }
});

test("scanner detects a bare <label> as a violation (self-check)", () => {
  // Self-check the detection logic so a future regex regression (e.g. matching
  // child `for=` attributes) cannot make the real assertion above silently
  // pass on broken code.
  expect(isAssociated("<label>broken</label>")).toBe(false);
  expect(isAssociated('<label for="x">ok</label>')).toBe(true);
  expect(isAssociated('<label class="label">ok <input id="x" /></label>')).toBe(
    true,
  );
  expect(
    isAssociated('<label class="label">ok <textarea></textarea></label>'),
  ).toBe(true);
  expect(
    isAssociated('<label class="label">ok <select><option/></select></label>'),
  ).toBe(true);
  // Multiline label wrapping a control must still pass.
  expect(
    isAssociated(
      `<label class="label mb-1 block">
        Notes
        <textarea rows="4"></textarea>
      </label>`,
    ),
  ).toBe(true);
  // A child element with `for=` must NOT satisfy the assertion — only the
  // opening `<label>` tag is allowed to carry it.
  expect(isAssociated('<label>text <span for="x">nope</span></label>')).toBe(
    false,
  );
});
