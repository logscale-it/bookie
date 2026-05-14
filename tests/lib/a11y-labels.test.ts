/// <reference types="bun" />
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Regression test for TEST-4 (see issue #238).
//
// Six prior fixes (TEST-4.a-.f) associated each bare <label> in src/common/
// with its control via `for=`/wrap. This test guards that invariant so the
// next contributor cannot reintroduce a bare <label> in src/common/ without
// CI catching it.
//
// Approach: regex-based scan of each .svelte file's template region.
// A label is considered associated iff:
//   (a) its opening tag has a `for=...` attribute, OR
//   (b) its inner content contains an opening tag for <input>, <select>,
//       or <textarea> (the wrap pattern).
// Svelte markup is approximately HTML5 in the template region; <label>
// elements do not nest in this codebase, so a non-greedy match between
// opening and closing tags is sufficient. We strip <script> and <style>
// blocks before scanning so that TS/JS occurrences of the word "label"
// (prop names, option objects, comments) cannot influence the result.

const REPO_ROOT = join(import.meta.dir, "..", "..");
const COMMON_DIR = join(REPO_ROOT, "src", "common");

function listSvelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSvelteFiles(full));
    } else if (st.isFile() && entry.endsWith(".svelte")) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Remove <script>...</script> and <style>...</style> blocks from a Svelte
 * source string. We don't try to parse the rest — we only need the markup
 * region so that the <label> regex doesn't trip on JS/TS identifiers.
 */
function stripScriptAndStyle(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

/**
 * Yield each <label>...</label> element in the markup as
 * { openingTag, innerHtml, lineNumber }.
 * lineNumber is 1-based and refers to the original (un-stripped) source.
 *
 * We match labels non-greedily; nested <label> would not be valid HTML
 * and is not present in this codebase. Self-closing <label/> is not a
 * thing in HTML5 either, so we don't handle it.
 */
function findLabels(
  originalSource: string,
  strippedSource: string,
): Array<{ openingTag: string; innerHtml: string; lineNumber: number }> {
  const labelRegex = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  const out: Array<{ openingTag: string; innerHtml: string; lineNumber: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = labelRegex.exec(strippedSource)) !== null) {
    const openingTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const innerHtml = m[2];
    // Approximate the line number in the original source by searching for
    // the matched opening tag. This is best-effort and only used to make
    // the failure message more useful; it does not affect pass/fail logic.
    const idx = originalSource.indexOf(openingTag);
    const lineNumber = idx === -1 ? -1 : originalSource.slice(0, idx).split("\n").length;
    out.push({ openingTag, innerHtml, lineNumber });
  }
  return out;
}

/** True iff the opening tag declares a `for=` attribute. */
function hasForAttribute(openingTag: string): boolean {
  // Matches: for="..." | for='...' | for={...} | for=bareword
  return /\sfor\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+)/i.test(openingTag);
}

/** True iff the inner content contains an opening tag for input/select/textarea. */
function wrapsAControl(innerHtml: string): boolean {
  return /<\s*(input|select|textarea)\b/i.test(innerHtml);
}

test("every <label> in src/common/ has an associated control", () => {
  const files = listSvelteFiles(COMMON_DIR);
  expect(files.length).toBeGreaterThan(0);

  const violations: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const stripped = stripScriptAndStyle(source);
    const labels = findLabels(source, stripped);
    for (const { openingTag, innerHtml, lineNumber } of labels) {
      const associated = hasForAttribute(openingTag) || wrapsAControl(innerHtml);
      if (!associated) {
        const rel = relative(REPO_ROOT, file);
        violations.push(`${rel}:${lineNumber} — bare <label> without for= or wrapped <input>/<select>/<textarea>: ${openingTag}`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Found ${violations.length} unassociated <label> element(s) in src/common/. ` +
        `Each <label> must either have a for= attribute pointing at a control's id, ` +
        `or wrap an <input>/<select>/<textarea>. Violations:\n  ` +
        violations.join("\n  "),
    );
  }
});

test("the label scanner itself recognises both association patterns", () => {
  // Sanity check the scanner against synthetic fixtures so that a future
  // regex tweak that accidentally accepts everything (or rejects everything)
  // is caught immediately.
  const good1 = `<div><label for={id}>Name</label><input id={id} /></div>`;
  const good2 = `<label>Notes<textarea></textarea></label>`;
  const good3 = `<label for="x">X</label>`;
  const bad1 = `<label>Bare</label>`;
  const bad2 = `<label class="label">Also bare</label>`;

  for (const ok of [good1, good2, good3]) {
    const labels = findLabels(ok, stripScriptAndStyle(ok));
    expect(labels.length).toBe(1);
    expect(hasForAttribute(labels[0]!.openingTag) || wrapsAControl(labels[0]!.innerHtml)).toBe(true);
  }
  for (const nope of [bad1, bad2]) {
    const labels = findLabels(nope, stripScriptAndStyle(nope));
    expect(labels.length).toBe(1);
    expect(hasForAttribute(labels[0]!.openingTag) || wrapsAControl(labels[0]!.innerHtml)).toBe(false);
  }
});

test("<script> and <style> blocks are excluded from scanning", () => {
  // The word "label" appears constantly inside <script> blocks (prop names,
  // option objects). Ensure those don't get matched as <label> elements.
  const fixture = `
<script lang="ts">
  let { label = '' } = $props();
  const items = [{ label: 'a' }, { label: 'b' }];
  // <label>not a real label</label>
</script>
<style>
  /* <label>also not real</label> */
</style>
<div>real markup but no labels here</div>
`;
  const stripped = stripScriptAndStyle(fixture);
  expect(findLabels(fixture, stripped).length).toBe(0);
});
