//! TEST-3.b (#89): full lifecycle end-to-end test (v2 — distinct filename
//! and test name from the parallel branch behind PR #176 so the two can
//! coexist on disk and either may land first without symbol or path
//! collisions).
//!
//! What this test proves
//! ---------------------
//!
//! End-to-end round-trip across every "could quietly corrupt the books"
//! seam in the app, in one linear sequence so a failure pinpoints the
//! exact step that drifted:
//!
//!   1. Spin up an ephemeral MinIO container via the TEST-3.a fixture.
//!   2. Build a fresh on-disk SQLite DB by replaying the production
//!      migration SQL files (the same ones `app_migrations()` in
//!      `src/lib.rs` includes via `include_str!`).
//!   3. Insert FK ancestors (company, customer) and a *draft* invoice
//!      with explicit `*_cents` values (DAT-1.f cents regression).
//!   4. Issue the invoice (`status: 'draft' -> 'issued'`).
//!   5. Attempt a forbidden mutation (`net_cents`) on the issued row;
//!      assert the DAT-2.a immutability trigger fires with the
//!      `invoice_immutable` SQLite error message — the wire contract
//!      `BookieError::InvoiceImmutable` maps from in `src/lib.rs`.
//!   6. Record a payment (write `amount_cents` alongside legacy `amount`
//!      so the audit trigger sees a fully-populated row).
//!   7. Close the rusqlite connection, snapshot the live DB bytes,
//!      compute the pre-backup SHA-256.
//!   8. Upload the bytes to MinIO via the real `aws-sdk-s3` client plus
//!      a `<key>.sha256` sidecar — same shape REL-1.a/REL-1.c demand.
//!   9. Wipe the DB file (and the WAL/SHM siblings, mirroring the
//!      production restore which also clears them).
//!  10. Restore from MinIO into `<dbpath>.restore.tmp` in the same
//!      parent (`restore_tmp_path` in `src/lib.rs`), verify the sidecar
//!      digest matches the bytes on disk, then atomically `rename(2)`
//!      onto the live DB path and `fsync` the parent dir on Unix.
//!  11. Assert the post-restore SHA-256 equals the pre-backup SHA-256
//!      byte-for-byte; assert every `*_cents` column survived the
//!      round-trip with the exact integer value it started with;
//!      assert the audit trail contains the rows the lifecycle
//!      produced.
//!
//! The test is gated behind `--features e2e` because MinIO runs as a
//! Docker container.  Reviewer command (Docker daemon required):
//!
//! ```text
//! cargo test --features e2e --manifest-path src-tauri/Cargo.toml \
//!     --test lifecycle_e2e_v2 -- --nocapture
//! ```
//!
//! See:
//!   * TEST-3.a (#88, PR #141) — MinIO container fixture.
//!   * REL-1.c (#44, PR #129) — atomic restore primitives this test mirrors.
//!   * DAT-1.f (#56, PR #154) — cents regression invariant.
//!   * DAT-2.c (#59, PR #136) — immutability + storno tests; this test
//!     re-asserts the immutability half end-to-end.
//!   * DAT-4.c (#64, PR #178) — audit row contract.

#![cfg(feature = "e2e")]

mod fixtures;

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use aws_sdk_s3::primitives::ByteStream;
use rusqlite::{params, Connection, OpenFlags};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// SQLite magic header — first 16 bytes of every well-formed SQLite 3 file.
/// Mirrors `SQLITE_MAGIC` in `src/lib.rs` and lets the restore path reject
/// a payload that is clearly not a database file before swapping it in.
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// Suffix appended to the live DB path to derive the staging file used
/// during atomic restore. Must match the production helper
/// (`RESTORE_TMP_SUFFIX` in `src/lib.rs`) so the test exercises the same
/// rename target shape.
const RESTORE_TMP_SUFFIX: &str = ".restore.tmp";

/// S3 key for the backup blob. The sidecar is uploaded at
/// `{BACKUP_KEY}.sha256` (same convention as REL-1.a's
/// `upload_sha256_sidecar` in `src/lib.rs`).
const BACKUP_KEY: &str = "lifecycle-v2/backup.db";

// ---------------------------------------------------------------------------
// 0. Workspace + migration replay helpers
// ---------------------------------------------------------------------------

