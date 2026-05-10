//! COMP-1.b: GoBD-Export ZIP generator.
//!
//! Produces an archive that satisfies a German Betriebsprüfung (tax audit)
//! by extracting every booking-relevant table to CSV plus a manifest with
//! per-file SHA-256 digests, and a top-level `export_signature.txt` that is
//! the SHA-256 of the manifest itself.
//!
//! The export is constructed in-memory and returned to the caller as bytes;
//! the Tauri command at the call site is responsible for handing those bytes
//! to the frontend (which writes them via the standard download flow used by
//! `backup_database`). This keeps `gobd` itself free of Tauri / filesystem
//! coupling so the entire pipeline is unit-testable against a temp SQLite
//! DB without a running app.
//!
//! ## Archive layout
//!
//! ```text
//! gobd-export-<from>-<to>.zip
//! ├── companies.csv          # full table dump (all columns, header row)
//! ├── customers.csv
//! ├── invoices.csv           # filtered to issue_date in [from, to]
//! ├── invoice_items.csv      # rows whose invoice is in the export
//! ├── payments.csv           # rows whose invoice is in the export
//! ├── invoice_audit.csv      # full audit log (no year filter -- GoBD
//! │                          #   requires the trail be preserved as-is)
//! ├── schema_version.txt     # output of PRAGMA user_version, plus a
//! │                          #   line per table with its column list
//! ├── manifest.json          # {"files": [{"path": ..., "sha256": ...,
//! │                          #              "bytes": ...}, ...]}
//! └── export_signature.txt   # lowercase hex SHA-256 of manifest.json
//! ```
//!
//! ## Year-range filter
//!
//! The `year_range` is inclusive on both ends and applies to:
//! - `invoices.issue_date` (TEXT in `YYYY-MM-DD` form)
//! - transitively to `invoice_items` (via `invoice_id`)
//! - transitively to `payments` (via `invoice_id`)
//!
//! Companies, customers, and the audit log are dumped in full. This matches
//! the GoBD intent: an auditor must be able to reconstruct the booking
//! universe of the requested period, including the parties involved and the
//! complete change history.

use std::io::{Cursor, Write};

use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// Inclusive year range for the export. Both ends are full calendar years
/// (no partial-year support — a Betriebsprüfung is conducted per fiscal
/// year). `from` must be `<= to`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct YearRange {
    pub from: i32,
    pub to: i32,
}

impl YearRange {
    /// Returns the lower-bound `YYYY-01-01` and upper-bound `YYYY-12-31`
    /// strings used to filter date-typed columns stored as TEXT.
    pub fn date_bounds(&self) -> (String, String) {
        (
            format!("{:04}-01-01", self.from),
            format!("{:04}-12-31", self.to),
        )
    }
}

/// One file recorded in `manifest.json`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Top-level structure serialised to `manifest.json`.
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub format_version: u32,
    pub generated_at: String,
    pub year_range: YearRange,
    pub files: Vec<ManifestEntry>,
}

/// Result of a successful export.
#[derive(Debug)]
pub struct GobdExport {
    pub file_name: String,
    pub bytes: Vec<u8>,
    /// Hex SHA-256 of `manifest.json` — also written to
    /// `export_signature.txt` inside the ZIP. Returned separately so the
    /// caller can log / surface it without re-parsing the archive.
    pub signature: String,
}

/// Errors surfaced by the GoBD pipeline. Mapped to `BookieError::IoError`
/// at the Tauri command boundary so the frontend sees a typed failure.
#[derive(Debug)]
pub enum GobdError {
    InvalidRange { from: i32, to: i32 },
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Zip(zip::result::ZipError),
    Serde(serde_json::Error),
}

impl std::fmt::Display for GobdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GobdError::InvalidRange { from, to } => {
                write!(
                    f,
                    "Invalid year_range: from={from} to={to} (from must be <= to)"
                )
            }
            GobdError::Sqlite(e) => write!(f, "SQLite error: {e}"),
            GobdError::Io(e) => write!(f, "I/O error: {e}"),
            GobdError::Zip(e) => write!(f, "ZIP error: {e}"),
            GobdError::Serde(e) => write!(f, "Serialization error: {e}"),
        }
    }
}

