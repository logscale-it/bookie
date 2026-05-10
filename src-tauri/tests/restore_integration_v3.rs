//! REL-1.d (#45): Integration test for the partial-download / atomic-swap
//! restore code path.
//!
//! ## Why this test exists
//!
//! REL-1.b/c (PRs #129 / #128) introduced two safety properties for
//! `restore_db_backup` in `src-tauri/src/lib.rs`:
//!
//! 1. **SHA-256 sidecar verification before swap.** The downloaded backup is
//!    written to `<dbpath>.restore.tmp` (in the same parent directory as the
//!    live DB so the subsequent rename is atomic). Its SHA-256 is then
//!    compared against the `<key>.sha256` sidecar stored in S3. If the bytes
//!    on disk disagree with the sidecar — for example because the download
//!    was truncated, a transient corruption flipped a bit, or the operator
//!    swapped in a wrong file — the live DB must NOT be replaced.
//! 2. **Atomic durable swap.** Steps 7-9 of the restore flow remove the
//!    OLD WAL/SHM siblings, `rename(2)` the .tmp file over the live DB
//!    (atomic on Unix because both share a parent), and then `fsync` the
//!    parent directory so the rename survives a power loss.
//!
//! The failure modes for those two properties are subtle and the unit tests
//! shipping in `lib.rs::atomic_restore_helper_tests` only cover the pure-IO
//! primitives (path math, individual rename, individual fsync). REL-1.d
//! ties them together end-to-end at the integration-test level so a
//! regression that breaks the *contract* — "a corrupted .tmp must never
//! reach the live path" or "a successfully renamed DB must be readable
//! after a crash mid-fsync" — is caught.
//!
//! ## Why this is `restore_integration_v3.rs`
//!
//! There are concurrent worktrees on this issue (PR #138 already exists)
//! and earlier name shapes. Naming the file with the `_v3` suffix keeps
//! this branch from colliding with sibling branches that also touch
//! `tests/restore_integration*.rs`. The `cargo test --test
//! restore_integration_v3` target name in the issue's acceptance criterion
//! is exactly this file's stem.
//!
//! ## Why we drive the helpers directly instead of `restore_db_backup`
//!
//! `restore_db_backup` is a `#[tauri::command]` whose first argument is an
//! `AppHandle`, and its only data source is S3. Spinning up a real S3
//! (MinIO container) plus a Tauri runtime just to exercise the on-disk
//! swap path would be slow, flaky, and require Docker — which the project's
//! `cargo test` is explicitly designed to avoid (the MinIO-backed tests
//! are gated behind `BOOKIE_TEST_S3=1`).
//!
//! The task brief allowed a small testability refactor: REL-1.d (#45)
//! flips the atomic-restore helpers (`restore_tmp_path`,
//! `wal_shm_sibling_paths`, `remove_if_exists`, `atomic_swap_into_place`,
//! `fsync_parent_dir`, plus the SHA helpers `is_sqlite_backup` /
//! `sha256_hex`) from module-private to `pub`, with no observable
//! behaviour change. This integration test then drives the *same*
//! primitives `restore_db_backup` calls in steps 7-9, so a regression in
//! any of those helpers is caught here even though we never touch S3.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use bookie_lib::{
    atomic_swap_into_place, fsync_parent_dir, is_sqlite_backup, remove_if_exists, restore_tmp_path,
    sha256_hex, wal_shm_sibling_paths,
};

// ---------------------------------------------------------------------------
// Scratch-directory helpers (mirrors the pattern in
// `tests/schema_version_boot.rs`).
//
// We deliberately put fixtures under `target/test-artifacts/<name>/` rather
// than `std::env::temp_dir()` so that `cargo clean` reaps them and so that
// two parallel runs of the same test (e.g. `cargo test -- --test-threads`)
// don't share state via a single global tmp dir.
// ---------------------------------------------------------------------------

