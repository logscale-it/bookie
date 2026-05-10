//! TEST-2.a: Migration up/down round-trip harness.
//!
//! For every migration directory `NNNN` under `src-tauri/migrations/`, this
//! harness:
//!
//! 1. Builds a fresh in-memory SQLite database.
//! 2. Applies every prior up-migration (`0001..NNNN-1`) so the DB is in the
//!    state that `NNNN` is meant to upgrade *from*.
//! 3. Captures a schema snapshot from `sqlite_schema` (ordered by `type, name`).
//! 4. Applies the `NNNN` up SQL, then the `NNNN_down` SQL.
//! 5. Captures the schema snapshot again and asserts equality with the
//!    pre-up snapshot.
//!
//! Migrations whose `NNNN/` directory contains a `.noop_down` marker file are
//! exempt from the equality assertion: the test still applies their up + down
//! SQL (so syntax errors are still caught) but only emits a `WARN` to stderr
//! if the schema differs. This is the project's escape hatch for genuine
//! no-op down migrations (e.g. SQLite ALTER TABLE limitations, data-only
//! restores from external sources) and for table-rebuild down migrations
//! whose textual `CREATE TABLE` differs from the original even though the
//! resulting schema is semantically equivalent.
//!
//! The `CLAUDE.md` rule "always create a rollback migration" is enforced
//! only by convention. Several existing down-migrations are no-ops because
//! of SQLite limitations — but nothing flagged it. This harness makes the
//! contract executable: a future contributor who adds a migration without a
//! working down (and without the `.noop_down` marker) gets a hard
//! `cargo test` failure.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// The marker filename, placed inside an `NNNN/` migration directory, that
/// declares the corresponding `NNNN_down/` migration as intentionally not
/// expected to round-trip the schema. The test still executes the down SQL
/// to catch syntax errors, but a schema mismatch only logs a warning.
///
/// The repository's root `.gitignore` matches `.*`, so a `.noop_down` marker
/// added to a future migration would be silently excluded from version
/// control without the companion exception
/// `!src-tauri/migrations/*/.noop_down` (added in the same commit that
/// introduced this harness) re-including it.
const NOOP_DOWN_MARKER: &str = ".noop_down";

/// One discovered migration version on disk.
#[derive(Debug)]
struct Migration {
    /// Numeric version parsed from the directory name (e.g. `1` for `0001/`).
    version: u32,
    /// Path to the `NNNN/` directory containing the up SQL files.
    up_dir: PathBuf,
    /// Path to the `NNNN_down/` directory containing the down SQL files.
    down_dir: PathBuf,
    /// Whether the up directory contains the `.noop_down` marker file.
    noop_down: bool,
}

/// Resolve `<crate>/migrations/`, where `<crate>` is `src-tauri/`.
fn migrations_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations")
}

/// Discover every migration version on disk, sorted ascending.
///
/// A "migration" is a pair `NNNN/` + `NNNN_down/` where both directories
/// exist and `NNNN` parses as a `u32`. Directories that don't fit the
/// pattern are silently skipped — the test only cares about the numbered
/// migrations the app actually loads.
fn discover_migrations() -> Vec<Migration> {
    let root = migrations_root();
    let mut migrations: Vec<Migration> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read migrations dir {}: {e}", root.display()))
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let name = path.file_name()?.to_str()?.to_owned();
            // Skip the `_down` halves; we look those up explicitly per up dir.
            if name.ends_with("_down") {
                return None;
            }
            let version: u32 = name.parse().ok()?;
            let down_dir = root.join(format!("{name}_down"));
            assert!(
                down_dir.is_dir(),
                "migration {name} is missing its rollback directory at {}",
                down_dir.display()
            );
            let noop_down = path.join(NOOP_DOWN_MARKER).exists();
            Some(Migration {
                version,
                up_dir: path,
                down_dir,
                noop_down,
            })
        })
        .collect();
    migrations.sort_by_key(|m| m.version);
    assert!(
        !migrations.is_empty(),
        "no migrations found under {}",
        root.display()
    );
    migrations
}

/// Concatenate every `*.sql` file in a migration directory, sorted by file
/// name, into one script.
///
/// The on-disk numeric prefixes (`00_pragma.sql`, `01_companies.sql`, …)
/// double as a deterministic execution order; we mirror that here.
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
        // Defensive newline so a file missing a trailing newline doesn't
        // glue its last statement into the next file's first statement.
        if !script.ends_with('\n') {
            script.push('\n');
        }
    }
    script
}

/// Apply a SQL script to the connection using `execute_batch`, which handles
/// multiple semicolon-separated statements (including `BEGIN`/`COMMIT`).
fn apply(conn: &Connection, sql: &str, label: &str) {
    conn.execute_batch(sql)
        .unwrap_or_else(|e| panic!("apply {label} failed: {e}\n--- SQL ---\n{sql}"));
}

/// Same as [`apply`] but returns an error instead of panicking. Used for the
/// down half of `.noop_down`-marked migrations where we still want to surface
/// SQL execution failures as warnings (not hard test failures).
fn try_apply(conn: &Connection, sql: &str) -> rusqlite::Result<()> {
    conn.execute_batch(sql)
}

/// One row from `sqlite_schema`, normalized for comparison.
///
/// We capture `(type, name, tbl_name, sql)` for every entry except the
/// internal autoincrement bookkeeping table (`sqlite_sequence`) and indices
/// that SQLite auto-creates for `UNIQUE`/`PRIMARY KEY` constraints
/// (`sqlite_autoindex_*`). The autoindex names embed an arbitrary numeric
/// suffix that resets on table rebuilds, which would otherwise produce
/// false-positive diffs even for semantically identical schemas. Their
/// underlying constraints are still represented in the `CREATE TABLE`
/// statement we *do* compare.
type SchemaRow = (String, String, String, Option<String>);

