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
- **Frontend tests** live under `tests/` and use Bun's built-in test runner — run with `bun test` (run `bunx svelte-kit sync` first if `.svelte-kit/` is missing, so the `$lib` alias resolves). Quality is also enforced via type checking (`bun run check`) and Rust linting (`cargo clippy`)

## Database Migrations

- Add new migrations under `src-tauri/migrations/NNNN/`
- Always create a rollback migration in `NNNN_down/`
- Migrations run automatically on app startup

## CI Requirements

All of these must pass before pushing (enforced in GitHub Actions):

1. `bun run check`
2. `bun test`
3. `cargo fmt --check --manifest-path src-tauri/Cargo.toml`
4. `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
5. `cargo test --manifest-path src-tauri/Cargo.toml`
6. `cargo audit --deny warnings` from `src-tauri/`
7. `bun audit --audit-level=high`

## Git Workflow

- Main branch: `master`
- Branch from `master`, one feature or fix per PR
- Small, focused commits
- PR reviews required (codeowner: @Ranelkin)
