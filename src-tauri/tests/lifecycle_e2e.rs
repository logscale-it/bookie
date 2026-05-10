//! TEST-3.b (#89): full lifecycle end-to-end test.
//!
//! Exercises the highest-confidence shippability signal for the app:
//!
//!   create draft  ->  issue  ->  attempt update (must reject)
//!     ->  record payment  ->  back up to S3  ->  compute live DB SHA
//!     ->  wipe DB  ->  restore from S3  ->  assert restored DB SHA equals
//!         pre-restore SHA, all *_cents columns byte-equal, audit trail
//!         rows present.
//!
//! All steps run against:
//!   * a real on-disk SQLite database produced from the same migration SQL
//!     files the production app loads at startup, applied in order via
//!     rusqlite (mirrors `app_migrations()` in `src/lib.rs`);
//!   * a real ephemeral MinIO container, started via the `fixtures::minio`
//!     helper that the production-side `restore_db_backup` would also talk
//!     to (the fixture mirrors `S3Config::build_client`'s wire settings:
//!     path-style addressing, `behavior_version_latest`, checksum policy
//!     `WhenRequired`); and
//!   * the same restore primitives `src/lib.rs` uses (`<dbpath>.restore.tmp`
//!     in the same parent directory, `fs::rename` for the atomic swap,
//!     parent-dir `fsync` on Unix).
//!
//! Gated behind `--features e2e` because it depends on Docker (for MinIO).
//! Reviewer command:
//!
//! ```text
//! cargo test --features e2e --manifest-path src-tauri/Cargo.toml \
//!     -- --nocapture lifecycle
//! ```
//!
//! See PR for TEST-3.a (#141, MERGED — MinIO fixture) and the dependency
//! chain documented in the issue body.

#![cfg(feature = "e2e")]

mod fixtures;

use std::{
    fs,
    path::{Path, PathBuf},
};

use aws_sdk_s3::primitives::ByteStream;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Test entry point
// ---------------------------------------------------------------------------

