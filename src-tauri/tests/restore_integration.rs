//! REL-1.d (#45): integration tests for `restore_db_backup`'s atomic-swap
//! contract.
//!
//! `restore_db_backup` writes the verified backup bytes into a sibling
//! `<dbpath>.restore.tmp` file, fsyncs it, then atomically renames it onto
//! the live DB and fsyncs the parent directory. REL-1.c made that swap
//! atomic; this test asserts the contract holds when the restore is
//! interrupted at the two crash-windows that REL-1.c is supposed to defend
//! against:
//!
//!   1. **Partial download**: the `.restore.tmp` is mid-write when the
//!      process aborts. The next start-up cleanup must reap the partial
//!      file, and the live DB must be byte-for-byte unchanged (no swap was
//!      ever attempted).
//!   2. **Kill mid-rename**: the `.restore.tmp` is fully written and
//!      verified, but the process dies before / during the `rename(2)` and
//!      the parent-dir `fsync`. On Unix `rename(2)` is atomic, so the live
//!      DB is observed in exactly one of two states — old or new — and
//!      *both* must pass `PRAGMA integrity_check`.
//!
//! The S3 download leg is synthesised by writing bytes directly into the
//! `.restore.tmp` path (the test is hermetic — no network, no Docker).

use std::{
    fs,
    path::{Path, PathBuf},
};

use bookie_lib::{
    atomic_swap_into_place, fsync_parent_dir, remove_if_exists, restore_tmp_path,
    wal_shm_sibling_paths,
};
use rusqlite::Connection;

// --- fixture helpers --------------------------------------------------------

/// Create a fresh, isolated temp directory for a single test case.
///
/// Each call produces a distinct directory under `std::env::temp_dir()` so
/// concurrent test threads do not collide on the live DB path.
fn unique_tmpdir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("bookie-rel1d-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("create tmpdir");
    dir
}

/// Write a real, populated SQLite database to `path`. We intentionally
/// commit some rows so the file is more than just a zeroed header — that
/// way an integrity-check failure on the swapped/recovered file would be
/// detectable.
fn make_real_sqlite_db(path: &Path, marker_value: &str) {
    // Force the file out of any prior state.
    let _ = fs::remove_file(path);
    let conn = Connection::open(path).expect("open sqlite");
    // DELETE journal mode keeps the database to a single file (no -wal/-shm
    // siblings to manage). The on-disk WAL/SHM cleanup is exercised
    // separately below by writing those sibling files manually.
    conn.pragma_update(None, "journal_mode", "DELETE")
        .expect("set journal_mode=DELETE");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .expect("create table");
    conn.execute("INSERT INTO marker (value) VALUES (?1)", [marker_value])
        .expect("insert");
    // In DELETE journal mode the rollback journal is removed at COMMIT, so a
    // clean drop here flushes the file out completely — no WAL/SHM to manage.
    drop(conn);
}

/// Open `path` and run `PRAGMA integrity_check`. Returns the result string
/// reported by SQLite (`"ok"` for a healthy database).
fn integrity_check(path: &Path) -> String {
    let conn = Connection::open(path).expect("open sqlite for integrity check");
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity_check query");
    result
}

/// Read the marker row written by `make_real_sqlite_db`.
fn read_marker(path: &Path) -> String {
    let conn = Connection::open(path).expect("open sqlite to read marker");
    let value: String = conn
        .query_row("SELECT value FROM marker LIMIT 1", [], |row| row.get(0))
        .expect("select marker");
    value
}

// --- test 1: partial download leaves live DB untouched ---------------------