/// Build a fresh per-run scratch directory under
/// `target/test-artifacts/lifecycle_e2e_v2/<timestamp>/`. Co-locating with
/// build artefacts means `cargo clean` collects them; the timestamp keeps
/// reruns from clobbering each other if Drop order races during a panic.
fn fresh_workdir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-artifacts")
        .join("lifecycle_e2e_v2")
        .join(format!("run-{nanos}"));
    fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

/// Resolve `<crate>/migrations/`.
fn migrations_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations")
}

/// Concatenate every `*.sql` file in `dir` (sorted lexicographically) into
/// one batch script. The on-disk numeric prefixes (`00_pragma.sql`,
/// `01_companies.sql`, …) double as the deterministic execution order, so
/// alphabetic sort matches the production application order.
fn read_migration_sql(dir: &Path) -> String {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read migration dir {}: {e}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("sql"))
        })
        .collect();
    files.sort();

    let mut script = String::new();
    for path in files {
        let body = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read SQL file {}: {e}", path.display()));
        script.push_str(&body);
        if !script.ends_with('\n') {
            script.push('\n');
        }
    }
    script
}

/// Open a fresh SQLite database at `db_path` and apply every numeric
/// `NNNN/` up-migration in ascending order. Mirrors what the production
/// `app_migrations()` chain does at first boot.
fn open_freshly_migrated_db(db_path: &Path) -> Connection {
    // SQLITE_OPEN_CREATE + SQLITE_OPEN_READ_WRITE — same flags rusqlite
    // uses by default in `Connection::open`, written explicitly so the
    // intent is obvious.
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_READ_WRITE,
    )
    .unwrap_or_else(|e| panic!("open fresh DB at {}: {e}", db_path.display()));

    // Foreign keys default to OFF in SQLite. The first migration's
    // `00_pragma.sql` turns them on, but be explicit so a hypothetical
    // future migration that toggles the pragma mid-script still starts
    // from the same baseline as the production app.
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");

    let root = migrations_root();
    let mut migration_dirs: Vec<PathBuf> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read migrations root {}: {e}", root.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    // Only the up-migrations; ignore `NNNN_down/`.
                    .map(|n| !n.ends_with("_down") && n.parse::<u32>().is_ok())
                    .unwrap_or(false)
        })
        .collect();
    migration_dirs.sort_by_key(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(0)
    });

    for dir in &migration_dirs {
        let label = dir.file_name().and_then(|n| n.to_str()).unwrap_or("?");
        let sql = read_migration_sql(dir);
        conn.execute_batch(&sql)
            .unwrap_or_else(|e| panic!("apply migration {label}: {e}\n--- SQL ---\n{sql}"));
    }

    conn
}

// ---------------------------------------------------------------------------
// 1. Fixture row helpers
// ---------------------------------------------------------------------------

/// Insert a single company FK ancestor and return its rowid.
fn insert_company(conn: &Connection) -> i64 {
    conn.execute(
        "INSERT INTO companies (name, country_code) VALUES (?1, 'DE')",
        params!["Lifecycle Test GmbH"],
    )
    .expect("insert company");
    conn.last_insert_rowid()
}

/// Insert a single customer FK ancestor and return its rowid.
fn insert_customer(conn: &Connection, company_id: i64) -> i64 {
    conn.execute(
        "INSERT INTO customers (company_id, name, country_code) VALUES (?1, ?2, 'DE')",
        params![company_id, "Acme Co"],
    )
    .expect("insert customer");
    conn.last_insert_rowid()
}

/// Cents triple for a draft invoice: net + 19% VAT + gross. Held in one
/// struct so the post-restore byte-equality assertion can iterate on it
/// without hard-coding three column names twice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Cents {
    net: i64,
    tax: i64,
    gross: i64,
}

impl Cents {
    fn de_19(net: i64) -> Self {
        // Round to nearest cent — matches the application's
        // `round_to_cents` semantics in `src/lib/db/invoices.ts`.
        let tax = (net * 19 + 50) / 100;
        Self {
            net,
            tax,
            gross: net + tax,
        }
    }
}

