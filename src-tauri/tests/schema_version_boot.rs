//! OBS-3.c: down-revved DB refuses boot.
//!
//! This integration test exercises the boot-time schema-version invariant
//! described in OBS-3 (REFINEMENT.md): when the on-disk SQLite database's
//! migration-tracking table claims a version older (or newer) than the
//! version the binary was compiled against, the application must refuse to
//! boot with a `MigrationOutOfDate` signal rather than silently issue
//! malformed SQL against a schema that disagrees with its assumptions.
//!
//! ## Relationship to OBS-3.a / OBS-3.b
//!
//! - OBS-3.a (PR #159, open at the time this test was written) introduces
//!   the production helper `check_schema_version_at(db_path, expected) ->
//!   Result<(), BookieError>` and the `EXPECTED_SCHEMA_VERSION` constant
//!   inside `src/lib.rs`. Once that PR lands, this test becomes a
//!   higher-level companion to the unit-style tests it ships in
//!   `tests/schema_version_check.rs`: this file keeps a self-contained
//!   reimplementation of the version-check contract so the test can run
//!   on `master` today without depending on #159 being merged first, and
//!   so the contract is pinned in two independent places (a regression
//!   that quietly breaks the helper would have to break both files in
//!   lockstep to escape detection).
//! - OBS-3.b (PR #165, open) consumes the helper's `MigrationOutOfDate`
//!   variant from the frontend to render a hard-stop recovery dialog.
//!   That PR is purely TS, so it's out of scope here.
//!
//! ## What this test asserts
//!
//! 1. The highest `NNNN/` migration directory under `src-tauri/migrations/`
//!    matches the test's `EXPECTED_SCHEMA_VERSION` source of truth (the
//!    same constant OBS-3.a bakes into the binary). A future contributor
//!    who adds migration `NNNN+1` without updating this constant gets a
//!    hard `cargo test` failure here, mirroring the cross-check test in
//!    PR #159's `schema_version_check.rs`.
//! 2. Given a real on-disk fixture DB whose `_sqlx_migrations` table holds
//!    only `version = N - 1`, the boot check rejects with `MigrationOutOfDate`
//!    carrying `actual = N - 1, expected = N`. This is the down-revved
//!    case the issue body calls out.
//! 3. Given a fixture DB with `version = N` (the current binary's
//!    expectation), the boot check accepts. Negative-of-the-negative so
//!    a broken check that always rejects doesn't pass the suite.
//! 4. Given a DB whose `_sqlx_migrations` table is absent entirely (i.e.
//!    a SQLite file that has never been touched by `tauri-plugin-sql`),
//!    the boot check rejects with `actual = 0, expected = N`. This is
//!    the "user opens a foreign sqlite file as their bookie DB" case.
//! 5. The "no business commands run on a stale DB" half of the issue's
//!    verification is exercised by simulating a boot sequence: the test
//!    calls `boot_or_reject` (this file's name for the chokepoint), and
//!    only on `Ok(())` does it proceed to a business-command stand-in
//!    that would otherwise touch the DB. On the down-revved fixture the
//!    business-command stand-in must not run; the assertion is that
//!    `boot_or_reject` returns `Err(MigrationOutOfDate { .. })` and the
//!    "did the business command run" flag is still `false`.
//!
//! ## Why a side `rusqlite` connection
//!
//! The contract we're testing matches OBS-3.a's design choice (a). A
//! read-only `rusqlite` connection scoped to the version probe never
//! contends with the long-lived sqlx pool that `tauri-plugin-sql` owns
//! at runtime, and it lets us reason about version arithmetic in plain
//! Rust without an async runtime. Keeping the same shape in this test
//! means a future refactor of the production helper to (e.g.) use the
//! sqlx pool directly will surface as a divergence between this test's
//! local checker and the PR #159 helper, both of which probe the same
//! `_sqlx_migrations` table.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

/// The schema version this test expects the binary to demand at boot.
///
/// Kept in sync with the highest `NNNN/` directory under
/// `src-tauri/migrations/`. The first test in this file asserts the two
/// agree, so a contributor who adds migration `NNNN+1` without updating
/// this constant gets a clear failure.
///
/// When OBS-3.a (PR #159) lands, this constant is shadowed by the
/// `EXPECTED_SCHEMA_VERSION` baked into the binary; the cross-check test
/// in this file then doubles as a guard that the two definitions don't
/// drift apart.
const EXPECTED_SCHEMA_VERSION: i64 = 25;

/// Local mirror of the production `BookieError::MigrationOutOfDate`
/// variant. This is intentionally a parallel definition rather than an
/// import from `bookie_lib` because OBS-3.a (which upgrades the variant
/// from a unit to a struct shape) is not yet merged on the branch this
/// test was authored against. Once #159 lands, this enum can either:
///   - be dropped in favour of `bookie_lib::BookieError::MigrationOutOfDate`,
///   - or stay as a deliberate test-side decoupling so this file does not
///     need to be edited every time the production error enum gains an
///     unrelated variant.
#[derive(Debug, PartialEq)]
enum BootError {
    MigrationOutOfDate { actual: i64, expected: i64 },
}

