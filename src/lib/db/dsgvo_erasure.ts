/**
 * COMP-2.b (#94): DSGVO Art. 17 (right to erasure) implementation with the
 * §147 AO 10-year retention exception baked in.
 *
 * Every customer row is a "data subject" under DSGVO. Art. 17 grants a right
 * to erasure, but Art. 17(3)(b) explicitly subordinates that right to other
 * legal obligations the controller is subject to — and German booking law
 * (§147 AO + GoBD) requires invoices and their associated PII to be retained
 * for ten years. So the legally-correct flow is:
 *
 *   1. If the customer has at least one invoice that is still inside the
 *      retention window, REFUSE the erasure entirely. Write a refusal record
 *      into `invoice_audit` so the controller can later prove to a regulator
 *      that the request was received and lawfully declined, and throw a
 *      typed `RetentionViolation` so the UI surfaces the German reason.
 *
 *   2. If every invoice belonging to the customer is OUTSIDE the retention
 *      window (including the case where the customer has no invoices at
 *      all), anonymize the customer row's PII fields:
 *        - name           -> 'Anonymisiert'
 *        - contact_name   -> NULL
 *        - email          -> NULL
 *        - phone          -> NULL
 *        - street         -> NULL
 *        - postal_code    -> NULL
 *        - city           -> NULL
 *        - vat_id         -> NULL
 *        - website        -> NULL
 *      The numerical / audit columns (id, company_id, country_code,
 *      customer_number, type, created_at, updated_at) are preserved so the
 *      FK from invoices is never broken — anonymization is a UPDATE, not a
 *      DELETE. The historical invoice rows themselves are not modified;
 *      they keep the snapshot of recipient_name etc. they were issued with,
 *      which is the GoBD-correct behaviour (issued invoices are immutable).
 *
 * This module deliberately mirrors `dsgvo_export.ts` (COMP-2.a, the Art. 15
 * sister flow) in shape and naming so the UI can compose them.
 */

import { getDb } from "./connection";
import { isWithinRetention, retentionViolationError } from "./retention";
import type { Customer, Invoice } from "./types";

/**
 * Outcome of a successful (non-refused) erasure call. Returned so the UI can
 * confirm the operation and so tests can assert on the post-state without
 * an extra round-trip.
 */
export interface AnonymizationResult {
  customerId: number;
  /** Number of invoices the customer had at the time of erasure. */
  invoiceCount: number;
}

/** PII columns on `customers` that are wiped during anonymization. */
const PII_COLUMNS_TO_NULL = [
  "contact_name",
  "email",
  "phone",
  "street",
  "postal_code",
  "city",
  "vat_id",
  "website",
] as const;

/** Constant placeholder written into NOT-NULL `name`. */
export const ANONYMIZED_NAME = "Anonymisiert";

/**
 * Constant German-language reason recorded in `invoice_audit.fields_diff`
 * and surfaced on the typed RetentionViolation when erasure is refused.
 *
 * Exported so tests and the UI can match on the canonical string instead of
 * duplicating it.
 */
export const RETENTION_REFUSAL_REASON =
  "§147 AO 10-Jahres-Aufbewahrung — Löschung verweigert";

/**
 * Anonymize all PII on `customer_id` if it is legally permitted.
 *
 * Behaviour:
 *   - Customer not found -> throws `Error('Customer N not found')` (mirrors
 *     `collectCustomerData` in dsgvo_export.ts).
 *   - At least one invoice of the customer is still inside the §147 AO
 *     retention window -> writes a refusal row into `invoice_audit`
 *     (entity_type='customers', entity_id=customer_id, op='update',
 *     fields_diff carrying the reason + the offending invoice ids), then
 *     throws a typed `RetentionViolation` Error whose message is the same
 *     German reason. The customer row is left bit-for-bit unchanged.
 *   - Otherwise -> updates the customer row to wipe PII (UPDATE, not
 *     DELETE: the FK from invoices is preserved).
 *
 * The two write paths (refusal-row insert, anonymizing UPDATE) are each a
 * single statement and must NOT share a transaction: the refusal must
 * persist precisely because we then throw, and SQLite would roll back any
 * surrounding transaction on that throw. Keeping each branch as a single
 * autocommit statement is therefore both simpler and correct.
 */
