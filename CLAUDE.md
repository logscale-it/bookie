# CLAUDE.md

## Project Overview

Bookie is a local-first desktop application for small business accounting and invoice management, built with **Tauri v2** (Rust backend) and **Svelte 5** (TypeScript frontend). It targets German law compliance with multi-country support (DE, AT, CH, FR, NL, US). Data is stored locally in SQLite with optional S3 backups.

## Development Commands

```bash
# Install dependencies
bun install

# Development (hot-reload)
bun run tauri dev

# Production build
bun run tauri build

# Type checking (frontend)
bun run check

# Frontend formatting
bunx prettier --check "src/**/*.{svelte,ts,js,css,html}"
bunx prettier --write "src/**/*.{svelte,ts,js,css,html}"

# Rust formatting
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml

# Rust linting (warnings are errors)
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Architecture

```
src/                        Svelte 5 + TypeScript frontend (SvelteKit static SPA)
  routes/                   File-based routing, German URL segments
    rechnungen/             Invoices
    eingehende-rechnungen/  Incoming invoices
    zeiterfassung/          Time tracking
    projekte/               Projects
    einstellungen/          Settings
    uebersicht/             Dashboard
    unternehmen/            Company
  lib/                      Utilities
    db/                     Database helpers
    pdf/                    PDF generation (pdf-lib)
    s3/                     S3 backup integration
    i18n/                   Internationalization
    legal/                  Country-specific legal profiles
    shared/                 Shared DTOs
  common/                   Reusable UI components
  app.css                   Tailwind component classes

src-tauri/                  Rust backend (Tauri v2)
  src/lib.rs                Main backend logic (commands, S3, keyring)
  migrations/               SQLite migrations (auto-run on startup)
  Cargo.toml                Rust dependencies
  tauri.conf.json           App configuration
```

## Code Conventions

- **Svelte 5 runes** — use `$state`, `$derived`, `$bindable`; do not use legacy stores
- **Tailwind CSS** for all styling — no component library. Reuse classes from `src/app.css`: `.btn-primary`, `.btn-secondary`, `.card`, `.input-base`, `.input-valid`, `.input-error`, `.label`, `.page-header`, `.nav-pill`
- **UI labels in German**, code and variable names in English
- **TypeScript strict mode** is enabled
- **E2E (Playwright)** lives in the private sibling repo `../bookie-server/e2e/` (`bun run e2e` there) and drives this UI in cloud mode per role; the cloud contract test (`$lib` client against the real server) moved there too (`bun run test:contract`). Markup rules still apply here: every input needs a visible label or `aria-label`; every list row a `data-testid="<area>-row"`. When a change renames a label or testid, update `bookie-server/e2e/pages.ts`; a new page/control that depends on a role or grant gets a row in `bookie-server/e2e/role-matrix.e2e.ts`
- **Frontend tests** live under `tests/` and use Bun's built-in test runner — run with `bun test` (run `bunx svelte-kit sync` first if `.svelte-kit/` is missing, so the `$lib` alias resolves). Quality is also enforced via type checking (`bun run check`) and Rust linting (`cargo clippy`)

## Database Migrations

- Add new migrations under `src-tauri/migrations/NNNN/`
- Always create a rollback migration in `NNNN_down/`
- Migrations run automatically on app startup

## Pre-push checks

Run `bun run test:all` (or `bash scripts/test-all.sh` directly) before pushing — it executes the seven `bun`/`cargo` checks in order and fails fast on the first error. GitHub Actions CI was intentionally disabled in commit `d6904ba` to save runner cost, so this local gate is now the source of truth.

## Git Workflow

- Main branch: `master`
- Branch from `master`, one feature or fix per PR
- Small, focused commits
- PR reviews required (codeowner: @Ranelkin)
