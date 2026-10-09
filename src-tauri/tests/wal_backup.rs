//! PERF-4 (#275): with WAL enabled, a backup must include rows that are still
//! only in `-wal` (no checkpoint yet), and restoring it round-trips them.

use bookie_lib::{enable_wal, snapshot_db, wal_shm_sibling_paths};
use rusqlite::Connection;

#[test]
fn backup_after_wal_write_contains_latest_rows() {
    let dir = std::env::temp_dir().join(format!(
        "bookie-wal-backup-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let db = dir.join("bookie.db");
    enable_wal(&db).unwrap();

    // Live writer connection stays open, so nothing is checkpointed.
    let live = Connection::open(&db).unwrap();
    live.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    let mode: String = live
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    live.execute_batch("CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('latest');")
        .unwrap();
    let (wal, _) = wal_shm_sibling_paths(&db);
    assert!(
        std::fs::metadata(&wal).unwrap().len() > 0,
        "row must sit in -wal"
    );

    let backup = dir.join("backup.db");
    std::fs::write(&backup, b"stale").unwrap(); // existing target gets replaced
    assert!(snapshot_db(&db, &backup).unwrap() > 0);
    drop(live);

    // Backup is self-contained: opened alone, it has the latest row.
    let restored: String = Connection::open(&backup)
        .unwrap()
        .query_row("SELECT v FROM t", [], |r| r.get(0))
        .unwrap();
    assert_eq!(restored, "latest");
    let _ = std::fs::remove_dir_all(&dir);
}