export async function anonymizeCustomer(
  customerId: number,
  now: Date = new Date(),
): Promise<AnonymizationResult> {
  const db = await getDb();

  const customerRows = await db.select<Customer[]>(
    "SELECT * FROM customers WHERE id = $1",
    [customerId],
  );
  const customer = customerRows[0];
  if (!customer) {
    throw new Error(`Customer ${customerId} not found`);
  }

  const invoices = await db.select<
    Pick<Invoice, "id" | "created_at" | "legal_country_code">[]
  >(
    `SELECT id, created_at, legal_country_code
       FROM invoices
      WHERE customer_id = $1
      ORDER BY id`,
    [customerId],
  );

  // Collect every invoice that is still inside the retention window. The
  // refusal must list them all, not just the first one, so the controller
  // can show the regulator exactly which records are blocking erasure.
  const blockingInvoiceIds: number[] = [];
  for (const inv of invoices) {
    // Each invoice carries its own legal_country_code (set at issue time
    // and frozen by the GoBD immutability guard) — that determines the
    // applicable retention window, not the customer's current country.
    if (isWithinRetention(inv.legal_country_code, inv.created_at, now)) {
      blockingInvoiceIds.push(inv.id);
    }
  }

  if (blockingInvoiceIds.length > 0) {
    // Persist the refusal record FIRST (autocommit), then throw. The throw
    // surfaces the German reason on the typed RetentionViolation; the audit
    // row is the durable proof to a regulator that the request was received
    // and lawfully declined.
    await writeRefusalAuditRow(db, customerId, blockingInvoiceIds);
    throw retentionViolationError(RETENTION_REFUSAL_REASON);
  }

  // Permitted: anonymize. NOT-NULL `name` gets a constant placeholder,
  // every other PII column is set to NULL. Numerical / audit columns are
  // intentionally untouched.
  const setClauses = [
    "name = $1",
    ...PII_COLUMNS_TO_NULL.map((col) => `${col} = NULL`),
    "updated_at = CURRENT_TIMESTAMP",
  ].join(", ");
  await db.execute(`UPDATE customers SET ${setClauses} WHERE id = $2`, [
    ANONYMIZED_NAME,
    customerId,
  ]);

  return {
    customerId,
    invoiceCount: invoices.length,
  };
}

/**
 * Insert the refusal audit row. Encoded as a `customers` entity update so
 * the existing audit infrastructure (queries, exports, retention guard on
 * deleteAuditRow) handles it without a schema change. `op` is constrained
 * to ('insert','update','delete') by migration 0017's CHECK clause; we use
 * 'update' because the refused operation would have been an UPDATE if it
 * had been allowed, and the row remains in place.
 *
 * `fields_diff` carries:
 *   - reason: the canonical German refusal text
 *   - blocked_by_invoice_ids: every invoice id whose age forced the refusal
 *
 * `ts_unix_us` matches the convention DAT-4.b's triggers use so the audit
 * row sorts naturally with the rest of the timeline.
 */
async function writeRefusalAuditRow(
  db: { execute: (sql: string, params?: unknown[]) => Promise<unknown> },
  customerId: number,
  blockedByInvoiceIds: number[],
): Promise<void> {
  const fieldsDiff = JSON.stringify({
    reason: RETENTION_REFUSAL_REASON,
    blocked_by_invoice_ids: blockedByInvoiceIds,
  });
  const tsUnixUs = Date.now() * 1000;
  await db.execute(
    `INSERT INTO invoice_audit (entity_type, entity_id, op, ts_unix_us, fields_diff)
     VALUES ('customers', $1, 'update', $2, $3)`,
    [customerId, tsUnixUs, fieldsDiff],
  );
}