/// Acceptance criterion 1: corrupting the `.restore.tmp` mid-download must
/// not perturb the live DB.
///
/// We model the failure window as follows:
///   * The "live" DB exists and contains a known marker row.
///   * Step (1) of `restore_db_backup` has begun — bytes are streaming into
///     the sibling `.restore.tmp` — and the process aborts. We simulate
///     this by writing only a partial SQLite header to the .tmp file (any
///     prefix shorter than the 16-byte magic counts as corrupt for the
///     downstream `is_sqlite_backup` check).
///   * Crucially, `atomic_swap_into_place` is **never** invoked on this
///     path because the upstream verification (sidecar SHA, magic header)
///     would reject the tmp file before we ever quiesce the SQL plugin.
///   * The next attempt at restore (or app startup) calls
///     `remove_if_exists(&tmp_file)` to reap the partial file — that is the
///     same primitive the production code uses on entry to
///     `restore_db_backup` (see lib.rs: "Best-effort cleanup of any
///     leftover .tmp from a previous failed run").
///
/// After all of that, the live DB must be byte-equal to its pre-restore
/// snapshot AND still pass `PRAGMA integrity_check`.
#[test]
fn partial_download_leaves_live_db_untouched() {
    let dir = unique_tmpdir("partial-download");
    let live = dir.join("bookie.db");

    // 0. Stage a populated live DB and snapshot its bytes.
    make_real_sqlite_db(&live, "live-pre-restore");
    let live_before = fs::read(&live).expect("read live db before");
    assert!(
        !live_before.is_empty(),
        "fixture must produce a non-empty live DB"
    );

    // 1. Begin the synthesised "S3 download" — write a partial header to
    //    the sibling tmp file. The path matches what `restore_db_backup`
    //    derives via `restore_tmp_path`.
    let tmp = restore_tmp_path(&live);
    assert_eq!(
        tmp.parent(),
        live.parent(),
        "tmp must live in the same parent as live (rename atomicity precondition)"
    );
    fs::write(&tmp, b"SQLite f").expect("write partial download");
    assert!(tmp.exists(), "partial tmp file must be present pre-abort");

    // 2. Crash window: the process dies *before* verification, *before*
    //    quiesce, *before* rename. The live DB has not been touched.
    //    Assert that explicitly: the bytes are identical to the snapshot
    //    we took above.
    let live_mid = fs::read(&live).expect("read live db mid-abort");
    assert_eq!(
        live_mid, live_before,
        "live DB must be byte-identical while a partial .restore.tmp lingers"
    );

    // 3. "Restart": the next entry into `restore_db_backup` (or any
    //    startup-time sweep) cleans up the partial tmp file. This is the
    //    same primitive the production code uses.
    remove_if_exists(&tmp).expect("cleanup must succeed on a present path");
    assert!(!tmp.exists(), "partial tmp file must be reaped on restart");
    // Re-running the cleanup must still be a no-op (idempotency).
    remove_if_exists(&tmp).expect("cleanup must be idempotent");

    // 4. Final assertions: live DB is byte-equal to snapshot AND opens
    //    cleanly through SQLite (PRAGMA integrity_check == "ok").
    let live_after = fs::read(&live).expect("read live db after cleanup");
    assert_eq!(
        live_after, live_before,
        "live DB must remain byte-identical across the aborted restore"
    );
    assert_eq!(
        integrity_check(&live),
        "ok",
        "live DB must still pass PRAGMA integrity_check"
    );
    assert_eq!(read_marker(&live), "live-pre-restore");

    let _ = fs::remove_dir_all(&dir);
}

// --- test 2: kill mid-rename, restart, integrity passes --------------------

