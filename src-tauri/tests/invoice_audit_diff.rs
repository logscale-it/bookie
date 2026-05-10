//! DAT-4.c: Verify the `invoices_audit_update` trigger (added in DAT-4.b,
//! migration 0019) writes exactly one `invoice_audit` row when an invoice's
//! `net_cents` is updated, and that the row's `fields_diff` JSON column
//! captures the before/after values for that single changed column only.
//!
//! Strategy
//! --------
//! 1. Build an in-memory SQLite database with foreign keys enabled and
//!    apply every up-migration in version order via the same .sql sources
//!    the production build embeds with `include_str!`. This avoids
//!    duplicating the schema in the test and ensures any future schema
//!    change must be reflected in the test on the same commit.
//! 2. Insert the minimum parent rows required by `invoices`'s foreign keys
//!    (`companies`, `customers`).
//! 3. Insert one draft invoice with `net_cents = 1000`. The audit insert
//!    trigger fires once (op='insert').
//! 4. UPDATE `net_cents` to 2000. The audit update trigger fires once
//!    (op='update'); only `net_cents` actually changed, so `fields_diff`
//!    must contain exactly that one key.
//! 5. Assert: total `invoice_audit` rows == 2, the update row's
//!    `fields_diff` deserialises to a single-key object
//!    `{"net_cents": {"before": 1000, "after": 2000}}`, and `entity_type`
//!    / `entity_id` / `op` / `actor` / `ts_unix_us` columns are populated
//!    as the trigger contract specifies.
//!
//! Scope discipline (per work-unit instructions): this test does not
//! exercise insert/delete diffs, items/payments triggers, or
//! cross-entity behaviour — those are separate work-units (DAT-4.d+).

use rusqlite::{params, Connection};

/// Apply the up-migrations in version order. The list mirrors
/// `app_migrations()` in `src/lib.rs`; if a new migration is added the
/// production code path must update both, which is the same constraint
/// any other consumer of these .sql files faces.
const MIGRATIONS_UP: &[&str] = &[
    // 0001 — initial accounting schema. Concatenated in the same order as
    // `app_migrations()` so the FK declarations resolve.
    include_str!("../migrations/0001/00_pragma.sql"),
    include_str!("../migrations/0001/01_companies.sql"),
    include_str!("../migrations/0001/02_customers.sql"),
    include_str!("../migrations/0001/03_projects.sql"),
    include_str!("../migrations/0001/04_invoices.sql"),
    include_str!("../migrations/0001/05_invoice_items.sql"),
    include_str!("../migrations/0001/06_time_entries.sql"),
    include_str!("../migrations/0001/07_payments.sql"),
    include_str!("../migrations/0001/08_invoice_status_history.sql"),
    include_str!("../migrations/0002/01_settings.sql"),
    include_str!("../migrations/0003/01_customers_website.sql"),
    include_str!("../migrations/0004/01_invoice_delivery_surcharge.sql"),
    include_str!("../migrations/0005/01_org_bank_account_holder.sql"),
    include_str!("../migrations/0006/01_org_address_fields.sql"),
    include_str!("../migrations/0007/01_customer_type_and_incoming_invoices.sql"),
    include_str!("../migrations/0008/01_settings_s3.sql"),
    include_str!("../migrations/0009/01_incoming_invoices_s3_key.sql"),
    include_str!("../migrations/0010/01_s3_auto_backup.sql"),
    include_str!("../migrations/0011/01_payments_restrict_delete.sql"),
    include_str!("../migrations/0012/01_clear_s3_credentials.sql"),
    include_str!("../migrations/0013/01_invoices_s3_key.sql"),
    include_str!("../migrations/0014/01_locale_and_legal.sql"),
    include_str!("../migrations/0015/01_money_cents_columns.sql"),
    include_str!("../migrations/0016/01_invoice_number_per_company.sql"),
    // 0017 — invoice_audit table (DAT-4.a).
    include_str!("../migrations/0017/01_invoice_audit.sql"),
    include_str!("../migrations/0018/01_auto_backup_status.sql"),
    // 0019 — audit triggers under test (DAT-4.b).
    include_str!("../migrations/0019/01_invoice_audit_triggers.sql"),
    include_str!("../migrations/0020/01_invoice_immutability.sql"),
    include_str!("../migrations/0021/01_storno_columns.sql"),
];

fn open_migrated_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    // Enable FKs; the production pragma migration (0001/00_pragma.sql) sets
    // this too but rusqlite does not run the pragma until execute_batch is
    // called below — set it explicitly for safety.
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");
    for sql in MIGRATIONS_UP {
        conn.execute_batch(sql).unwrap_or_else(|err| {
            panic!("migration failed:\n--- sql ---\n{sql}\n--- err ---\n{err}")
        });
    }
    conn
}

