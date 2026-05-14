# Changelog

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