impl From<rusqlite::Error> for GobdError {
    fn from(e: rusqlite::Error) -> Self {
        GobdError::Sqlite(e)
    }
}
impl From<std::io::Error> for GobdError {
    fn from(e: std::io::Error) -> Self {
        GobdError::Io(e)
    }
}
impl From<zip::result::ZipError> for GobdError {
    fn from(e: zip::result::ZipError) -> Self {
        GobdError::Zip(e)
    }
}
impl From<serde_json::Error> for GobdError {
    fn from(e: serde_json::Error) -> Self {
        GobdError::Serde(e)
    }
}

/// Tables dumped in full (no row filter). The ordering matches the natural
/// reading order for an auditor (parties first, then audit log).
const FULL_TABLES: &[&str] = &["companies", "customers", "invoice_audit"];

/// Tables filtered by the export's year range.
///
/// `invoices` is filtered directly on `issue_date`. The two child tables
/// (`invoice_items`, `payments`) are filtered transitively by joining to
/// `invoices` so the export is internally consistent — no orphan items or
/// payments referencing invoices that are not in the archive.
const FILTERED_TABLES: &[&str] = &["invoices", "invoice_items", "payments"];

/// CSV escaping per RFC 4180. Quotes the field if it contains `,`, `"`, `\n`
/// or `\r`; doubles internal `"`.
fn csv_escape(value: &str) -> String {
    let needs_quote = value
        .chars()
        .any(|c| c == ',' || c == '"' || c == '\n' || c == '\r');
    if !needs_quote {
        return value.to_string();
    }
    let escaped = value.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Render a single SQLite value as the string written to the CSV cell.
/// `NULL` → empty string (RFC 4180 has no NULL marker; an empty unquoted
/// cell is the conventional in-band signal). Blobs are hex-encoded.
fn render_value(value: ValueRef<'_>) -> String {
    use std::fmt::Write as _;
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => {
            // Use Rust's default float formatting; this is round-trip safe
            // (the auditor's CSV parser will read back an f64).
            f.to_string()
        }
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Blob(bytes) => {
            let mut hex = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                let _ = write!(hex, "{b:02x}");
            }
            hex
        }
    }
}

/// Lowercase hex SHA-256 of `data`. Duplicated from `lib::sha256_hex` so
/// the gobd module is self-contained (and unit-testable without the full
/// crate context).
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

/// Discover the column list of a table via `PRAGMA table_info`. Used to
/// build the CSV header row in the same order columns appear in the schema.
fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, GobdError> {
    // PRAGMA table_info(<table>) — table name cannot be a parameter, so we
    // validate it against the allowlist below before interpolating. The
    // allowlist is a fixed const (FULL_TABLES + FILTERED_TABLES), so this
    // is not user-controlled SQL.
    let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', ""));
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut cols = Vec::new();
    while let Some(row) = rows.next()? {
        // table_info columns: cid, name, type, notnull, dflt_value, pk
        let name: String = row.get(1)?;
        cols.push(name);
    }
    Ok(cols)
}

/// Quote and validate that `table` is in the allowlist of GoBD-export
/// tables. Returns the table name (caller embeds into SQL).
fn assert_known_table(table: &str) -> Result<&str, GobdError> {
    if FULL_TABLES.contains(&table) || FILTERED_TABLES.contains(&table) {
        Ok(table)
    } else {
        Err(GobdError::Sqlite(rusqlite::Error::InvalidQuery))
    }
}

/// Build a SELECT statement for `table` honouring the year-range filter
/// where applicable. Returns the SQL plus an optional bind-parameter list.
fn select_for_table(table: &str, range: &YearRange) -> Result<(String, Vec<String>), GobdError> {
    let table = assert_known_table(table)?;
    let (from, to) = range.date_bounds();
    let (sql, params) = match table {
        "invoices" => (
            "SELECT * FROM invoices WHERE issue_date BETWEEN ?1 AND ?2 ORDER BY id".to_string(),
            vec![from, to],
        ),
        "invoice_items" => (
            "SELECT ii.* FROM invoice_items ii \
             JOIN invoices i ON i.id = ii.invoice_id \
             WHERE i.issue_date BETWEEN ?1 AND ?2 \
             ORDER BY ii.id"
                .to_string(),
            vec![from, to],
        ),
        "payments" => (
            "SELECT p.* FROM payments p \
             JOIN invoices i ON i.id = p.invoice_id \
             WHERE i.issue_date BETWEEN ?1 AND ?2 \
             ORDER BY p.id"
                .to_string(),
            vec![from, to],
        ),
        _ => (format!("SELECT * FROM \"{table}\" ORDER BY id"), vec![]),
    };
    Ok((sql, params))
}