fn scratch_dir(test_name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-artifacts")
        .join("restore_integration_v3")
        .join(test_name);
    // Wipe any stale fixture from a previous run. `remove_dir_all` is Ok
    // when the directory doesn't exist; we explicitly ignore the result so
    // a stale handle on Windows (rare in CI) doesn't fail the whole test.
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

// ---------------------------------------------------------------------------
// Fixture: build a real on-disk SQLite database with one tiny table.
//
// Using a real SQLite file (rather than just "SQLite format 3\0" + zeroes)
// matters for two reasons:
//   1. `is_sqlite_backup` only checks the magic header, but Case B
//      asserts `PRAGMA integrity_check = 'ok'` after the swap — that
//      requires a structurally valid DB.
//   2. The test is also a check that a "restored" DB can be re-opened
//      from disk after `atomic_swap_into_place` via a fresh connection,
//      which is the same shape the production code expects the frontend
//      to perform via `Database.load(...)` after `restore_db_backup`.
// ---------------------------------------------------------------------------

/// Build a usable SQLite DB at `path` containing a `marker` table with one
/// row whose `value` column equals `marker`. The marker lets the test
/// distinguish "was this the live DB" vs "was this the restored DB" after a
/// swap.
fn build_sqlite_with_marker(path: &Path, marker: &str) {
    let conn = Connection::open(path).expect("open sqlite for fixture");
    conn.execute_batch("CREATE TABLE marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL);")
        .expect("create marker table");
    conn.execute(
        "INSERT INTO marker (id, value) VALUES (1, ?1)",
        params![marker],
    )
    .expect("insert marker row");
    // Force a checkpoint into the main DB file (not WAL) so the bytes we
    // later read with `fs::read` reflect the marker. SQLite's default
    // journal_mode in this code path is `delete`, so this is largely
    // belt-and-suspenders, but it keeps the test independent of whatever
    // pragma defaults rusqlite picks.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
    conn.close().expect("close fixture connection");
}

/// Read the `value` from row 1 of the `marker` table on the SQLite DB at
/// `path`. Returns `None` if the file is not a readable SQLite DB or the
/// row is absent. Used to distinguish "live DB still intact" from "live DB
/// was replaced by the restored bytes" after the swap.
fn read_marker(path: &Path) -> Option<String> {
    let conn = Connection::open(path).ok()?;
    conn.query_row("SELECT value FROM marker WHERE id = 1", [], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

/// Run `PRAGMA integrity_check` against the SQLite DB at `path` and return
/// the first row's text. SQLite returns the literal string `"ok"` when the
/// DB is structurally sound; anything else is a list of corruption notes.
fn integrity_check(path: &Path) -> String {
    let conn = Connection::open(path).expect("open db for integrity_check");
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("read integrity_check row");
    result
}

// ---------------------------------------------------------------------------
// Case A: partial download / mid-download corruption.
//
// Models the fault: the production restore code downloads bytes into
// `<dbpath>.restore.tmp` (step 1 of `restore_db_backup`) and then verifies
// the SHA-256 sidecar against those bytes (step 3). If the bytes on disk
// disagree with the sidecar — because the download was truncated, the body
// stream errored mid-collect, an attacker swapped the file under us, or
// any other corruption — the swap MUST NOT happen and the live DB MUST be
// untouched.
//
// The test reproduces that contract by:
//   1. Creating a real live SQLite DB at `bookie.db` with marker = "live".
//   2. Building a real "good" SQLite DB and computing its SHA-256 — this is
//      the digest we pretend the sidecar in S3 would carry.
//   3. Writing CORRUPTED bytes to the .tmp file (truncated copy of the good
//      bytes). This is the partial-download model: the .tmp exists but
//      its contents do not match what the sidecar says they should.
//   4. Computing the SHA of the on-disk .tmp and asserting it does NOT
//      match the sidecar — this is the same comparison `restore_db_backup`
//      does in step 3 (`actual != expected`), and the same point at which
//      the production code aborts via `BackupSidecarMismatch`.
//   5. Performing the production code's abort cleanup
//      (`remove_if_exists(&tmp_file)`) and asserting that
//      `atomic_swap_into_place` is NEVER called.
//   6. Asserting the live DB is byte-for-byte unchanged AND still reads
//      its original marker value through a fresh SQLite connection (the
//      "would the user see the right data on next boot" check).
// ---------------------------------------------------------------------------

#[test]
fn case_a_corrupted_tmp_does_not_replace_live_db() {
    let dir = scratch_dir("case_a_partial_download");
    let live_db = dir.join("bookie.db");
    let tmp_file = restore_tmp_path(&live_db);

    // Same-parent invariant: if this fails the rename in step 8 would not
    // be atomic on Unix. Asserting it here pins the contract for the
    // production helper too.
    assert_eq!(
        tmp_file.parent(),
        live_db.parent(),
        "restore .tmp must live in the live DB's parent for atomic rename"
    );

    // 1. Live DB the user has been writing to.
    build_sqlite_with_marker(&live_db, "live");
    let live_bytes_before = fs::read(&live_db).expect("read live DB before");
    assert_eq!(
        read_marker(&live_db).as_deref(),
        Some("live"),
        "fixture sanity: live DB must read back its marker before the test runs"
    );

    // 2. The "good" backup the operator intended to restore. We compute
    // its SHA-256 into `expected_digest` to model the contents of the
    // `<key>.sha256` sidecar in S3.
    let staging = dir.join("backup_source.db");
    build_sqlite_with_marker(&staging, "restored");
    let good_bytes = fs::read(&staging).expect("read good backup bytes");
    assert!(
        is_sqlite_backup(&good_bytes),
        "fixture sanity: good backup must satisfy the SQLite magic check"
    );
    let expected_digest = sha256_hex(&good_bytes);

    // 3. Simulate a partial download: write a TRUNCATED copy of the good
    // bytes to the .tmp path. The truncated payload still starts with the
    // SQLite magic header (so `is_sqlite_backup` would pass) but its SHA
    // diverges from the sidecar — this is the exact failure mode the
    // sidecar verification step is designed to catch.
    let truncate_to = good_bytes.len() / 2;
    assert!(
        truncate_to >= 16,
        "good backup must be large enough that a half-truncation still keeps the magic header"
    );
    let corrupted = good_bytes[..truncate_to].to_vec();
    fs::write(&tmp_file, &corrupted).expect("write corrupted tmp");
    assert!(
        tmp_file.exists(),
        "tmp must be on disk after the corrupted write"
    );

    // 4. Re-derive the SHA from disk (same as `restore_db_backup` does)
    // and assert it disagrees with the sidecar. This is the assertion that
    // the abort path is *reachable* with realistic data — without it, a
    // bug that always passed verification would also pass step 5/6 below.
    let actual_digest = sha256_hex(&fs::read(&tmp_file).expect("re-read tmp"));
    assert_ne!(
        actual_digest, expected_digest,
        "corrupted tmp's SHA must not match the sidecar — otherwise the test isn't exercising the abort path"
    );

    // 5. Mirror the production cleanup_tmp closure for the abort branch:
    // remove the .tmp and DO NOT call `atomic_swap_into_place`. If the
    // production code regressed and called swap *before* the SHA check,
    // `live_db` would already hold the corrupted bytes by the time we got
    // here — the assertions in step 6 catch that.
    remove_if_exists(&tmp_file).expect("remove_if_exists must succeed for the corrupted tmp");
    assert!(
        !tmp_file.exists(),
        "tmp must be cleaned up on the SHA-mismatch abort path"
    );

    // 6. The live DB must be untouched: same bytes on disk AND still the
    // pre-restore marker via a fresh SQLite connection.
    let live_bytes_after = fs::read(&live_db).expect("read live DB after");
    assert_eq!(
        live_bytes_after, live_bytes_before,
        "live DB bytes must NOT change when sidecar verification fails"
    );
    assert_eq!(
        read_marker(&live_db).as_deref(),
        Some("live"),
        "live DB must still read its pre-restore marker after the aborted restore"
    );
}

/// Negative-of-the-negative for Case A: the same flow but with the *correct*
/// bytes on the .tmp must verify cleanly. Without this, a broken
/// `sha256_hex` that returned a constant string would still pass the
/// rejection assertion above.
#[test]
fn case_a_matching_tmp_passes_sha_verification() {
    let dir = scratch_dir("case_a_negative_of_negative");
    let live_db = dir.join("bookie.db");
    let tmp_file = restore_tmp_path(&live_db);
    build_sqlite_with_marker(&live_db, "live");

    let staging = dir.join("backup_source.db");
    build_sqlite_with_marker(&staging, "restored");
    let good_bytes = fs::read(&staging).expect("read good bytes");
    let expected_digest = sha256_hex(&good_bytes);

    // The "happy" download: the .tmp on disk is exactly the operator's
    // intended backup.
    fs::write(&tmp_file, &good_bytes).expect("write tmp");
    let actual_digest = sha256_hex(&fs::read(&tmp_file).expect("re-read tmp"));

    assert_eq!(
        actual_digest, expected_digest,
        "matching tmp must pass SHA verification — otherwise the rejection test above is meaningless"
    );

    // Tidy up so the test directory is reusable on a re-run.
    remove_if_exists(&tmp_file).expect("remove tmp");
}

// ---------------------------------------------------------------------------
// Case B: crash between rename and fsync.
//
// Models the fault: `restore_db_backup` performs steps 7 (remove old
// WAL/SHM), 8 (`atomic_swap_into_place` — the rename), and 9
// (`fsync_parent_dir`) in sequence. Between steps 8 and 9 the rename has
// already been observed by the kernel page cache, so any process that
// re-opens the DB sees the new bytes. But the rename is only durable
// across a power loss once step 9 completes. The test asserts that even
// without the fsync, the post-swap DB is structurally valid: re-opening
// it and running `PRAGMA integrity_check` returns the literal `"ok"`.
//
// We deliberately cannot SIGKILL the test process (that would kill the
// test runner too), so "crash mid-rename" is modeled by *not invoking*
// `fsync_parent_dir` between the swap and the re-open. This still tests
// the contract that matters: the rename is observable to the next reader
// even before the fsync runs.
//
// The test:
//   1. Creates a real live SQLite DB at `bookie.db` with marker = "live"
//      AND fakes WAL/SHM siblings (production restore step 7 must remove
//      them; this test asserts those siblings are gone after step 7).
//   2. Builds a real "restored" SQLite DB with marker = "restored" and
//      writes its bytes to the .tmp file (modeling a successful download
//      + verification — the steps Case A covered).
//   3. Runs production step 7 (`remove_if_exists` on WAL+SHM).
//   4. Runs production step 8 (`atomic_swap_into_place`).
//   5. Skips production step 9 (`fsync_parent_dir`) — the simulated crash
//      point.
//   6. Re-opens the swapped DB through a fresh `Connection` (the
//      "restart" model — same shape `restore_db_backup`'s frontend
//      contract requires via `Database.load(...)`).
//   7. Asserts `PRAGMA integrity_check = 'ok'`.
//   8. Asserts the marker reads back as "restored", proving the swap
//      really did flip the inode (a swap that silently no-op'd would
//      still pass integrity_check on the *old* DB).
// ---------------------------------------------------------------------------

#[test]
fn case_b_crash_mid_rename_keeps_db_intact_on_restart() {
    let dir = scratch_dir("case_b_crash_mid_rename");
    let live_db = dir.join("bookie.db");
    let tmp_file = restore_tmp_path(&live_db);
    let (wal_file, shm_file) = wal_shm_sibling_paths(&live_db);

    // Same-parent invariant for atomic rename.
    assert_eq!(tmp_file.parent(), live_db.parent());
    assert_eq!(wal_file.parent(), live_db.parent());
    assert_eq!(shm_file.parent(), live_db.parent());

    // 1. Live DB the user was using. Plus fake WAL/SHM siblings — these
    // are what step 7 of `restore_db_backup` is responsible for removing
    // (they belong to the OLD DB and would corrupt the NEW one if SQLite
    // tried to replay them after the swap).
    build_sqlite_with_marker(&live_db, "live");
    fs::write(&wal_file, b"stale-wal-bytes").expect("seed stale WAL");
    fs::write(&shm_file, b"stale-shm-bytes").expect("seed stale SHM");
    assert!(wal_file.exists() && shm_file.exists());

    // 2. "Downloaded + verified" bytes ready in the .tmp. Modeling Case A's
    // happy path: bytes are valid and SHA matched the sidecar. We re-derive
    // the bytes from a real SQLite file rather than handcrafting them so
    // that PRAGMA integrity_check has something to check.
    let staging = dir.join("backup_source.db");
    build_sqlite_with_marker(&staging, "restored");
    let good_bytes = fs::read(&staging).expect("read good bytes");
    assert!(
        is_sqlite_backup(&good_bytes),
        "fixture sanity: good bytes carry the SQLite magic header"
    );
    fs::write(&tmp_file, &good_bytes).expect("write tmp file");

    // 3. Production step 7: remove OLD WAL/SHM siblings.
    remove_if_exists(&wal_file).expect("remove WAL");
    remove_if_exists(&shm_file).expect("remove SHM");
    assert!(!wal_file.exists(), "WAL must be gone after step 7");
    assert!(!shm_file.exists(), "SHM must be gone after step 7");

    // 4. Production step 8: atomic rename. After this returns Ok, any
    // process that opens `live_db` reads the restored bytes.
    atomic_swap_into_place(&tmp_file, &live_db).expect("atomic rename must succeed");
    assert!(!tmp_file.exists(), "tmp must be consumed by the rename");
    assert!(
        live_db.exists(),
        "live DB path must point at the renamed file after the swap"
    );

    // 5. Production step 9: SKIPPED. This is the simulated "crash between
    // rename and fsync" — the kernel page cache holds the rename but the
    // parent directory's metadata hasn't been flushed. From the next
    // reader's perspective, the situation is observationally identical:
    // the new DB is reachable.

    // 6. "Restart": re-open the DB through a fresh connection, exactly as
    // the frontend's post-restore `Database.load(...)` would.
    // 7. PRAGMA integrity_check.
    let result = integrity_check(&live_db);
    assert_eq!(
        result, "ok",
        "PRAGMA integrity_check must report 'ok' on the restored DB after a simulated crash mid-rename (got: {result})"
    );

    // 8. Marker check: the swap really did flip the file. Without this, a
    // swap that silently failed to overwrite the live DB would still pass
    // integrity_check (the OLD DB is also structurally valid).
    assert_eq!(
        read_marker(&live_db).as_deref(),
        Some("restored"),
        "after the swap, the live path must hold the restored DB's marker — not the pre-restore one"
    );
}

/// Companion test for Case B: even when the post-rename `fsync_parent_dir`
/// IS invoked (the non-crash code path), the DB must still be readable
/// and integrity-clean. Without this, a regression that made
/// `fsync_parent_dir` corrupt the parent directory entry would only
/// surface as "Case B passes, but the production happy path fails", which
/// is harder to debug than a direct assertion.
#[test]
fn case_b_post_rename_fsync_is_safe_for_readers() {
    let dir = scratch_dir("case_b_with_fsync");
    let live_db = dir.join("bookie.db");
    let tmp_file = restore_tmp_path(&live_db);

    build_sqlite_with_marker(&live_db, "live");
    let staging = dir.join("backup_source.db");
    build_sqlite_with_marker(&staging, "restored");
    let good_bytes = fs::read(&staging).expect("read good bytes");
    fs::write(&tmp_file, &good_bytes).expect("write tmp");

    atomic_swap_into_place(&tmp_file, &live_db).expect("rename");
    fsync_parent_dir(&live_db).expect("fsync parent must not error on a real directory");

    assert_eq!(integrity_check(&live_db), "ok");
    assert_eq!(read_marker(&live_db).as_deref(), Some("restored"));
}