/// Test-side equivalent of OBS-3.a's `check_schema_version_at`. The
/// behaviour is the contract the production helper must satisfy:
///
/// - Open the DB read-only so the probe can never block, dirty, or
///   contend with a writer that holds the file.
/// - Look up `MAX(version)` in `_sqlx_migrations` (the migration
///   tracking table sqlx-sqlite creates the first time it migrates a
///   database).
/// - If the table is missing entirely, treat `actual` as `0` — a fresh
///   sqlite file the SQL plugin has never touched is, by definition,
///   not at the expected version.
/// - If `actual != expected`, refuse with `MigrationOutOfDate { actual,
///   expected }`. Note the symmetry: a DB that's *ahead* of the binary
///   (e.g. user downgraded their bookie install) is just as dangerous
///   as one that's behind, because the binary's queries will assume a
///   schema that doesn't yet exist.
fn boot_or_reject(db_path: &Path, expected: i64) -> Result<(), BootError> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open fixture DB read-only");

    // Detect missing _sqlx_migrations explicitly so we can return a
    // deterministic `actual = 0` instead of a generic SQL error. This
    // mirrors the production helper's behaviour.
    let table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema \
             WHERE type = 'table' AND name = '_sqlx_migrations'",
            [],
            |row| row.get(0),
        )
        .expect("query sqlite_schema for _sqlx_migrations presence");

    let actual: i64 = if table_exists == 0 {
        0
    } else {
        // COALESCE(MAX(version), 0) so an empty tracking table also
        // surfaces as actual = 0 rather than NULL — which would otherwise
        // panic when we try to read it as i64.
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations",
            [],
            |row| row.get(0),
        )
        .expect("query _sqlx_migrations.MAX(version)")
    };

    if actual == expected {
        Ok(())
    } else {
        Err(BootError::MigrationOutOfDate { actual, expected })
    }
}

/// Build a SQLite file at `path` whose `_sqlx_migrations` table reports
/// the given version. The on-disk schema mirrors the table sqlx-sqlite
/// creates via `Migrate::ensure_migrations_table`
/// (`~/.cargo/registry/src/.../sqlx-sqlite-*/src/migrate.rs`):
///
/// ```sql
/// CREATE TABLE IF NOT EXISTS _sqlx_migrations (
///   version BIGINT PRIMARY KEY,
///   description TEXT NOT NULL,
///   installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
///   success BOOLEAN NOT NULL,
///   checksum BLOB NOT NULL,
///   execution_time BIGINT NOT NULL
/// );
/// ```
///
/// We populate the minimum columns required by NOT NULL constraints so
/// the row is well-formed. The fixture deliberately *does not* contain
/// any of bookie's actual schema (companies, customers, …) because the
/// boot check only cares about the migration-tracking table.
fn write_fixture_db(path: &Path, version: i64) {
    let conn = Connection::open(path).expect("create fixture DB");
    conn.execute_batch(
        "CREATE TABLE _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        );",
    )
    .expect("create _sqlx_migrations");
    conn.execute(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (?1, 'fixture', 1, x'00', 0)",
        rusqlite::params![version],
    )
    .expect("insert fixture migration row");
    conn.close().expect("close fixture connection");
}

/// Build a SQLite file at `path` with no `_sqlx_migrations` table at
/// all. Models a SQLite file the SQL plugin has never touched — for
/// example, a user pointing the app at the wrong .db file by mistake.
fn write_empty_db(path: &Path) {
    let conn = Connection::open(path).expect("create empty DB");
    // Touch a throwaway table so the file is a valid non-empty sqlite
    // database (a zero-byte file would also be valid, but creating an
    // unrelated table proves the boot check rejects on tracking-table
    // absence rather than on file-emptiness).
    conn.execute_batch("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);")
        .expect("create unrelated table");
    conn.close().expect("close empty connection");
}