/// Insert a *draft* invoice with explicit `*_cents` values. Status is
/// left at the schema default ('draft') so later steps can both update
/// the row freely (DAT-2.a immutability triggers gate on
/// `OLD.status <> 'draft'`) and observe a status transition into
/// `'issued'`.
fn insert_draft_invoice(
    conn: &Connection,
    company_id: i64,
    customer_id: i64,
    invoice_number: &str,
    cents: Cents,
) -> i64 {
    conn.execute(
        "INSERT INTO invoices \
         (company_id, customer_id, invoice_number, status, issue_date, \
          net_amount, tax_amount, gross_amount, \
          net_cents, tax_cents, gross_cents) \
         VALUES (?1, ?2, ?3, 'draft', '2026-05-10', \
                 ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            company_id,
            customer_id,
            invoice_number,
            cents.net as f64 / 100.0,
            cents.tax as f64 / 100.0,
            cents.gross as f64 / 100.0,
            cents.net,
            cents.tax,
            cents.gross,
        ],
    )
    .expect("insert draft invoice");
    conn.last_insert_rowid()
}

/// Insert a single invoice line item so the audit trigger on
/// `invoice_items` (DAT-4.b) also fires during the lifecycle, giving the
/// post-restore audit assertion something to count.
fn insert_invoice_item(conn: &Connection, invoice_id: i64, cents: Cents) {
    conn.execute(
        "INSERT INTO invoice_items \
         (invoice_id, description, quantity, unit_price_net, tax_rate, line_total_net, \
          unit_price_net_cents, line_total_net_cents) \
         VALUES (?1, 'Lifecycle test service', 1, ?2, 19, ?3, ?4, ?5)",
        params![
            invoice_id,
            cents.net as f64 / 100.0,
            cents.net as f64 / 100.0,
            cents.net,
            cents.net,
        ],
    )
    .expect("insert invoice item");
}

/// Issue a draft invoice (`draft -> issued`) plus a row in
/// `invoice_status_history` so the audit-trail assertion has a paper
/// trail that an auditor would recognise. The status flip is the *only*
/// column changed by this UPDATE so the audit trigger emits a single-key
/// `fields_diff`.
fn issue_invoice(conn: &Connection, invoice_id: i64) {
    let updated = conn
        .execute(
            "UPDATE invoices SET status = 'issued' WHERE id = ?1 AND status = 'draft'",
            params![invoice_id],
        )
        .expect("issue invoice (status flip)");
    assert_eq!(updated, 1, "expected to flip exactly one draft -> issued");

    conn.execute(
        "INSERT INTO invoice_status_history (invoice_id, from_status, to_status) \
         VALUES (?1, 'draft', 'issued')",
        params![invoice_id],
    )
    .expect("insert status-history row");
}

/// Record a single payment against `invoice_id`. Writes both `amount`
/// (legacy REAL) and `amount_cents` (DAT-1.* integer money) so the audit
/// trigger captures the canonical integer field too.
fn record_payment(conn: &Connection, invoice_id: i64, amount_cents: i64) -> i64 {
    conn.execute(
        "INSERT INTO payments (invoice_id, payment_date, amount, amount_cents, method) \
         VALUES (?1, '2026-05-10', ?2, ?3, 'bank_transfer')",
        params![invoice_id, amount_cents as f64 / 100.0, amount_cents],
    )
    .expect("insert payment");
    conn.last_insert_rowid()
}

// ---------------------------------------------------------------------------
// 2. Restore primitives — mirror src/lib.rs exactly
// ---------------------------------------------------------------------------

/// Compute the temporary file path used during restore, identical in
/// shape to `restore_tmp_path` in `src/lib.rs`. Same parent directory as
/// the live DB so the subsequent `rename(2)` is atomic on Unix.
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

/// Compute `<db>-wal` and `<db>-shm` siblings (suffix on the full file
/// name, NOT extension swap — same as production).
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

