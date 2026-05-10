//! OBS-3.a: integration test for `check_schema_version_at`.
//!
//! Builds a fixture SQLite file on disk, populates `_sqlx_migrations` with
//! a single row whose `version` column equals N, N-1, or N+1, and asserts
//! the runtime check returns the right `BookieError` shape.
//!
//! The fixture mimics the table that
//! `sqlx_sqlite::migrate::Migrate::ensure_migrations_table` creates at
//! runtime (see sqlx-sqlite/src/migrate.rs). If the plugin/sqlx schema
//! ever changes, both this fixture and the Rust check in `lib.rs` need to
//! be updated together.
//!
//! Why a file on disk instead of `:memory:`? `check_schema_version_at`
//! takes a `&Path`, opens its own `rusqlite` connection, and reads the
//! file. An in-memory DB belongs to the connection that created it, so it
//! cannot be observed from a second connection.

use std::path::PathBuf;

use bookie_lib::{check_schema_version_at, BookieError, EXPECTED_SCHEMA_VERSION};

/// Create a fresh SQLite file at `path`, create the `_sqlx_migrations`
/// table with the same schema sqlx-sqlite uses, and insert a single row
/// whose `version` is `version`. `success = 1` so the row counts as
/// applied.
fn write_fixture_db(path: &std::path::Path, version: i64) {
    // Ensure no stale file from a previous run.
    let _ = std::fs::remove_file(path);

    let conn = rusqlite::Connection::open(path).expect("open fixture db");
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        );
        "#,
    )
    .expect("create _sqlx_migrations");

    conn.execute(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (?1, 'fixture', 1, X'00', 0)",
        rusqlite::params![version],
    )
    .expect("insert fixture row");
}

/// Helper: create a unique path in the test temp dir.
fn fixture_path(suffix: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "bookie-obs3a-{}-{}-{}.db",
        suffix,
        std::process::id(),
        // Per-test nanosecond uniquifier so parallel `cargo test` runs
        // don't collide on a shared temp file.
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    p
}

#[test]
fn schema_version_matches_expected_returns_ok() {
    let path = fixture_path("match");
    write_fixture_db(&path, EXPECTED_SCHEMA_VERSION);

    let result = check_schema_version_at(&path, EXPECTED_SCHEMA_VERSION);

    let _ = std::fs::remove_file(&path);
    assert!(
        result.is_ok(),
        "expected Ok for matching version, got {result:?}"
    );
}

#[test]
fn schema_version_one_behind_returns_migration_out_of_date() {
    let path = fixture_path("behind");
    let actual_version = EXPECTED_SCHEMA_VERSION - 1;
    write_fixture_db(&path, actual_version);

    let result = check_schema_version_at(&path, EXPECTED_SCHEMA_VERSION);

    let _ = std::fs::remove_file(&path);
    match result {
        Err(BookieError::MigrationOutOfDate { actual, expected }) => {
            assert_eq!(actual, actual_version);
            assert_eq!(expected, EXPECTED_SCHEMA_VERSION);
        }
        other => panic!("expected MigrationOutOfDate, got {other:?}"),
    }
}

#[test]
fn schema_version_one_ahead_returns_migration_out_of_date() {
    let path = fixture_path("ahead");
    let actual_version = EXPECTED_SCHEMA_VERSION + 1;
    write_fixture_db(&path, actual_version);

    let result = check_schema_version_at(&path, EXPECTED_SCHEMA_VERSION);

    let _ = std::fs::remove_file(&path);
    match result {
        Err(BookieError::MigrationOutOfDate { actual, expected }) => {
            assert_eq!(actual, actual_version);
            assert_eq!(expected, EXPECTED_SCHEMA_VERSION);
        }
        other => panic!("expected MigrationOutOfDate, got {other:?}"),
    }
}

#[test]
fn schema_version_missing_table_returns_migration_out_of_date_zero() {
    // A freshly-created SQLite file with no `_sqlx_migrations` table at
    // all (e.g. the plugin hasn't run yet, or someone copied an empty
    // file in by hand). The check must NOT silently accept this — it
    // must surface the same MigrationOutOfDate signal so the frontend's
    // hard-stop screen shows.
    let path = fixture_path("empty");
    let _ = std::fs::remove_file(&path);
    rusqlite::Connection::open(&path).expect("create empty db");

    let result = check_schema_version_at(&path, EXPECTED_SCHEMA_VERSION);

    let _ = std::fs::remove_file(&path);
    match result {
        Err(BookieError::MigrationOutOfDate { actual, expected }) => {
            assert_eq!(actual, 0);
            assert_eq!(expected, EXPECTED_SCHEMA_VERSION);
        }
        other => panic!("expected MigrationOutOfDate {{actual: 0,..}}, got {other:?}"),
    }
}

#[test]
fn schema_version_check_is_compatible_with_app_migrations_count() {
    // Cross-check: the highest migration version actually wired into
    // `app_migrations()` must equal `EXPECTED_SCHEMA_VERSION`. If a
    // migration is added without bumping the constant, this test fails
    // before any user sees the boot-time check return a misleading
    // `actual=N+1`.
    //
    // We can't import `app_migrations()` (it's private), so we walk the
    // migrations directory the same way `tests/migrations.rs` does. This
    // duplicates a few lines but keeps the test self-contained and
    // independent of `app_migrations()`'s visibility.
    let migrations_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let max_dir_version: i64 = std::fs::read_dir(&migrations_root)
        .expect("read migrations dir")
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // Skip the `_down/` companion directories; only the up dirs
            // determine the latest version.
            if name.ends_with("_down") {
                return None;
            }
            name.parse::<i64>().ok()
        })
        .max()
        .expect("at least one migration dir");

    assert_eq!(
        max_dir_version, EXPECTED_SCHEMA_VERSION,
        "EXPECTED_SCHEMA_VERSION ({EXPECTED_SCHEMA_VERSION}) is out of sync with the highest \
         migration directory ({max_dir_version}). Bump EXPECTED_SCHEMA_VERSION in src/lib.rs."
    );
}
