# Changelog

## 2026-05-17

- **Restored `.github/dependabot.yml`** with monthly cadence and
  `open-pull-requests-limit: 3` for `npm` and `cargo` ecosystems
  (OPS-8). The file had been removed alongside CI in commit `d6904ba`;
  Dependabot still files PRs without Actions, and a human reviews them.
  Documented the new flow in CONTRIBUTING.md § Supply-chain advisories.

## 2026-05-15

- **OPS-5.e verification (issue #220).** Ran the 5 sandbox-safe steps of
  `bun run test:all` (steps 1 `bun run check`, 2 `bun test`,
  3 `cargo fmt --check`, 6 `cargo audit`, 7 `bun audit`) on master HEAD
  (`8302806`). Steps 1, 2, 3, and 6 pass. **Step 7 (`bun audit
--audit-level=high`) fails** with one high-severity advisory
  (`GHSA-77vg-94rm-hx3p`, "Svelte devalue: DoS via sparse array
  deserialization") affecting `devalue >=5.6.3 <=5.8.0` transitively via
  `@sveltejs/kit` and `svelte`. Steps 4 (`cargo clippy`) and 5
  (`cargo test`) require GTK system libs (`libgtk-3-dev`,
  `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`,
  `libjavascriptcoregtk-4.1-dev`, `pkg-config`) and must be attested by
  a maintainer on a dev box. Full log on issue #220.

## 2026-05-14

- **CI switched to local pre-push gate.** GitHub Actions CI was disabled in
  commit `d6904ba` to save runner cost. Contributors now run
  `bun run test:all` (which invokes `scripts/test-all.sh`) before pushing —
  see `CLAUDE.md` § Pre-push checks and `CONTRIBUTING.md` § Pull Requests
  step 3.

## 2026-05-11

- Restored GitHub Actions CI by renaming `.github/workflows/ci.yml.disabled`
  back to `.github/workflows/ci.yml`; CI now runs frontend type checking,
  Rust formatting, clippy, Rust security audit, frontend security audit,
  frontend tests, and backend tests for `master` pushes and pull requests.
- Added a tag-triggered release workflow for `logscale-it/bookie` that builds
  Tauri bundles on Linux, macOS, and Windows and uploads them to a GitHub
  Release.
