# Test Conventions

This document describes where tests live, how to add new ones, and which CI
job runs each suite. Bookie has two test stacks: **Bun** for the Svelte 5 /
TypeScript frontend and **`cargo test`** for the Tauri Rust backend.

History: CLAUDE.md previously took a deliberate "no automated tests" stance.
That changed with TEST-1.a (PR #124, frontend `bun test` wired up) and
TEST-1.b (PR #127, `cargo test` + a backend smoke test). This file is the
written convention all downstream test work anchors on.

## Frontend unit tests (TypeScript, Bun)

- **Location:** `tests/lib/...`, mirroring the layout of `src/lib/...`.
- **Runner:** Bun's built-in test runner (`bun:test`).
- **Command:**
  ```bash
  bunx svelte-kit sync   # materializes the $lib path alias on a fresh checkout
  bun test
  ```
- **Real example:** [`tests/lib/db/connection.safefields.test.ts`](lib/db/connection.safefields.test.ts)
  exercises the `safeFields` allowlist helper from `src/lib/db/connection.ts`.
  See also [`tests/lib/logger.redact.test.ts`](lib/logger.redact.test.ts) for
  the PII-redaction tests against `src/lib/logger.ts`.

There is also a parallel `tests/db/...` tree (e.g.
[`tests/db/invoices.test.ts`](db/invoices.test.ts)) that runs Bun-side module
tests against an in-memory SQLite seeded with the production migrations via
[`tests/db/harness.ts`](db/harness.ts). These are still `bun test`; the
separate directory exists because they share a heavier DB harness, not
because the runner differs.

## Rust unit tests (inline `#[cfg(test)] mod tests`)

- **Location:** Beside the source file, inside the same module, gated by
  `#[cfg(test)]`. This keeps unit tests close to the private items they
  cover and lets them reach `super::*` without making symbols `pub`.
- **Command:**
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml
  ```
- **Real example:** `src-tauri/src/lib.rs` contains several inline modules,
  including `bookie_error_tests` (line 99), `pure_helper_tests` (line 1521),
  `atomic_restore_helper_tests` (line 1605), `retry_tests` (line 2118), and
  `validate_endpoint_tests` (line 2227). Search for `#[cfg(test)]` to find
  them.

The S3 round-trip module at line 1777 of `src-tauri/src/lib.rs` is also an
inline `#[cfg(test)] mod`, but it's gated on `BOOKIE_TEST_S3=1` (requires a
local MinIO container, see [`tests/s3/docker-compose.yml`](s3/docker-compose.yml)),
so a bare `cargo test` skips it silently.

## Rust integration tests

- **Location:** `src-tauri/tests/`, **one file per integration binary**.
  Cargo compiles each `*.rs` here as a separate crate that links against
  the public API of the `bookie` library, so these tests cannot reach
  private items — they're the right home for harness-driven, cross-module
  scenarios.
- **Command:** Same as unit tests:
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml
  ```
- **Real example:** [`src-tauri/tests/migrations.rs`](../src-tauri/tests/migrations.rs)
  is the TEST-2.a migration up/down round-trip harness. It walks every
  `src-tauri/migrations/NNNN/` directory, applies up + down against a fresh
  in-memory SQLite, and asserts schema equality (with a `.noop_down` escape
  hatch for the documented SQLite ALTER TABLE limitations).

## Naming conventions

- **Frontend test files:** `<subject>.test.ts` (Bun discovers `*.test.ts` and
  `*.test.tsx`). When a single source file has multiple distinct concerns,
  split with a dotted qualifier: `connection.safefields.test.ts`,
  `invoices.pagination.test.ts`. The path under `tests/lib/` mirrors the
  path under `src/lib/`.
- **Frontend test functions:** `test("<subject> <expected behaviour>", ...)`,
  imperative, present tense. Example from
  `tests/lib/db/connection.safefields.test.ts`:
  `test("safeFields drops disallowed columns", ...)`.
- **Rust test functions:** `fn snake_case_describing_behaviour()`, no `test_`
  prefix (Rust conventions and the surrounding `mod tests` already mark
  intent). Example from `src-tauri/src/lib.rs`:
  `fn unit_variant_serialises_to_kind_only()`,
  `fn sqlite_magic_constant_matches_spec()`.
- **Rust integration test files:** `<feature>.rs` under `src-tauri/tests/`,
  e.g. `migrations.rs`. The filename becomes the test binary name.
- **Fixtures:**
  - Inline literal fixtures live next to the test that uses them (see the
    `fixture` const at the top of `tests/lib/logger.redact.test.ts`).
  - Shared TS test helpers go in `tests/<area>/harness.ts` or
    `tests/<area>/setup.ts` — see [`tests/db/harness.ts`](db/harness.ts)
    and [`tests/db/setup.ts`](db/setup.ts).
  - Shared Rust test helpers belong in a sibling module file under
    `src-tauri/tests/` and are pulled in with `mod common;`.

## CI mapping

The intended CI mapping lives in `.github/workflows/ci.yml.disabled`:

| Job              | Command                                                  | What it covers                                                      |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `test-frontend`  | `bunx svelte-kit sync` then `bun test`                   | Everything under `tests/` (Bun runner discovers `**/*.test.ts`)     |
| `test-backend`   | `cargo test --manifest-path src-tauri/Cargo.toml`        | Inline `#[cfg(test)]` modules in `src-tauri/src/` plus the integration binaries in `src-tauri/tests/` |
| `security-rust`  | `cargo audit --deny warnings` (in `src-tauri/`)          | Rust dependency CVEs                                                |
| `security-frontend` | `bun audit --audit-level=high`                        | Frontend dependency CVEs                                            |

**Current state:** all GitHub Actions workflows are disabled — the file is
checked in as `ci.yml.disabled` rather than `ci.yml` (commit `685379c`,
"chore(ci): disable all GitHub Actions workflows"). Tests still run locally
with the commands above. The `bun run test:all` npm script and the S3
round-trip module both reference a `scripts/test-all.sh` (which is intended
to start MinIO and export `BOOKIE_TEST_S3=1` so the gated tests run); that
script is not yet checked in at the time of writing, so today the S3
round-trip tests skip silently. When CI is re-enabled, rename the workflow
back to `ci.yml`.