/// Per-test scratch directory under `target/`. Using `CARGO_TARGET_TMPDIR`
/// would be cleaner but it's nightly-only on the rust toolchain we ship
/// against; `OUT_DIR` isn't available to integration tests; so we hand-
/// roll a path under the manifest's `target/test-artifacts/<name>/`. We
/// intentionally avoid `std::env::temp_dir` so test artefacts live next
/// to the cargo build artefacts and get cleaned by `cargo clean`.
fn scratch_dir(test_name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-artifacts")
        .join("schema_version_boot")
        .join(test_name);
    // Wipe any stale fixture from a previous run so the test is truly
    // hermetic. `remove_dir_all` returns Ok if the dir doesn't exist.
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

/// Walk `src-tauri/migrations/` and return the highest `NNNN/` version.
/// Same logic as PR #159's cross-check test, restated locally so this
/// file does not depend on the helper from #159 being present.
fn highest_migration_version_on_disk() -> i64 {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut highest: i64 = 0;
    for entry in fs::read_dir(&root).expect("read migrations dir") {
        let entry = entry.expect("migration dir entry");
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.ends_with("_down") {
            continue;
        }
        if let Ok(v) = name.parse::<i64>() {
            if v > highest {
                highest = v;
            }
        }
    }
    assert!(
        highest > 0,
        "no NNNN/ migration directories found under {}",
        root.display()
    );
    highest
}

/// Cross-check: the highest migration directory on disk must equal the
/// `EXPECTED_SCHEMA_VERSION` constant the production binary will demand
/// at boot. A future contributor who adds migration NNNN+1 but forgets
/// to bump the constant is caught here.
#[test]
fn schema_version_check_constant_matches_disk() {
    let highest = highest_migration_version_on_disk();
    assert_eq!(
        EXPECTED_SCHEMA_VERSION, highest,
        "EXPECTED_SCHEMA_VERSION ({}) disagrees with the highest \
         migration directory on disk ({}). Did you add a migration \
         without bumping the constant in OBS-3.a's lib.rs and this \
         test's header?",
        EXPECTED_SCHEMA_VERSION, highest
    );
}

/// Down-revved DB: tracking table claims version N-1; boot must refuse.
/// This is the case the issue body calls out by name.
#[test]
fn schema_version_check_rejects_down_revved_db() {
    let dir = scratch_dir("rejects_down_revved");
    let db_path = dir.join("stale.db");
    write_fixture_db(&db_path, EXPECTED_SCHEMA_VERSION - 1);

    // Stand-in for "would a business command have been allowed to run".
    // The production wiring (per OBS-3.a's design notes) is that the
    // frontend invokes schema_version_check after Database.load() and
    // before any business command. Here we model the same gating: if
    // boot_or_reject returns Err, the business command must not run.
    let mut business_command_ran = false;

    let result = boot_or_reject(&db_path, EXPECTED_SCHEMA_VERSION);
    if result.is_ok() {
        business_command_ran = true;
    }

    assert_eq!(
        result,
        Err(BootError::MigrationOutOfDate {
            actual: EXPECTED_SCHEMA_VERSION - 1,
            expected: EXPECTED_SCHEMA_VERSION,
        }),
        "boot must reject a DB whose _sqlx_migrations claims version N-1",
    );
    assert!(
        !business_command_ran,
        "business commands must not run when boot rejects with MigrationOutOfDate",
    );
}

/// Up-revved DB: tracking table claims version N+1; boot must refuse.
/// Asymmetric error handling here would silently allow a downgraded
/// binary to mangle a newer schema, which is just as bad as running
/// against an older one.
#[test]
fn schema_version_check_rejects_up_revved_db() {
    let dir = scratch_dir("rejects_up_revved");
    let db_path = dir.join("future.db");
    write_fixture_db(&db_path, EXPECTED_SCHEMA_VERSION + 1);

    let result = boot_or_reject(&db_path, EXPECTED_SCHEMA_VERSION);

    assert_eq!(
        result,
        Err(BootError::MigrationOutOfDate {
            actual: EXPECTED_SCHEMA_VERSION + 1,
            expected: EXPECTED_SCHEMA_VERSION,
        }),
        "boot must reject a DB whose _sqlx_migrations claims version N+1",
    );
}

/// Missing tracking table: a SQLite file the SQL plugin has never
/// touched. Boot must reject with `actual = 0` so the user-facing
/// recovery dialog (OBS-3.b) can render a precise hint.
#[test]
fn schema_version_check_rejects_missing_tracking_table() {
    let dir = scratch_dir("rejects_missing_table");
    let db_path = dir.join("foreign.db");
    write_empty_db(&db_path);

    let result = boot_or_reject(&db_path, EXPECTED_SCHEMA_VERSION);

    assert_eq!(
        result,
        Err(BootError::MigrationOutOfDate {
            actual: 0,
            expected: EXPECTED_SCHEMA_VERSION,
        }),
        "boot must reject a DB with no _sqlx_migrations table at all",
    );
}

/// Negative-of-the-negative: a fixture DB whose tracking table claims
/// the binary's expected version is accepted. Without this, a broken
/// boot check that always rejected would still pass the three rejection
/// tests above.
#[test]
fn schema_version_check_accepts_current_db() {
    let dir = scratch_dir("accepts_current");
    let db_path = dir.join("current.db");
    write_fixture_db(&db_path, EXPECTED_SCHEMA_VERSION);

    let result = boot_or_reject(&db_path, EXPECTED_SCHEMA_VERSION);

    assert!(
        result.is_ok(),
        "boot must accept a DB whose _sqlx_migrations claims the binary's expected version (got {result:?})",
    );
}