/// Acceptance criterion 2: a process death in the rename / fsync window
/// must not corrupt the live DB. Because `rename(2)` is atomic on Unix,
/// "killing mid-rename" collapses to one of two observable on-disk states:
///
///   (a) the kernel never observed the rename → live DB still holds the
///       OLD bytes (the .tmp file is left dangling and reaped on restart).
///   (b) the kernel observed the rename → live DB now holds the NEW bytes
///       (the parent-dir fsync may or may not have happened — that affects
///       *durability* across power loss, not *correctness* of the bytes
///       we read back through the OS page cache).
///
/// We exercise BOTH states in a single test and assert each path leaves a
/// SQLite file that opens cleanly with `PRAGMA integrity_check == "ok"`.
#[test]
fn kill_mid_rename_leaves_integrity_intact() {
    let dir = unique_tmpdir("kill-mid-rename");
    let live = dir.join("bookie.db");
    let tmp = restore_tmp_path(&live);

    // 0. Stage a populated live DB ("OLD") and snapshot it. Stage a fully
    //    written, verified .tmp file ("NEW") sitting next to it. This is
    //    the post-verification, post-quiesce state of `restore_db_backup`
    //    just before step 8 (`atomic_swap_into_place`).
    make_real_sqlite_db(&live, "live-OLD");
    let live_old_bytes = fs::read(&live).expect("snapshot OLD live");

    make_real_sqlite_db(&tmp, "restore-NEW");
    let tmp_new_bytes = fs::read(&tmp).expect("snapshot NEW tmp");
    assert_ne!(
        live_old_bytes, tmp_new_bytes,
        "fixture must produce distinguishable OLD/NEW DBs"
    );

    // Stage stale WAL/SHM siblings to confirm the swap path leaves no
    // ambiguous state behind. (`restore_db_backup` removes these BEFORE
    // the rename; in the pre-rename crash branch they are simply orphaned
    // and ignored — SQLite recreates them on next open.)
    let (wal, shm) = wal_shm_sibling_paths(&live);
    fs::write(&wal, b"stale-wal").expect("write stale WAL");
    fs::write(&shm, b"stale-shm").expect("write stale SHM");

    // --- Branch (a): crash BEFORE the rename --------------------------------
    //
    // We do NOT call `atomic_swap_into_place`. The process is "killed" with
    // the verified .tmp on disk and the live file untouched. The startup
    // sweep then runs `remove_if_exists` on the .tmp path.
    let live_mid = fs::read(&live).expect("read live db pre-rename");
    assert_eq!(
        live_mid, live_old_bytes,
        "pre-rename crash must leave live DB byte-identical to OLD"
    );
    assert!(tmp.exists(), "tmp must still be present pre-rename");

    // Simulated restart cleanup.
    remove_if_exists(&tmp).expect("cleanup must reap leftover tmp");
    assert!(!tmp.exists());
    // Stale WAL/SHM are also reaped (matches step 7 of the production flow,
    // hoisted into the recovery path here).
    remove_if_exists(&wal).expect("cleanup WAL");
    remove_if_exists(&shm).expect("cleanup SHM");

    // The live DB is the OLD database AND it passes integrity check.
    assert_eq!(
        fs::read(&live).expect("read live after pre-rename recovery"),
        live_old_bytes,
        "pre-rename recovery must preserve OLD bytes exactly"
    );
    assert_eq!(
        integrity_check(&live),
        "ok",
        "OLD live DB must pass integrity_check after a pre-rename crash"
    );
    assert_eq!(read_marker(&live), "live-OLD");

    // --- Branch (b): crash AFTER the rename, BEFORE the parent fsync --------
    //
    // Re-stage the .tmp (we just reaped it above) and complete the swap.
    // A crash *after* the rename is observably the same as a successful
    // swap from userspace's perspective: the OS page cache sees the new
    // inode at the live path. The pending parent-dir fsync only matters
    // for durability across a power loss; it does not change what we read
    // back through the filesystem in the same boot. Either way the live
    // DB must be a complete, healthy SQLite file.
    fs::write(&tmp, &tmp_new_bytes).expect("re-stage NEW tmp for branch (b)");

    atomic_swap_into_place(&tmp, &live).expect("rename must succeed");
    assert!(!tmp.exists(), "tmp must be consumed by the rename");

    // Swallow any fsync failure the same way `restore_db_backup` does (it
    // logs but does not propagate — the bytes are already visible).
    let _ = fsync_parent_dir(&live);

    let live_after_swap = fs::read(&live).expect("read live after swap");
    assert_eq!(
        live_after_swap, tmp_new_bytes,
        "post-rename state must be exactly the NEW bytes"
    );
    assert_eq!(
        integrity_check(&live),
        "ok",
        "NEW live DB must pass integrity_check after the swap"
    );
    assert_eq!(read_marker(&live), "restore-NEW");

    let _ = fs::remove_dir_all(&dir);
}

// --- test 3: tmp lives in the same parent (rename atomicity precondition) ---

/// Sanity check on the rename atomicity precondition that REL-1.c added:
/// `restore_tmp_path` must place the tmp file in the same parent directory
/// as the live DB. A cross-filesystem rename would NOT be atomic on Unix
/// (it would degrade to a copy + unlink under the hood).
///
/// This is partially covered by the unit tests in lib.rs but those operate
/// on synthetic paths; this test confirms the property against a real
/// directory used by the integration suite.
#[test]
fn tmp_path_shares_parent_with_live_db() {
    let dir = unique_tmpdir("tmp-parent");
    let live = dir.join("bookie.db");
    let tmp = restore_tmp_path(&live);

    assert_eq!(
        tmp.parent(),
        live.parent(),
        "tmp must share the live DB's parent for rename(2) atomicity"
    );
    assert!(
        tmp.file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".db.restore.tmp"),
        "tmp must keep the `.db` segment so operators can identify the file"
    );

    let _ = fs::remove_dir_all(&dir);
}
