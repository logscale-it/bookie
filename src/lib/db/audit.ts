import { getDb } from "./connection";
import { assertOutsideRetention } from "./retention";

/**
 * COMP-1.a (#90): destructive operations on `invoice_audit` rows are gated
 * by the same GoBD retention window that protects invoices and payments.
 *
 * The audit log is normally append-only (DAT-4.b inserts via SQL triggers
 * and there is no UI affordance for deleting rows). This helper exists so
 * that any future maintenance / cleanup tooling routes through the guard
 * instead of issuing raw `DELETE FROM invoice_audit` statements that would
 * bypass retention enforcement.
 *
 * The audit row itself does not carry a `legal_country_code`; we resolve
 * the country from the parent invoice (`entity_id` references invoices /
 * invoice_items / payments — all of which trace back to `invoices.id`),
 * and fall back to `'DE'` (the strictest profile) when the parent invoice
 * has been deleted before the audit row.
 */
export async function deleteAuditRow(id: number): Promise<void> {
  const db = await getDb();
  // Fetch the audit row + its country provenance in a single round-trip.
  // `entity_id` for entity_type='invoices' is the invoice id; for
  // 'invoice_items' and 'payments' the trigger writes the parent invoice
  // id (see migration 0019 commentary) so the same join works for all
  // three audited tables.
  const rows = await db.select<
    {
      ts_unix_us: number;
      legal_country_code: string | null;
    }[]
  >(
    `SELECT a.ts_unix_us, i.legal_country_code
     FROM invoice_audit a
     LEFT JOIN invoices i ON i.id = a.entity_id
     WHERE a.id = $1`,
    [id],
  );
  if (rows.length === 0) {
    // Missing-row case: stay consistent with the other delete helpers and
    // let the DELETE be a no-op rather than surface a "not found" error.
    return;
  }
  const createdAt = unixMicrosToSqliteTimestamp(rows[0].ts_unix_us);
  assertOutsideRetention(
    "Audit-Eintrag",
    rows[0].legal_country_code,
    createdAt,
  );
  await db.execute("DELETE FROM invoice_audit WHERE id = $1", [id]);
}

/**
 * `invoice_audit.ts_unix_us` is microseconds since the Unix epoch (UTC).
 * Convert to a SQLite-style 'YYYY-MM-DD HH:MM:SS' string the retention
 * helper recognizes.
 */
function unixMicrosToSqliteTimestamp(usEpoch: number): string {
  const d = new Date(usEpoch / 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}