fn insert_company_and_customer(conn: &Connection) -> (i64, i64) {
    conn.execute("INSERT INTO companies (name) VALUES ('Acme GmbH')", [])
        .expect("insert company");
    let company_id = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO customers (company_id, name) VALUES (?1, 'Customer One')",
        params![company_id],
    )
    .expect("insert customer");
    let customer_id = conn.last_insert_rowid();

    (company_id, customer_id)
}

#[test]
fn invoice_audit_diff_captures_net_cents_update() {
    let conn = open_migrated_db();
    let (company_id, customer_id) = insert_company_and_customer(&conn);

    // Insert a draft invoice with net_cents = 1000. Only the columns that
    // are NOT NULL without a default are populated explicitly; everything
    // else takes the schema default. status defaults to 'draft' (per
    // 0001/04_invoices.sql), so the immutability trigger from 0020/0021
    // does not block the subsequent UPDATE.
    conn.execute(
        "INSERT INTO invoices (
             company_id, customer_id, invoice_number, issue_date, net_cents
         ) VALUES (?1, ?2, 'INV-001', '2026-05-10', 1000)",
        params![company_id, customer_id],
    )
    .expect("insert draft invoice");
    let invoice_id = conn.last_insert_rowid();

    // Sanity: after the INSERT the audit insert trigger has fired once.
    let audit_after_insert: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit WHERE entity_type = 'invoices'",
            [],
            |row| row.get(0),
        )
        .expect("count audit rows after insert");
    assert_eq!(
        audit_after_insert, 1,
        "expected 1 audit row after INSERT (op='insert'), got {audit_after_insert}"
    );

    // Mutate net_cents 1000 -> 2000. No other column changes, so the
    // update trigger should emit a fields_diff with exactly one key.
    let updated_rows = conn
        .execute(
            "UPDATE invoices SET net_cents = 2000 WHERE id = ?1",
            params![invoice_id],
        )
        .expect("update net_cents");
    assert_eq!(updated_rows, 1, "UPDATE should have hit exactly one row");

    // --- Total audit rows after the mutation: insert (1) + update (1) = 2.
    let audit_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM invoice_audit", [], |row| row.get(0))
        .expect("count audit rows");
    assert_eq!(
        audit_total, 2,
        "expected exactly 2 invoice_audit rows (one insert, one update), got {audit_total}"
    );

    // --- Exactly one update row exists for this invoice.
    let update_row_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoice_audit
             WHERE entity_type = 'invoices' AND entity_id = ?1 AND op = 'update'",
            params![invoice_id],
            |row| row.get(0),
        )
        .expect("count update audit rows");
    assert_eq!(
        update_row_count, 1,
        "expected exactly one op='update' row for invoice {invoice_id}, got {update_row_count}"
    );

    // --- Inspect the update row's columns.
    let (entity_type, entity_id, op, actor, ts_unix_us, fields_diff): (
        String,
        i64,
        String,
        Option<String>,
        i64,
        String,
    ) = conn
        .query_row(
            "SELECT entity_type, entity_id, op, actor, ts_unix_us, fields_diff
             FROM invoice_audit
             WHERE entity_type = 'invoices' AND entity_id = ?1 AND op = 'update'",
            params![invoice_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("fetch update audit row");

    assert_eq!(entity_type, "invoices");
    assert_eq!(entity_id, invoice_id);
    assert_eq!(op, "update");
    // The trigger leaves actor NULL by design (see comment in
    // migration 0019); the application layer is expected to populate it
    // in a follow-up step.
    assert!(
        actor.is_none(),
        "expected actor to be NULL until the application audit hook lands, got {actor:?}"
    );
    assert!(
        ts_unix_us > 0,
        "expected ts_unix_us to be a positive microsecond timestamp, got {ts_unix_us}"
    );

    // --- The diff must contain exactly the net_cents change. Parse the
    // JSON manually with serde_json so we can assert on shape, not on
    // SQLite's whitespace/key-ordering choices.
    let diff: serde_json::Value =
        serde_json::from_str(&fields_diff).expect("fields_diff is valid JSON");
    let obj = diff
        .as_object()
        .expect("fields_diff JSON root is an object");
    assert_eq!(
        obj.len(),
        1,
        "expected fields_diff to mention exactly one column (net_cents), got {} keys: {:?}",
        obj.len(),
        obj.keys().collect::<Vec<_>>()
    );
    let entry = obj
        .get("net_cents")
        .expect("fields_diff is missing the 'net_cents' key");
    let entry_obj = entry
        .as_object()
        .expect("fields_diff[net_cents] is an object");
    assert_eq!(entry_obj.len(), 2, "expected {{before, after}} only");
    assert_eq!(
        entry_obj.get("before").and_then(|v| v.as_i64()),
        Some(1000),
        "before should be 1000, got {:?}",
        entry_obj.get("before")
    );
    assert_eq!(
        entry_obj.get("after").and_then(|v| v.as_i64()),
        Some(2000),
        "after should be 2000, got {:?}",
        entry_obj.get("after")
    );
}