/// Dump one table to a CSV byte buffer.
pub fn dump_table_to_csv(
    conn: &Connection,
    table: &str,
    range: &YearRange,
) -> Result<Vec<u8>, GobdError> {
    let cols = table_columns(conn, table)?;
    let (sql, params) = select_for_table(table, range)?;

    let mut out: Vec<u8> = Vec::new();

    // Header row: column names in PRAGMA order. `invoices.*` etc. SELECTs
    // also return columns in PRAGMA order so the header lines up with the
    // data rows even with the join-based filters above.
    let header_line = cols
        .iter()
        .map(|c| csv_escape(c))
        .collect::<Vec<_>>()
        .join(",");
    out.extend_from_slice(header_line.as_bytes());
    out.extend_from_slice(b"\r\n");

    let mut stmt = conn.prepare(&sql)?;
    let bind: Vec<&dyn rusqlite::ToSql> =
        params.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let mut rows = stmt.query(bind.as_slice())?;

    while let Some(row) = rows.next()? {
        let mut fields: Vec<String> = Vec::with_capacity(cols.len());
        for i in 0..cols.len() {
            let v = row.get_ref(i)?;
            fields.push(csv_escape(&render_value(v)));
        }
        out.extend_from_slice(fields.join(",").as_bytes());
        out.extend_from_slice(b"\r\n");
    }

    Ok(out)
}

/// Build the `schema_version.txt` content: the SQLite `PRAGMA user_version`
/// (set by tauri-plugin-sql to the highest applied migration version) plus
/// a column listing per exported table so an auditor can reproduce the
/// CSV's column order.
fn build_schema_version(conn: &Connection) -> Result<Vec<u8>, GobdError> {
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let mut out = String::new();
    out.push_str(&format!("user_version={user_version}\n"));
    for table in FULL_TABLES.iter().chain(FILTERED_TABLES.iter()) {
        let cols = table_columns(conn, table)?;
        out.push_str(&format!("{}: {}\n", table, cols.join(",")));
    }
    Ok(out.into_bytes())
}

/// Open a fresh read-only connection on the live DB file. Read-only avoids
/// any chance of contention with the tauri-plugin-sql writer pool and is
/// the natural posture for a snapshot export.
pub fn open_readonly(db_path: &std::path::Path) -> Result<Connection, GobdError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(db_path, flags)?;
    Ok(conn)
}

/// End-to-end: read the DB, dump each table, build the manifest, sign it,
/// and return the assembled ZIP bytes. Pure I/O wrapper around the helpers
/// above so the orchestration is itself unit-testable.
pub fn build_export(conn: &Connection, range: YearRange) -> Result<GobdExport, GobdError> {
    if range.from > range.to {
        return Err(GobdError::InvalidRange {
            from: range.from,
            to: range.to,
        });
    }

    // 1. Dump each table to bytes.
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for table in FULL_TABLES.iter().chain(FILTERED_TABLES.iter()) {
        let csv = dump_table_to_csv(conn, table, &range)?;
        files.push((format!("{table}.csv"), csv));
    }

    // 2. schema_version.txt — included in manifest just like CSVs.
    let schema_version = build_schema_version(conn)?;
    files.push(("schema_version.txt".to_string(), schema_version));

    // 3. Compute per-file digests, then build the manifest.
    let manifest_entries: Vec<ManifestEntry> = files
        .iter()
        .map(|(path, bytes)| ManifestEntry {
            path: path.clone(),
            sha256: sha256_hex(bytes),
            bytes: bytes.len() as u64,
        })
        .collect();

    let manifest = Manifest {
        format_version: 1,
        generated_at: rfc3339_now(),
        year_range: range,
        files: manifest_entries,
    };
    // Pretty-printed so an auditor can read the manifest in a text editor.
    let manifest_json = serde_json::to_vec_pretty(&manifest)?;
    let signature = sha256_hex(&manifest_json);

    // 4. Stream everything into an in-memory ZIP.
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zip = ZipWriter::new(Cursor::new(&mut buf));
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        for (path, bytes) in &files {
            zip.start_file(path, opts)?;
            zip.write_all(bytes)?;
        }

        zip.start_file("manifest.json", opts)?;
        zip.write_all(&manifest_json)?;

        zip.start_file("export_signature.txt", opts)?;
        zip.write_all(signature.as_bytes())?;

        zip.finish()?;
    }

    let file_name = format!("gobd-export-{}-{}.zip", range.from, range.to);
    Ok(GobdExport {
        file_name,
        bytes: buf,
        signature,
    })
}