/// Full lifecycle round-trip. Single test function so the assertions read
/// linearly in the stated order — failures at any step report against a
/// clearly named line rather than a separately-named test case.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lifecycle_round_trip() {
    // -----------------------------------------------------------------------
    // 0. Bring up an isolated workspace + a fresh MinIO container.
    // -----------------------------------------------------------------------
    let work = unique_tmpdir("lifecycle");
    let db_path = work.join("bookie.db");

    let minio = fixtures::minio::MinioFixture::start().await;
    minio.ensure_bucket().await;
    // Log the dynamically-allocated endpoint port so test failures land with
    // enough context to reproduce a manual `aws s3` call against the same
    // container. Also keeps `MinioFixture::endpoint_url` from being dead
    // code in this test crate (cargo treats each `tests/*.rs` as a separate
    // binary, and the smoke test is the only other consumer).
    eprintln!(
        "lifecycle: MinIO endpoint={}, bucket={}",
        minio.endpoint_url(),
        minio.bucket(),
    );
    let s3 = minio.s3_client().await;
    let bucket = minio.bucket().to_string();
    let backup_key = "backups/lifecycle-e2e.db".to_string();
    let sidecar_key = format!("{backup_key}.sha256");

    // -----------------------------------------------------------------------
    // 1. Create a fresh on-disk SQLite DB and apply every migration in
    //    order, exactly the way the running app would on first start-up.
    // -----------------------------------------------------------------------
    let conn = open_db_with_migrations(&db_path);

    // -----------------------------------------------------------------------
    // 2. Insert a company + customer so the FK constraints on `invoices`
    //    are satisfied. Use stable values so the lifecycle is deterministic.
    // -----------------------------------------------------------------------
    conn.execute(
        "INSERT INTO companies (name, country_code) VALUES (?1, ?2)",
        params!["Bookie GmbH", "DE"],
    )
    .expect("insert company");
    let company_id: i64 = conn
        .query_row(
            "SELECT id FROM companies WHERE name = ?1",
            ["Bookie GmbH"],
            |r| r.get(0),
        )
        .expect("read company id");

    conn.execute(
        "INSERT INTO customers (company_id, name, country_code) VALUES (?1, ?2, ?3)",
        params![company_id, "Acme AG", "DE"],
    )
    .expect("insert customer");
    let customer_id: i64 = conn
        .query_row(
            "SELECT id FROM customers WHERE company_id = ?1 AND name = ?2",
            params![company_id, "Acme AG"],
            |r| r.get(0),
        )
        .expect("read customer id");

    // -----------------------------------------------------------------------
    // 3. Insert a DRAFT invoice. Money values are written into both the
    //    legacy REAL columns and the *_cents columns (DAT-1.f); the
    //    lifecycle assertion at the end checks that *_cents survives the
    //    backup/restore round-trip byte-for-byte.
    // -----------------------------------------------------------------------
    let invoice_number = "RE-2026-0001";
    let net_cents: i64 = 100_000; // 1000.00 EUR
    let tax_cents: i64 = 19_000; //   190.00 EUR (19 % VAT)
    let gross_cents: i64 = net_cents + tax_cents;

    conn.execute(
        "INSERT INTO invoices ( \
             company_id, customer_id, invoice_number, status, issue_date, \
             currency, net_amount, tax_amount, gross_amount, \
             net_cents, tax_cents, gross_cents \
         ) VALUES (?1, ?2, ?3, 'draft', '2026-05-10', 'EUR', \
                   ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            company_id,
            customer_id,
            invoice_number,
            (net_cents as f64) / 100.0,
            (tax_cents as f64) / 100.0,
            (gross_cents as f64) / 100.0,
            net_cents,
            tax_cents,
            gross_cents,
        ],
    )
    .expect("insert draft invoice");
    let invoice_id: i64 = conn
        .query_row(
            "SELECT id FROM invoices WHERE invoice_number = ?1",
            [invoice_number],
            |r| r.get(0),
        )
        .expect("read invoice id");

    conn.execute(
        "INSERT INTO invoice_items ( \
             invoice_id, position, description, quantity, unit_price_net, \
             tax_rate, line_total_net, unit_price_net_cents, line_total_net_cents \
         ) VALUES (?1, 0, 'Beratung Mai 2026', 10, 100.0, 19.0, 1000.0, 10000, 100000)",
        params![invoice_id],
    )
    .expect("insert invoice item");

    // -----------------------------------------------------------------------
    // 4. ISSUE the invoice. The DAT-2.a immutability triggers only fire
    //    when status leaves 'draft'; transitioning to 'sent' is allowed.
    // -----------------------------------------------------------------------
    conn.execute(
        "UPDATE invoices SET status = 'sent' WHERE id = ?1",
        params![invoice_id],
    )
    .expect("issue invoice (status -> sent)");

    // -----------------------------------------------------------------------
    // 5. Attempt to mutate an immutable column on the issued invoice.
    //    The trigger must abort with the SQLite error message
    //    `invoice_immutable` -- this is the wire contract `BookieError::
    //    InvoiceImmutable` is mapped from in the production code path.
    // -----------------------------------------------------------------------
    let mutate_err = conn
        .execute(
            "UPDATE invoices SET net_cents = net_cents + 1 WHERE id = ?1",
            params![invoice_id],
        )
        .expect_err("mutating an issued invoice must be rejected by the trigger");
    let mutate_msg = mutate_err.to_string();
    assert!(
        mutate_msg.contains("invoice_immutable"),
        "expected immutability trigger to fire, got: {mutate_msg}"
    );

    // Sanity: the row's cents are unchanged after the failed mutation.
    let post_attempt_net: i64 = conn
        .query_row(
            "SELECT net_cents FROM invoices WHERE id = ?1",
            params![invoice_id],
            |r| r.get(0),
        )
        .expect("re-read net_cents");
    assert_eq!(
        post_attempt_net, net_cents,
        "rejected mutation must not have side effects"
    );

    // -----------------------------------------------------------------------
    // 6. Record a payment for the full gross amount. Status transitions
    //    on issued invoices are explicitly allowed by the immutability
    //    trigger column list (status / updated_at / s3_key are exempt).
    // -----------------------------------------------------------------------
    conn.execute(
        "INSERT INTO payments (invoice_id, payment_date, amount, amount_cents, method) \
         VALUES (?1, '2026-05-15', ?2, ?3, 'sepa')",
        params![invoice_id, (gross_cents as f64) / 100.0, gross_cents],
    )
    .expect("insert payment");

    conn.execute(
        "UPDATE invoices SET status = 'paid' WHERE id = ?1",
        params![invoice_id],
    )
    .expect("transition status sent -> paid");

    // -----------------------------------------------------------------------
    // 7. Close the connection and snapshot the live DB bytes + SHA-256.
    //    Closing first ensures all journal pages are flushed -- matters
    //    even in DELETE journal mode for an open WAL'd handle.
    // -----------------------------------------------------------------------
    drop(conn);

    let pre_backup_bytes = fs::read(&db_path).expect("read live DB");
    assert!(
        is_sqlite_file(&pre_backup_bytes),
        "live DB must start with the SQLite magic header"
    );
    let pre_backup_digest = sha256_hex(&pre_backup_bytes);
    eprintln!(
        "lifecycle: live DB size={} bytes, sha256={}",
        pre_backup_bytes.len(),
        pre_backup_digest
    );

    // -----------------------------------------------------------------------
    // 8. BACK UP to MinIO. Mirrors `s3_upload_file`'s production-side
    //    behaviour: the backup blob plus a `<key>.sha256` sidecar
    //    containing the lowercase hex SHA-256 of the blob (REL-1.a).
    // -----------------------------------------------------------------------
    s3.put_object()
        .bucket(&bucket)
        .key(&backup_key)
        .body(ByteStream::from(pre_backup_bytes.clone()))
        .content_length(pre_backup_bytes.len() as i64)
        .content_type("application/octet-stream")
        .send()
        .await
        .expect("S3 upload of backup blob");

    s3.put_object()
        .bucket(&bucket)
        .key(&sidecar_key)
        .body(ByteStream::from(pre_backup_digest.clone().into_bytes()))
        .content_length(pre_backup_digest.len() as i64)
        .content_type("text/plain")
        .send()
        .await
        .expect("S3 upload of sidecar");

    // -----------------------------------------------------------------------
    // 9. WIPE the live DB. Also remove any WAL/SHM siblings the way
    //    `restore_db_backup` does in step 7 of its flow, so we leave the
    //    parent directory in the same shape the production restore path
    //    expects.
    // -----------------------------------------------------------------------
    let (wal_path, shm_path) = wal_shm_siblings(&db_path);
    let _ = fs::remove_file(&db_path);
    let _ = fs::remove_file(&wal_path);
    let _ = fs::remove_file(&shm_path);
    assert!(!db_path.exists(), "live DB should be gone after wipe");

    // -----------------------------------------------------------------------
    // 10. RESTORE from MinIO. Mirrors `restore_db_backup` exactly:
    //     1) download blob into `<db>.restore.tmp` in the same parent;
    //     2) download sidecar; verify shape (64 lowercase hex chars) and
    //        SHA-256 of the .tmp file matches; abort + clean up on any
    //        mismatch (`BackupSidecarMismatch`);
    //     3) magic-header sanity check on the .tmp bytes;
    //     4) atomic rename .tmp -> live;
    //     5) fsync the parent directory on Unix.
    // -----------------------------------------------------------------------
    let tmp_path = restore_tmp_path(&db_path);
    let _ = fs::remove_file(&tmp_path);

    let blob_resp = s3
        .get_object()
        .bucket(&bucket)
        .key(&backup_key)
        .send()
        .await
        .expect("S3 download of backup blob");
    let blob_bytes = blob_resp
        .body
        .collect()
        .await
        .expect("collect blob body")
        .into_bytes()
        .to_vec();
    fs::write(&tmp_path, &blob_bytes).expect("write restore tmp");

    let sidecar_resp = s3
        .get_object()
        .bucket(&bucket)
        .key(&sidecar_key)
        .send()
        .await
        .expect("S3 download of sidecar");
    let sidecar_text = std::str::from_utf8(
        sidecar_resp
            .body
            .collect()
            .await
            .expect("collect sidecar body")
            .into_bytes()
            .as_ref(),
    )
    .expect("sidecar must be utf-8")
    .trim()
    .to_string();
    assert_eq!(sidecar_text.len(), 64, "sidecar must be 64 hex chars");
    assert!(
        sidecar_text
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "sidecar must be lowercase hex (REL-1.a contract)"
    );

    let tmp_bytes = fs::read(&tmp_path).expect("re-read restore tmp");
    let tmp_digest = sha256_hex(&tmp_bytes);
    assert_eq!(
        tmp_digest, sidecar_text,
        "downloaded blob digest must match sidecar (REL-1.b/c contract)"
    );
    assert!(
        is_sqlite_file(&tmp_bytes),
        "downloaded blob must pass the SQLite magic-header check"
    );

    // Atomic rename: same-parent rename is atomic on Unix; on Windows
    // `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` is also effectively atomic.
    fs::rename(&tmp_path, &db_path).expect("atomic swap restore tmp -> live");
    fsync_parent_dir(&db_path).expect("fsync parent dir after restore swap");

    // -----------------------------------------------------------------------
    // 11. ASSERT integrity post-restore.
    //
    //     a) Whole-file SHA-256 byte equality (the central acceptance
    //        criterion: "restored DB SHA == pre-restore SHA").
    //     b) All `*_cents` values for the round-tripped invoice are
    //        byte-equal (DAT-1.d/f integer-cents path survives).
    //     c) Audit trail rows are present for the operations we
    //        performed (DAT-4.b/c — the audit log must travel with the
    //        backup).
    //     d) Re-opening the DB and reading it through SQLite still works
    //        (sanity for DB-engine-level corruption that a SHA match
    //        would not catch -- here we additionally PRAGMA integrity_check).
    // -----------------------------------------------------------------------
    let post_restore_bytes = fs::read(&db_path).expect("read restored live DB");
    let post_restore_digest = sha256_hex(&post_restore_bytes);
    assert_eq!(
        post_restore_digest, pre_backup_digest,
        "restored DB SHA-256 must equal pre-backup SHA-256 (lifecycle byte-equality)"
    );
    assert_eq!(
        post_restore_bytes, pre_backup_bytes,
        "restored DB bytes must equal pre-backup bytes (defense in depth vs. SHA collision)"
    );

    let restored = Connection::open(&db_path).expect("re-open restored DB");
    let integrity: String = restored
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .expect("integrity check");
    assert_eq!(
        integrity, "ok",
        "restored DB must pass PRAGMA integrity_check"
    );

    let (r_net, r_tax, r_gross): (i64, i64, i64) = restored
        .query_row(
            "SELECT net_cents, tax_cents, gross_cents FROM invoices WHERE id = ?1",
            params![invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("read invoice cents post-restore");
    assert_eq!(r_net, net_cents, "net_cents must round-trip byte-equal");
    assert_eq!(r_tax, tax_cents, "tax_cents must round-trip byte-equal");
    assert_eq!(
        r_gross, gross_cents,
        "gross_cents must round-trip byte-equal"
    );

    let r_status: String = restored
        .query_row(
            "SELECT status FROM invoices WHERE id = ?1",
            params![invoice_id],
            |r| r.get(0),
        )
        .expect("read invoice status post-restore");
    assert_eq!(
        r_status, "paid",
        "invoice status must round-trip post-restore"
    );

    let r_payment_cents: i64 = restored
        .query_row(
            "SELECT amount_cents FROM payments WHERE invoice_id = ?1",
            params![invoice_id],
            |r| r.get(0),
        )
        .expect("read payment amount post-restore");
    assert_eq!(
        r_payment_cents, gross_cents,
        "payment amount_cents must round-trip"
    );

    // Audit trail: every life-cycle event we performed lands at least one
    // row in `invoice_audit`. Counted per (entity_type, op) tuple so a
    // missing trigger surfaces as a precise mismatch rather than a single
    // "non-zero" assertion.
    let count = |entity_type: &str, op: &str| -> i64 {
        restored
            .query_row(
                "SELECT COUNT(*) FROM invoice_audit \
                 WHERE entity_type = ?1 AND op = ?2 AND entity_id = ?3",
                params![entity_type, op, invoice_id],
                |r| r.get(0),
            )
            .expect("count audit rows")
    };

    let invoices_inserts = count("invoices", "insert");
    // status: draft -> sent, sent -> paid (the rejected mutation must NOT
    // have written an audit row -- the trigger aborts the statement).
    let invoices_updates = count("invoices", "update");
    let items_inserts = count("invoice_items", "insert");
    let payments_inserts = count("payments", "insert");

    assert_eq!(
        invoices_inserts, 1,
        "exactly one invoices INSERT audit row expected"
    );
    assert_eq!(
        invoices_updates, 2,
        "exactly two invoices UPDATE audit rows expected (draft->sent, sent->paid)"
    );
    assert_eq!(
        items_inserts, 1,
        "exactly one invoice_items INSERT audit row expected"
    );
    assert_eq!(
        payments_inserts, 1,
        "exactly one payments INSERT audit row expected"
    );

    // Best-effort cleanup of the workspace; non-fatal if it fails because
    // every fixture lives under `std::env::temp_dir()` which the OS reaps.
    drop(restored);
    let _ = fs::remove_dir_all(&work);
}

// ---------------------------------------------------------------------------
// Helpers (mirror the production-side restore primitives in `src/lib.rs`)
// ---------------------------------------------------------------------------

/// Same suffix `restore_db_backup` uses for the temporary download target.
/// Appended (not extension-swap) so the tmp file lives in the same parent
/// directory as the live DB -- a precondition for `rename(2)` atomicity.
const RESTORE_TMP_SUFFIX: &str = ".restore.tmp";

fn restore_tmp_path(db_path: &Path) -> PathBuf {
    let mut name = db_path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(RESTORE_TMP_SUFFIX);
    match db_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

fn wal_shm_siblings(db_path: &Path) -> (PathBuf, PathBuf) {
    let mut wal_name = db_path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    wal_name.push("-wal");
    let mut shm_name = db_path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    shm_name.push("-shm");
    let parent = db_path.parent().unwrap_or_else(|| Path::new(""));
    (parent.join(wal_name), parent.join(shm_name))
}

fn fsync_parent_dir(child: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        if let Some(parent) = child.parent() {
            if !parent.as_os_str().is_empty() {
                let dir = fs::File::open(parent)?;
                dir.sync_all()?;
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = child;
        Ok(())
    }
}

/// SQLite magic header bytes: "SQLite format 3\0".
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

fn is_sqlite_file(bytes: &[u8]) -> bool {
    bytes.len() >= SQLITE_MAGIC.len() && &bytes[..SQLITE_MAGIC.len()] == SQLITE_MAGIC
}

fn sha256_hex(data: &[u8]) -> String {
    use std::fmt::Write;
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.as_slice() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Create a fresh per-test workspace under `std::env::temp_dir()`.
fn unique_tmpdir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("bookie-test3b-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("create tmpdir");
    dir
}

// ---------------------------------------------------------------------------
// Migration loader (mirrors `app_migrations()` in `src/lib.rs`)
// ---------------------------------------------------------------------------

/// Open a fresh SQLite database at `db_path` and apply every migration in
/// the on-disk `migrations/NNNN/` directories in ascending numeric order.
///
/// We deliberately read the SQL files at runtime rather than bundling them
/// via `include_str!` so that adding a new migration does not require
/// touching this test. The migration round-trip harness
/// (`tests/migrations.rs`) takes the same approach for the same reason.
fn open_db_with_migrations(db_path: &Path) -> Connection {
    let conn = Connection::open(db_path).expect("open sqlite");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");

    let migrations_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut versions: Vec<(u32, PathBuf)> = fs::read_dir(&migrations_root)
        .unwrap_or_else(|e| panic!("read migrations dir {}: {e}", migrations_root.display()))
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let name = path.file_name()?.to_str()?.to_owned();
            if name.ends_with("_down") {
                return None;
            }
            let version: u32 = name.parse().ok()?;
            Some((version, path))
        })
        .collect();
    versions.sort_by_key(|(v, _)| *v);
    assert!(
        !versions.is_empty(),
        "no migrations discovered under {}",
        migrations_root.display()
    );

    for (version, dir) in versions {
        let sql = read_migration_sql(&dir);
        conn.execute_batch(&sql)
            .unwrap_or_else(|e| panic!("apply migration {version:04} failed: {e}"));
    }
    conn
}

fn read_migration_sql(dir: &Path) -> String {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read migration dir {}: {e}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("sql"))
        })
        .collect();
    files.sort();

    let mut script = String::new();
    for path in files {
        let contents = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read SQL file {}: {e}", path.display()));
        script.push_str(&contents);
        if !script.ends_with('\n') {
            script.push('\n');
        }
    }
    script
}