/// Best-effort delete: returns Ok if the file is already gone.
fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// `fsync(parent_of(child))` so the rename is durable across a power
/// loss. Unix only; Windows is a no-op (matches `src/lib.rs`).
#[cfg(unix)]
fn fsync_parent_dir(child: &Path) -> std::io::Result<()> {
    if let Some(parent) = child.parent() {
        let dir = fs::File::open(parent)?;
        dir.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn fsync_parent_dir(_child: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Returns true if `data` starts with the SQLite 3 magic header. Same
/// guard as `is_sqlite_backup` in `src/lib.rs`; protects the restore
/// path from swapping in a non-DB blob (e.g. an HTML error page).
fn is_sqlite_file(data: &[u8]) -> bool {
    data.len() >= SQLITE_MAGIC.len() && &data[..SQLITE_MAGIC.len()] == SQLITE_MAGIC
}

/// Lowercase hex SHA-256 of `data`. Identical output to `sha256_hex` in
/// `src/lib.rs` — the sidecar contract is "lowercase hex digest" so this
/// has to match byte for byte.
fn sha256_hex(data: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.as_slice() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

// ---------------------------------------------------------------------------
// 3. The lifecycle test
// ---------------------------------------------------------------------------

/// Single linear test so failures pinpoint the exact step that drifted.
/// Function name is deliberately distinct from the parallel branch's
/// `lifecycle_round_trip` so the two test binaries can sit side by side
/// during the review window.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lifecycle_e2e_v2_full_round_trip() {
    // -----------------------------------------------------------------
    // Step 0: workspace + ephemeral MinIO container.
    // -----------------------------------------------------------------
    let work = fresh_workdir();
    let db_path = work.join("bookie.db");
    eprintln!("workdir = {}", work.display());

    let minio = fixtures::minio::MinioFixture::start().await;
    minio.ensure_bucket().await;
    // Log the dynamically-allocated endpoint plus credentials so a test
    // failure in CI prints enough context to repro a manual `aws s3` call
    // against the same container before it gets reaped on Drop. Also keeps
    // the `MinioFixture` accessor methods (`region`, `access_key_id`,
    // `secret_access_key`) from being dead code under
    // `cargo clippy --features e2e -- -D warnings` — each `tests/*.rs`
    // file is its own crate, so adding a binary that doesn't reference
    // them would otherwise turn an existing dead_code warning into an
    // error.
    eprintln!(
        "minio endpoint={} bucket={} region={} access_key={} secret_key={}",
        minio.endpoint_url(),
        minio.bucket(),
        minio.region(),
        minio.access_key_id(),
        minio.secret_access_key(),
    );

    // -----------------------------------------------------------------
    // Step 1: fresh DB with all production migrations applied.
    // -----------------------------------------------------------------
    let conn = open_freshly_migrated_db(&db_path);

    // -----------------------------------------------------------------
    // Step 2: fixtures (company, customer) + draft invoice with cents.
    // -----------------------------------------------------------------
    let company_id = insert_company(&conn);
    let customer_id = insert_customer(&conn, company_id);

    let cents = Cents::de_19(12_345); // 123.45 EUR net, 23.46 VAT, 146.91 gross
    let invoice_id = insert_draft_invoice(&conn, company_id, customer_id, "INV-2026-0001", cents);
    insert_invoice_item(&conn, invoice_id, cents);

    // Sanity: cents columns hold the integer values we wrote.
    let (net_in, tax_in, gross_in): (i64, i64, i64) = conn
        .query_row(
            "SELECT net_cents, tax_cents, gross_cents FROM invoices WHERE id = ?1",
            params![invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read invoice cents (post-insert)");
    assert_eq!(
        (net_in, tax_in, gross_in),
        (cents.net, cents.tax, cents.gross),
        "draft invoice cents must match what was inserted"
    );

    // -----------------------------------------------------------------
    // Step 3: issue the invoice.
    // -----------------------------------------------------------------
    issue_invoice(&conn, invoice_id);

    let issued_status: String = conn
        .query_row(
            "SELECT status FROM invoices WHERE id = ?1",
            params![invoice_id],
            |row| row.get(0),
        )
        .expect("read invoice status");
    assert_eq!(
        issued_status, "issued",
        "status must be 'issued' after issue"
    );

    // -----------------------------------------------------------------
    // Step 4: forbidden update on issued row -> immutability trigger.
    // -----------------------------------------------------------------
    let forbidden = conn.execute(
        "UPDATE invoices SET net_cents = net_cents + 1 WHERE id = ?1",
        params![invoice_id],
    );
    let err = forbidden.expect_err(
        "DAT-2.a immutability trigger MUST abort an UPDATE on an issued invoice; \
         got Ok instead — the trigger has been weakened or removed",
    );
    let msg = err.to_string();
    assert!(
        msg.contains("invoice_immutable"),
        "expected SQLite RAISE(ABORT, 'invoice_immutable'); got: {msg}",
    );

    // Defense in depth: cents must NOT have been mutated by the rejected
    // UPDATE (RAISE(ABORT) rolls the statement back).
    let net_after_block: i64 = conn
        .query_row(
            "SELECT net_cents FROM invoices WHERE id = ?1",
            params![invoice_id],
            |row| row.get(0),
        )
        .expect("re-read net_cents");
    assert_eq!(
        net_after_block, cents.net,
        "rejected UPDATE must not have changed net_cents"
    );

    // -----------------------------------------------------------------
    // Step 5: record a payment for the full gross amount.
    // -----------------------------------------------------------------
    let payment_id = record_payment(&conn, invoice_id, cents.gross);
    let paid_amount_cents: i64 = conn
        .query_row(
            "SELECT amount_cents FROM payments WHERE id = ?1",
            params![payment_id],
            |row| row.get(0),
        )
        .expect("read payment amount_cents");
    assert_eq!(paid_amount_cents, cents.gross);

    // -----------------------------------------------------------------
    // Pre-backup audit-trail snapshot. Captured here so the post-restore
    // assertion compares against what the live DB had right before the
    // upload, not against an asymmetric "what we expect to find" list.
    // -----------------------------------------------------------------
    let pre_audit_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM invoice_audit", [], |row| row.get(0))
        .expect("count invoice_audit (pre-backup)");
    assert!(
        pre_audit_total >= 5,
        "expected >= 5 audit rows (insert invoice + insert item + issue update + insert payment + cents-match observation); got {pre_audit_total}",
    );

    let pre_audit_by_op: Vec<(String, String, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT entity_type, op, COUNT(*) FROM invoice_audit \
                 GROUP BY entity_type, op ORDER BY entity_type, op",
            )
            .expect("prepare audit group-by");
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .expect("query audit group-by")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect audit groups")
    };

    // -----------------------------------------------------------------
    // Step 6: close the connection so SQLite flushes WAL into the
    // main DB file before we read it as a byte stream.
    // -----------------------------------------------------------------
    // PRAGMA wal_checkpoint(TRUNCATE) is the strong-flush primitive: it
    // commits the WAL into the main file AND truncates the WAL to 0.
    // After this, the live `bookie.db` file holds the canonical bytes
    // and the WAL/SHM are inert.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("truncate WAL into main DB");
    drop(conn);

    // -----------------------------------------------------------------
    // Step 7: live DB SHA-256 (the value we will re-check post-restore).
    // -----------------------------------------------------------------
    let pre_backup_bytes = fs::read(&db_path).expect("read live DB bytes");
    assert!(
        is_sqlite_file(&pre_backup_bytes),
        "live DB must start with SQLite magic header"
    );
    let pre_backup_sha = sha256_hex(&pre_backup_bytes);
    eprintln!(
        "live DB SHA-256 (pre-backup) = {pre_backup_sha} ({} bytes)",
        pre_backup_bytes.len()
    );

    // -----------------------------------------------------------------
    // Step 8: backup to MinIO (object + .sha256 sidecar).
    // -----------------------------------------------------------------
    let s3 = minio.s3_client().await;
    let body_len = pre_backup_bytes.len() as i64;
    s3.put_object()
        .bucket(minio.bucket())
        .key(BACKUP_KEY)
        .body(ByteStream::from(pre_backup_bytes.clone()))
        .content_length(body_len)
        .content_type("application/octet-stream")
        .send()
        .await
        .expect("put backup blob");

    let sidecar_key = format!("{BACKUP_KEY}.sha256");
    let sidecar_bytes = pre_backup_sha.as_bytes().to_vec();
    let sidecar_len = sidecar_bytes.len() as i64;
    s3.put_object()
        .bucket(minio.bucket())
        .key(&sidecar_key)
        .body(ByteStream::from(sidecar_bytes.clone()))
        .content_length(sidecar_len)
        .content_type("text/plain")
        .send()
        .await
        .expect("put sha256 sidecar");

    // -----------------------------------------------------------------
    // Step 9: wipe the live DB (and WAL/SHM siblings).
    // -----------------------------------------------------------------
    let (wal, shm) = wal_shm_siblings(&db_path);
    fs::remove_file(&db_path).expect("delete live DB");
    remove_if_exists(&wal).expect("delete WAL sibling");
    remove_if_exists(&shm).expect("delete SHM sibling");
    assert!(!db_path.exists(), "DB file must be gone after wipe");

    // -----------------------------------------------------------------
    // Step 10: restore from MinIO.
    //
    //   download -> .restore.tmp -> verify sidecar+SHA -> magic header
    //   -> atomic rename onto db_path -> fsync(parent).
    //
    // The control flow mirrors `restore_db_backup` in `src/lib.rs`.
    // -----------------------------------------------------------------
    let downloaded = s3
        .get_object()
        .bucket(minio.bucket())
        .key(BACKUP_KEY)
        .send()
        .await
        .expect("get backup blob");
    let downloaded_bytes = downloaded
        .body
        .collect()
        .await
        .expect("collect downloaded body")
        .into_bytes()
        .to_vec();
    assert!(
        !downloaded_bytes.is_empty(),
        "downloaded backup bytes must be non-empty"
    );

    let tmp_path = restore_tmp_path(&db_path);
    fs::write(&tmp_path, &downloaded_bytes).expect("write .restore.tmp");

    // Sidecar verification: download, parse, compare against SHA of the
    // bytes on disk (NOT the in-memory copy — protects against a torn
    // write between fs::write and atomic_swap).
    let sidecar_resp = s3
        .get_object()
        .bucket(minio.bucket())
        .key(&sidecar_key)
        .send()
        .await
        .expect("get sidecar");
    let sidecar_bytes_dl = sidecar_resp
        .body
        .collect()
        .await
        .expect("collect sidecar body")
        .into_bytes()
        .to_vec();
    let sidecar_str =
        String::from_utf8(sidecar_bytes_dl).expect("sidecar payload must be UTF-8 hex");
    let sidecar_digest = sidecar_str.trim();
    assert_eq!(
        sidecar_digest.len(),
        64,
        "SHA-256 sidecar must be 64 hex chars (got {} chars: {:?})",
        sidecar_digest.len(),
        sidecar_digest
    );

    let tmp_bytes = fs::read(&tmp_path).expect("read .restore.tmp");
    let tmp_sha = sha256_hex(&tmp_bytes);
    assert_eq!(
        tmp_sha, sidecar_digest,
        "SHA-256 of .restore.tmp must match the sidecar; refusing to swap an unverified payload"
    );

    assert!(
        is_sqlite_file(&tmp_bytes),
        ".restore.tmp must start with SQLite magic header before swap"
    );

    fs::rename(&tmp_path, &db_path).expect("atomic rename .restore.tmp -> db");
    fsync_parent_dir(&db_path).expect("fsync parent dir after restore swap");

    // -----------------------------------------------------------------
    // Step 11: post-restore assertions.
    //
    //   (a) restored bytes hash equals pre-backup hash (byte-equality).
    //   (b) every *_cents column round-trips with byte-equal integer
    //       values (DAT-1.f cents regression).
    //   (c) PRAGMA integrity_check is "ok" (the restored DB is a real,
    //       openable SQLite database).
    //   (d) the audit trail rows present pre-backup are still present
    //       post-restore (DAT-4.b/c durability).
    // -----------------------------------------------------------------
    let post_restore_bytes = fs::read(&db_path).expect("read restored DB bytes");
    let post_restore_sha = sha256_hex(&post_restore_bytes);
    eprintln!("restored DB SHA-256 = {post_restore_sha}");

    assert_eq!(
        post_restore_sha, pre_backup_sha,
        "restored DB SHA must match the pre-backup SHA (byte-for-byte round-trip)",
    );
    assert_eq!(
        post_restore_bytes, pre_backup_bytes,
        "restored DB bytes must equal pre-backup bytes (defense-in-depth vs SHA collision)",
    );

    // (b) + (c) + (d): re-open the restored DB read-only to inspect.
    let conn2 = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("re-open restored DB read-only");

    let integrity: String = conn2
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("PRAGMA integrity_check");
    assert_eq!(integrity, "ok", "PRAGMA integrity_check must say 'ok'");

    let (net_out, tax_out, gross_out): (i64, i64, i64) = conn2
        .query_row(
            "SELECT net_cents, tax_cents, gross_cents FROM invoices WHERE id = ?1",
            params![invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read invoice cents (post-restore)");
    assert_eq!(
        (net_out, tax_out, gross_out),
        (cents.net, cents.tax, cents.gross),
        "invoice *_cents must round-trip byte-equal",
    );

    let (line_unit_cents, line_total_cents): (i64, i64) = conn2
        .query_row(
            "SELECT unit_price_net_cents, line_total_net_cents FROM invoice_items \
             WHERE invoice_id = ?1",
            params![invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read invoice_item cents (post-restore)");
    assert_eq!(
        (line_unit_cents, line_total_cents),
        (cents.net, cents.net),
        "invoice_item *_cents must round-trip byte-equal",
    );

    let payment_amount_cents: i64 = conn2
        .query_row(
            "SELECT amount_cents FROM payments WHERE id = ?1",
            params![payment_id],
            |row| row.get(0),
        )
        .expect("read payment amount_cents (post-restore)");
    assert_eq!(
        payment_amount_cents, cents.gross,
        "payment amount_cents must round-trip byte-equal",
    );

    // (d): audit trail durability. Compare the full (entity_type, op,
    // count) breakdown against the snapshot taken right before the
    // upload. Any drift (rows lost during restore, restore tmp picked up
    // a stale audit_log somehow) surfaces as a clear three-tuple diff.
    let post_audit_by_op: Vec<(String, String, i64)> = {
        let mut stmt = conn2
            .prepare(
                "SELECT entity_type, op, COUNT(*) FROM invoice_audit \
                 GROUP BY entity_type, op ORDER BY entity_type, op",
            )
            .expect("prepare audit group-by (post-restore)");
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .expect("query audit group-by (post-restore)")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect audit groups (post-restore)")
    };
    assert_eq!(
        post_audit_by_op, pre_audit_by_op,
        "invoice_audit grouping must round-trip exactly across backup/restore",
    );

    // Concrete row counts the lifecycle MUST have produced. Phrased as
    // lower bounds so a future audit-trigger refinement that emits more
    // rows does not break this test, but a regression that drops one
    // does.
    let invoice_inserts: i64 = conn2
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit \
             WHERE entity_type = 'invoices' AND op = 'insert' AND entity_id = ?1",
            params![invoice_id],
            |row| row.get(0),
        )
        .expect("count invoices/insert audit rows");
    assert_eq!(invoice_inserts, 1, "exactly one invoice INSERT audit row");

    let invoice_updates: i64 = conn2
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit \
             WHERE entity_type = 'invoices' AND op = 'update' AND entity_id = ?1",
            params![invoice_id],
            |row| row.get(0),
        )
        .expect("count invoices/update audit rows");
    assert!(
        invoice_updates >= 1,
        "expected >= 1 invoice UPDATE audit row (the issue flip); got {invoice_updates}",
    );

    let payment_inserts: i64 = conn2
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit \
             WHERE entity_type = 'payments' AND op = 'insert' AND entity_id = ?1",
            params![invoice_id],
            |row| row.get(0),
        )
        .expect("count payments/insert audit rows");
    assert_eq!(payment_inserts, 1, "exactly one payment INSERT audit row");

    let item_inserts: i64 = conn2
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit \
             WHERE entity_type = 'invoice_items' AND op = 'insert' AND entity_id = ?1",
            params![invoice_id],
            |row| row.get(0),
        )
        .expect("count invoice_items/insert audit rows");
    assert_eq!(item_inserts, 1, "exactly one invoice_item INSERT audit row");

    // status_history persisted.
    let status_history_count: i64 = conn2
        .query_row(
            "SELECT COUNT(*) FROM invoice_status_history WHERE invoice_id = ?1",
            params![invoice_id],
            |row| row.get(0),
        )
        .expect("count status history");
    assert_eq!(
        status_history_count, 1,
        "expected exactly one invoice_status_history row (draft -> issued)",
    );
}