/// Naive RFC 3339 timestamp ("YYYY-MM-DDTHH:MM:SSZ") computed from
/// `SystemTime`. We deliberately avoid pulling `chrono` for one call site;
/// `time` is also not in the dep tree. This is sufficient for the manifest
/// (the timestamp is informational — the audit trail is in `invoice_audit`).
fn rfc3339_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Days from epoch / time-of-day from Howard Hinnant's algorithm, adapted
    // for 64-bit signed seconds.
    let z = secs as i64;
    let days = z.div_euclid(86_400);
    let secs_of_day = z.rem_euclid(86_400) as u64;

    // Civil-from-days (Hinnant). Valid for the entire Gregorian range.
    let z_days = days + 719_468;
    let era = if z_days >= 0 {
        z_days
    } else {
        z_days - 146_096
    } / 146_097;
    let doe = (z_days - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };

    let h = secs_of_day / 3600;
    let min = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    format!("{year:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::io::Read;

    /// Build an in-memory DB seeded with the minimum schema needed by the
    /// export. We deliberately avoid pulling the production migrations here
    /// — the export must work against any schema that contains the
    /// expected tables, and pinning to migrations would couple this test
    /// to migration ordering.
    fn seed_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch(
            r#"
            PRAGMA user_version = 22;
            CREATE TABLE companies (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE customers (
                id INTEGER PRIMARY KEY,
                company_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                notes TEXT
            );
            CREATE TABLE invoices (
                id INTEGER PRIMARY KEY,
                company_id INTEGER NOT NULL,
                customer_id INTEGER NOT NULL,
                invoice_number TEXT NOT NULL,
                issue_date TEXT NOT NULL,
                gross_amount REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE invoice_items (
                id INTEGER PRIMARY KEY,
                invoice_id INTEGER NOT NULL,
                description TEXT NOT NULL,
                quantity REAL NOT NULL,
                unit_price REAL NOT NULL
            );
            CREATE TABLE payments (
                id INTEGER PRIMARY KEY,
                invoice_id INTEGER NOT NULL,
                paid_at TEXT NOT NULL,
                amount REAL NOT NULL
            );
            CREATE TABLE invoice_audit (
                id INTEGER PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id INTEGER NOT NULL,
                op TEXT NOT NULL,
                actor TEXT,
                ts_unix_us INTEGER NOT NULL,
                fields_diff TEXT NOT NULL
            );

            INSERT INTO companies (id, name) VALUES (1, 'Acme GmbH');
            INSERT INTO customers (id, company_id, name, notes) VALUES
                (1, 1, 'Müller AG', 'Notes with, comma'),
                (2, 1, 'O''Brien & Co', 'Has "quotes" and a newline
inside');
            INSERT INTO invoices (id, company_id, customer_id, invoice_number, issue_date, gross_amount) VALUES
                (1, 1, 1, 'R-2024-001', '2024-06-01', 119.0),
                (2, 1, 1, 'R-2025-001', '2025-02-15', 238.0),
                (3, 1, 2, 'R-2025-002', '2025-11-30', 100.5);
            INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price) VALUES
                (1, 1, 'Beratung 2024', 1.0, 100.0),
                (2, 2, 'Beratung 2025 Q1', 2.0, 100.0),
                (3, 3, 'Lizenz', 1.0, 84.45);
            INSERT INTO payments (id, invoice_id, paid_at, amount) VALUES
                (1, 1, '2024-07-01', 119.0),
                (2, 2, '2025-03-01', 238.0);
            INSERT INTO invoice_audit (id, entity_type, entity_id, op, actor, ts_unix_us, fields_diff) VALUES
                (1, 'invoices', 1, 'insert', 'system', 1717200000000000, '{}'),
                (2, 'invoices', 2, 'insert', 'system', 1739577600000000, '{}');
            "#,
        )
        .expect("seed schema");
        conn
    }

    #[test]
    fn csv_escape_leaves_simple_text_unchanged() {
        assert_eq!(csv_escape("hello"), "hello");
        assert_eq!(csv_escape("R-2025-001"), "R-2025-001");
    }

    #[test]
    fn csv_escape_quotes_commas() {
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
    }

    #[test]
    fn csv_escape_doubles_internal_quotes() {
        assert_eq!(csv_escape("she said \"hi\""), "\"she said \"\"hi\"\"\"");
    }

    #[test]
    fn csv_escape_quotes_newlines() {
        assert_eq!(csv_escape("a\nb"), "\"a\nb\"");
        assert_eq!(csv_escape("a\r\nb"), "\"a\r\nb\"");
    }

    #[test]
    fn year_range_date_bounds_pads_year() {
        let r = YearRange {
            from: 2024,
            to: 2025,
        };
        let (from, to) = r.date_bounds();
        assert_eq!(from, "2024-01-01");
        assert_eq!(to, "2025-12-31");
    }

    #[test]
    fn build_export_rejects_inverted_range() {
        let conn = seed_db();
        let err = build_export(
            &conn,
            YearRange {
                from: 2025,
                to: 2024,
            },
        )
        .expect_err("inverted range must reject");
        assert!(matches!(
            err,
            GobdError::InvalidRange {
                from: 2025,
                to: 2024
            }
        ));
    }

    #[test]
    fn dump_table_csv_includes_header_and_rows() {
        let conn = seed_db();
        let csv = dump_table_to_csv(
            &conn,
            "companies",
            &YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("dump companies");
        let s = String::from_utf8(csv).unwrap();
        // Header (PRAGMA-order)
        assert!(s.starts_with("id,name\r\n"), "got: {s:?}");
        assert!(s.contains("1,Acme GmbH\r\n"));
    }

    #[test]
    fn dump_table_csv_filters_invoices_by_year_range() {
        let conn = seed_db();
        // Only 2025 — must include R-2025-001 and R-2025-002, NOT R-2024-001.
        let csv = dump_table_to_csv(
            &conn,
            "invoices",
            &YearRange {
                from: 2025,
                to: 2025,
            },
        )
        .expect("dump invoices");
        let s = String::from_utf8(csv).unwrap();
        assert!(s.contains("R-2025-001"));
        assert!(s.contains("R-2025-002"));
        assert!(
            !s.contains("R-2024-001"),
            "2024 invoice must be filtered out: {s:?}"
        );
    }

    #[test]
    fn dump_table_csv_filters_children_transitively() {
        let conn = seed_db();
        // Only 2024 — invoice_items and payments must be limited to invoice 1.
        let r = YearRange {
            from: 2024,
            to: 2024,
        };
        let items = dump_table_to_csv(&conn, "invoice_items", &r).expect("dump items");
        let s = String::from_utf8(items).unwrap();
        assert!(s.contains("Beratung 2024"));
        assert!(!s.contains("Beratung 2025"));
        assert!(!s.contains("Lizenz"));

        let pays = dump_table_to_csv(&conn, "payments", &r).expect("dump payments");
        let p = String::from_utf8(pays).unwrap();
        // Payment 1 is for invoice 1 (2024); payment 2 for invoice 2 (2025).
        assert!(p.contains("2024-07-01"));
        assert!(!p.contains("2025-03-01"));
    }

    #[test]
    fn dump_table_csv_escapes_special_characters_in_data() {
        let conn = seed_db();
        let csv = dump_table_to_csv(
            &conn,
            "customers",
            &YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("dump customers");
        let s = String::from_utf8(csv).unwrap();
        // "Notes with, comma" must be quoted.
        assert!(s.contains("\"Notes with, comma\""), "got: {s:?}");
        // Doubled quotes for the inner "quotes":
        assert!(s.contains("\"\"quotes\"\""), "got: {s:?}");
        // Newline-containing field is wrapped.
        assert!(
            s.contains("\"Has \"\"quotes\"\" and a newline\ninside\""),
            "got: {s:?}"
        );
        // O'Brien is single-quoted source; CSV does not need to escape `'`.
        assert!(s.contains("O'Brien & Co"));
    }

    #[test]
    fn dump_table_csv_renders_null_as_empty_field() {
        let conn = seed_db();
        // Insert a customer with NULL notes; verify the cell is empty.
        conn.execute(
            "INSERT INTO customers (id, company_id, name, notes) VALUES (?1, ?2, ?3, NULL)",
            params![3, 1, "NullNotes Inc"],
        )
        .unwrap();
        let csv = dump_table_to_csv(
            &conn,
            "customers",
            &YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("dump customers");
        let s = String::from_utf8(csv).unwrap();
        // Last row should end with `,\r\n` because notes is NULL.
        assert!(s.contains("3,1,NullNotes Inc,\r\n"), "got: {s:?}");
    }

    #[test]
    fn build_export_produces_zip_with_expected_layout() {
        let conn = seed_db();
        let export = build_export(
            &conn,
            YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("export");
        assert_eq!(export.file_name, "gobd-export-2024-2025.zip");
        assert_eq!(export.signature.len(), 64);

        // Re-open the ZIP and check the entries.
        let cursor = std::io::Cursor::new(&export.bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("open zip");
        let mut names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        let expected = [
            "companies.csv",
            "customers.csv",
            "export_signature.txt",
            "invoice_audit.csv",
            "invoice_items.csv",
            "invoices.csv",
            "manifest.json",
            "payments.csv",
            "schema_version.txt",
        ];
        assert_eq!(names, expected);
    }

    #[test]
    fn build_export_manifest_sha_matches_file_bytes() {
        let conn = seed_db();
        let export = build_export(
            &conn,
            YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("export");

        let cursor = std::io::Cursor::new(&export.bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("open zip");

        // Read manifest.
        let mut manifest_bytes = Vec::new();
        zip.by_name("manifest.json")
            .unwrap()
            .read_to_end(&mut manifest_bytes)
            .unwrap();
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes).expect("parse manifest");

        // Verify each manifest entry's SHA against the file inside the ZIP.
        for entry in &manifest.files {
            let mut file_bytes = Vec::new();
            zip.by_name(&entry.path)
                .unwrap_or_else(|_| panic!("manifest references missing file {}", entry.path))
                .read_to_end(&mut file_bytes)
                .unwrap();
            assert_eq!(
                file_bytes.len() as u64,
                entry.bytes,
                "size for {}",
                entry.path
            );
            assert_eq!(
                sha256_hex(&file_bytes),
                entry.sha256,
                "sha for {}",
                entry.path
            );
        }
    }

    #[test]
    fn build_export_signature_matches_manifest_sha() {
        let conn = seed_db();
        let export = build_export(
            &conn,
            YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("export");

        let cursor = std::io::Cursor::new(&export.bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("open zip");

        let mut manifest_bytes = Vec::new();
        zip.by_name("manifest.json")
            .unwrap()
            .read_to_end(&mut manifest_bytes)
            .unwrap();
        let mut sig_bytes = Vec::new();
        zip.by_name("export_signature.txt")
            .unwrap()
            .read_to_end(&mut sig_bytes)
            .unwrap();
        let sig_in_zip = String::from_utf8(sig_bytes).unwrap();

        let recomputed = sha256_hex(&manifest_bytes);
        assert_eq!(
            sig_in_zip, recomputed,
            "signature must equal SHA-256 of manifest bytes"
        );
        assert_eq!(
            export.signature, recomputed,
            "returned signature must equal SHA in zip"
        );
    }

    #[test]
    fn build_export_csvs_round_trip_through_a_csv_parser() {
        // Implement the verification step from the issue: a simple,
        // RFC-4180-compliant parser must reconstruct the original cells.
        let conn = seed_db();
        let export = build_export(
            &conn,
            YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("export");

        let cursor = std::io::Cursor::new(&export.bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("open zip");

        for name in [
            "companies.csv",
            "customers.csv",
            "invoices.csv",
            "invoice_items.csv",
            "payments.csv",
            "invoice_audit.csv",
        ] {
            let mut buf = Vec::new();
            zip.by_name(name).unwrap().read_to_end(&mut buf).unwrap();
            let s = String::from_utf8(buf).expect("utf8");
            let rows = parse_csv(&s);
            // Header + N data rows; every row must have the same column count.
            assert!(!rows.is_empty(), "{name} must have at least a header");
            let cols = rows[0].len();
            for (i, row) in rows.iter().enumerate() {
                assert_eq!(
                    row.len(),
                    cols,
                    "{name}: row {i} column count mismatch (got {} cols, header has {cols})",
                    row.len()
                );
            }
        }
    }

    #[test]
    fn build_export_csv_parser_round_trip_preserves_special_cells() {
        // Spot-check that the cells with commas/quotes/newlines come back
        // bit-for-bit through the parser.
        let conn = seed_db();
        let export = build_export(
            &conn,
            YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("export");

        let cursor = std::io::Cursor::new(&export.bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("open zip");
        let mut buf = Vec::new();
        zip.by_name("customers.csv")
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        let s = String::from_utf8(buf).unwrap();
        let rows = parse_csv(&s);

        // Header + 2 customers (id 1, 2).
        assert_eq!(rows.len(), 3, "header + 2 customers");
        // Row for id=1: notes contains the comma.
        let row1 = &rows[1];
        assert_eq!(row1[0], "1");
        assert_eq!(row1[2], "Müller AG");
        assert_eq!(row1[3], "Notes with, comma");
        // Row for id=2: notes contains "quotes" and a newline.
        let row2 = &rows[2];
        assert_eq!(row2[0], "2");
        assert_eq!(row2[2], "O'Brien & Co");
        assert_eq!(row2[3], "Has \"quotes\" and a newline\ninside");
    }

    #[test]
    fn schema_version_includes_user_version_and_columns() {
        let conn = seed_db();
        let export = build_export(
            &conn,
            YearRange {
                from: 2024,
                to: 2025,
            },
        )
        .expect("export");

        let cursor = std::io::Cursor::new(&export.bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("open zip");
        let mut buf = Vec::new();
        zip.by_name("schema_version.txt")
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("user_version=22"), "got: {s:?}");
        assert!(s.contains("invoices: id,company_id"));
        assert!(s.contains("invoice_audit: id,entity_type"));
    }

    /// Minimal RFC-4180 CSV parser used only by the round-trip tests above.
    /// Not exposed outside `tests` — production callers (auditors) will use
    /// their own tooling (Excel, LibreOffice, csv crate, ...).
    ///
    /// Walks the input character-by-character (NOT byte-by-byte) so that
    /// multi-byte UTF-8 sequences like `ü` round-trip cleanly.
    fn parse_csv(input: &str) -> Vec<Vec<String>> {
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut row: Vec<String> = Vec::new();
        let mut field = String::new();
        let mut in_quotes = false;
        let mut chars = input.chars().peekable();
        while let Some(c) = chars.next() {
            if in_quotes {
                if c == '"' {
                    // Doubled quote -> literal `"`.
                    if chars.peek() == Some(&'"') {
                        field.push('"');
                        chars.next();
                        continue;
                    }
                    in_quotes = false;
                } else {
                    field.push(c);
                }
            } else {
                match c {
                    '"' => {
                        in_quotes = true;
                    }
                    ',' => {
                        row.push(std::mem::take(&mut field));
                    }
                    '\r' if chars.peek() == Some(&'\n') => {
                        chars.next();
                        row.push(std::mem::take(&mut field));
                        rows.push(std::mem::take(&mut row));
                    }
                    '\n' => {
                        row.push(std::mem::take(&mut field));
                        rows.push(std::mem::take(&mut row));
                    }
                    _ => {
                        field.push(c);
                    }
                }
            }
        }
        // Trailing field/row if the input doesn't end with a newline.
        if !field.is_empty() || !row.is_empty() {
            row.push(field);
            rows.push(row);
        }
        rows
    }
}
