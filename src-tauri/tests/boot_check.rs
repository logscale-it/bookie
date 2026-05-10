//! OPS-1.a: integration tests for the `boot_check` pure helpers.
//!
//! The Tauri command itself takes an `AppHandle` and so cannot be driven
//! from an integration test without bringing up the full app. The probes,
//! however, are factored into pure helpers (`probe_app_data_dir`,
//! `probe_keyring`, `probe_schema`) that accept everything they need by
//! reference and return a `BootCheck`. This file exercises those helpers
//! against real on-disk fixtures the same way `schema_version_check.rs`
//! exercises `check_schema_version_at`.
//!
//! Why integration tests on top of the unit tests in `src/lib.rs`? The
//! unit tests live inside `#[cfg(test)] mod` blocks and can see private
//! items. These integration tests can only see the public API, which is
//! exactly what the frontend (and any future Rust caller outside the
//! crate) sees — so they pin the *external* contract that the helpers
//! are public, that their signatures take a `&Path`, and that the
//! `BootStatus` / `BootCheck` types round-trip through serde without
//! losing variants.

use std::path::{Path, PathBuf};

use bookie_lib::{
    probe_app_data_dir, probe_keyring, probe_schema, BookieError, BootCheck, BootStatus,
    EXPECTED_SCHEMA_VERSION,
};

/// Per-test scratch directory under `target/test-artifacts/boot_check/` so
/// artefacts get cleaned by `cargo clean`. Mirrors the pattern in
/// `schema_version_boot.rs`.
fn scratch_dir(test_name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-artifacts")
        .join("boot_check")
        .join(test_name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

/// Build a SQLite fixture with `_sqlx_migrations` populated at `version`,
/// matching the schema sqlx-sqlite creates at runtime. Same shape as
/// `schema_version_check.rs::write_fixture_db`.
fn write_schema_fixture_db(path: &Path, version: i64) {
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

#[test]
fn probe_app_data_dir_succeeds_on_fresh_directory() {
    let dir = scratch_dir("fresh_dir");
    let result = probe_app_data_dir(&dir);
    match result {
        BootCheck::Ok => {}
        other => panic!("expected Ok, got {other:?}"),
    }
}

#[test]
fn probe_app_data_dir_creates_parent_when_absent() {
    // Use a nested path the probe must create. Mirrors fresh-install
    // behaviour where the OS app-data root exists but the per-app
    // directory does not.
    let dir = scratch_dir("create_parent").join("nested").join("appdata");
    assert!(!dir.exists(), "precondition: dir should not exist yet");
    let result = probe_app_data_dir(&dir);
    match result {
        BootCheck::Ok => {}
        other => panic!("expected Ok, got {other:?}"),
    }
    assert!(dir.exists(), "probe must have created the directory");
}

#[test]
fn probe_keyring_returns_well_formed_bootcheck() {
    // The keyring backend may or may not be reachable in the sandbox
    // running this test. Both outcomes are valid — what matters is that
    // the probe never panics and always returns a well-formed BootCheck
    // shape. We accept Ok (backend reachable, even on NoEntry) or
    // Failed { KeyringUnavailable } (backend not reachable).
    let result = probe_keyring(
        "com.ranelkarimov.bookie.test_probe_integration",
        "ops1a_integration_user_does_not_exist",
    );
    match result {
        BootCheck::Ok => {}
        BootCheck::Failed {
            error: BookieError::KeyringUnavailable,
        } => {}
        other => panic!("expected Ok or Failed {{ KeyringUnavailable }}, got {other:?}"),
    }
}

#[test]
fn probe_schema_returns_ok_on_matching_fixture() {
    let dir = scratch_dir("schema_match");
    let db = dir.join("bookie.db");
    write_schema_fixture_db(&db, EXPECTED_SCHEMA_VERSION);

    let result = probe_schema(&db, EXPECTED_SCHEMA_VERSION);
    match result {
        BootCheck::Ok => {}
        other => panic!("expected Ok, got {other:?}"),
    }
}

#[test]
fn probe_schema_returns_failed_on_mismatched_fixture() {
    let dir = scratch_dir("schema_mismatch");
    let db = dir.join("bookie.db");
    let actual = EXPECTED_SCHEMA_VERSION - 1;
    write_schema_fixture_db(&db, actual);

    let result = probe_schema(&db, EXPECTED_SCHEMA_VERSION);
    match result {
        BootCheck::Failed {
            error:
                BookieError::MigrationOutOfDate {
                    actual: got_actual,
                    expected: got_expected,
                },
        } => {
            assert_eq!(got_actual, actual);
            assert_eq!(got_expected, EXPECTED_SCHEMA_VERSION);
        }
        other => panic!("expected Failed {{ MigrationOutOfDate }}, got {other:?}"),
    }
}

#[test]
fn probe_schema_returns_failed_on_missing_db_file() {
    let dir = scratch_dir("schema_missing");
    let db = dir.join("does_not_exist.db");
    assert!(!db.exists());

    let result = probe_schema(&db, EXPECTED_SCHEMA_VERSION);
    match result {
        BootCheck::Failed {
            error: BookieError::IoError { .. },
        } => {}
        other => panic!("expected Failed {{ IoError }}, got {other:?}"),
    }
}

#[test]
fn boot_status_serde_round_trip_preserves_all_variants() {
    // Pin the JSON contract the frontend sees. If the field names or
    // discriminator move, this test fails first and the TS mirror must
    // be updated in lockstep.
    let status = BootStatus {
        app_data: BootCheck::Ok,
        keyring: BootCheck::Failed {
            error: BookieError::KeyringUnavailable,
        },
        s3: BootCheck::Skipped,
        schema: BootCheck::Failed {
            error: BookieError::MigrationOutOfDate {
                actual: EXPECTED_SCHEMA_VERSION - 1,
                expected: EXPECTED_SCHEMA_VERSION,
            },
        },
    };
    let json = serde_json::to_string(&status).expect("serialise BootStatus");
    let parsed: BootStatus = serde_json::from_str(&json).expect("deserialise BootStatus");
    let json2 = serde_json::to_string(&parsed).expect("re-serialise BootStatus");
    assert_eq!(json, json2);

    // The issue's verification scenario, encoded as a shape assertion:
    // a BootStatus with S3CredsInvalid in the s3 slot must surface that
    // discriminator verbatim, and the other slots must remain unmolested.
    let bad_s3 = BootStatus {
        app_data: BootCheck::Ok,
        keyring: BootCheck::Ok,
        s3: BootCheck::Failed {
            error: BookieError::S3CredsInvalid,
        },
        schema: BootCheck::Ok,
    };
    let json = serde_json::to_string(&bad_s3).unwrap();
    assert!(
        json.contains(r#""s3":{"kind":"Failed","error":{"kind":"S3CredsInvalid"}}"#),
        "expected nested S3CredsInvalid discriminator: {json}"
    );
    assert!(
        json.contains(r#""app_data":{"kind":"Ok"}"#),
        "expected app_data Ok untouched: {json}"
    );
    assert!(
        json.contains(r#""keyring":{"kind":"Ok"}"#),
        "expected keyring Ok untouched: {json}"
    );
    assert!(
        json.contains(r#""schema":{"kind":"Ok"}"#),
        "expected schema Ok untouched: {json}"
    );
}