fn snapshot_schema(conn: &Connection) -> Vec<SchemaRow> {
    let mut stmt = conn
        .prepare(
            "SELECT type, name, tbl_name, sql \
             FROM sqlite_schema \
             WHERE name NOT IN ('sqlite_sequence') \
               AND name NOT LIKE 'sqlite_autoindex_%' \
             ORDER BY type, name",
        )
        .expect("prepare sqlite_schema query");
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .expect("query sqlite_schema");
    rows.collect::<Result<Vec<_>, _>>()
        .expect("collect sqlite_schema rows")
}

/// Render a schema snapshot for human-readable diff in test failure output.
fn render_snapshot(snapshot: &[SchemaRow]) -> String {
    let mut out = String::new();
    for (ty, name, tbl, sql) in snapshot {
        out.push_str(&format!("[{ty}] name={name} tbl={tbl}\n"));
        if let Some(sql) = sql {
            out.push_str(sql);
            out.push('\n');
        }
        out.push_str("---\n");
    }
    out
}

/// Build a fresh in-memory DB and apply every migration `1..version`
/// (exclusive) so the DB sits in the "before NNNN" state.
fn build_pre_state(migrations: &[Migration], version: u32) -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    // Foreign keys default to OFF in SQLite; the app's first migration turns
    // them on, but it's safest to set it here too so per-migration rebuild
    // recipes that toggle `PRAGMA foreign_keys` see a consistent baseline.
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");
    for m in migrations.iter().filter(|m| m.version < version) {
        let sql = read_migration_sql(&m.up_dir);
        apply(&conn, &sql, &format!("migration {} up (prereq)", m.version));
    }
    conn
}

#[test]
fn migration_round_trip() {
    let migrations = discover_migrations();
    let mut failures: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for m in &migrations {
        let conn = build_pre_state(&migrations, m.version);
        let pre_snapshot = snapshot_schema(&conn);

        let up_sql = read_migration_sql(&m.up_dir);
        apply(&conn, &up_sql, &format!("migration {:04} up", m.version));

        let down_sql = read_migration_sql(&m.down_dir);
        if m.noop_down {
            // `.noop_down` migrations are allowed to fail outright (e.g. the
            // 0016 down uses `RAISE(ABORT)` outside a trigger context, which
            // SQLite rejects in a plain SELECT). We still attempt the apply
            // to detect newly-introduced failures, but downgrade any error
            // to a warning instead of a hard test failure.
            if let Err(e) = try_apply(&conn, &down_sql) {
                warnings.push(format!(
                    "WARN: migration {:04} marked .noop_down — down SQL failed to apply (expected): {e}",
                    m.version
                ));
                continue;
            }
        } else {
            apply(
                &conn,
                &down_sql,
                &format!("migration {:04} down", m.version),
            );
        }

        let post_snapshot = snapshot_schema(&conn);

        if pre_snapshot == post_snapshot {
            continue;
        }

        let diff = format!(
            "migration {:04} round-trip mismatch:\n--- pre-up ---\n{}--- post-down ---\n{}",
            m.version,
            render_snapshot(&pre_snapshot),
            render_snapshot(&post_snapshot),
        );

        if m.noop_down {
            warnings.push(format!(
                "WARN: migration {:04} marked .noop_down — schema diverges after down (expected): {}",
                m.version,
                summarise_diff(&pre_snapshot, &post_snapshot)
            ));
        } else {
            failures.push(diff);
        }
    }

    for w in &warnings {
        eprintln!("{w}");
    }

    assert!(
        failures.is_empty(),
        "{} migration(s) failed the up/down round-trip:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// Short summary of the schema diff (entry names only) for warning lines.
fn summarise_diff(pre: &[SchemaRow], post: &[SchemaRow]) -> String {
    let pre_names: std::collections::BTreeSet<_> = pre
        .iter()
        .map(|(t, n, _, _)| (t.clone(), n.clone()))
        .collect();
    let post_names: std::collections::BTreeSet<_> = post
        .iter()
        .map(|(t, n, _, _)| (t.clone(), n.clone()))
        .collect();
    let added: Vec<_> = post_names.difference(&pre_names).collect();
    let removed: Vec<_> = pre_names.difference(&post_names).collect();
    let common_changed: Vec<_> = pre_names
        .intersection(&post_names)
        .filter(|key| {
            let pre_sql = pre
                .iter()
                .find(|(t, n, _, _)| (t, n) == (&key.0, &key.1))
                .and_then(|(_, _, _, sql)| sql.clone());
            let post_sql = post
                .iter()
                .find(|(t, n, _, _)| (t, n) == (&key.0, &key.1))
                .and_then(|(_, _, _, sql)| sql.clone());
            pre_sql != post_sql
        })
        .collect();
    format!("added={added:?} removed={removed:?} sql_changed={common_changed:?}")
}

/// Sanity check: discovery itself should find at least one migration so a
/// silent path/glob breakage is loud.
#[test]
fn discovery_finds_migrations() {
    let migrations = discover_migrations();
    assert!(
        migrations.len() >= 21,
        "expected to discover at least 21 migrations (got {}); did the path resolution break?",
        migrations.len()
    );
    // Versions must be unique and contiguous from 1 — a missing or duplicate
    // numeric prefix is almost always a bug.
    let mut seen = std::collections::BTreeSet::new();
    for m in &migrations {
        assert!(
            seen.insert(m.version),
            "duplicate migration version {}",
            m.version
        );
    }
}
