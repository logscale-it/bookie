# Changelog

## 2026-05-11

- Restored GitHub Actions CI by renaming `.github/workflows/ci.yml.disabled`
  back to `.github/workflows/ci.yml`; CI now runs frontend type checking,
  Rust formatting, clippy, Rust security audit, frontend security audit,
  frontend tests, and backend tests for `master` pushes and pull requests.
- Added a tag-triggered release workflow for `logscale-it/bookie` that builds
  Tauri bundles on Linux, macOS, and Windows and uploads them to a GitHub
  Release.
