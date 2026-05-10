/**
 * DSGVO (GDPR) Art. 17 — right to erasure ("right to be forgotten") with
 * the §147 AO bookkeeping retention exception encoded.
 *
 * Sister to `dsgvo_export.ts` (Art. 15 access). The two together close
 * the data-subject-rights loop the application owes every customer:
 * Auskunft (export) is non-destructive, Löschen (this file) is gated by
 * the GoBD retention guard from COMP-1.a (#90).
 *
 * Behaviour
 * ---------
 *
 * `anonymize_customer(customer_id)` walks every invoice that references
 * the customer and partitions them by retention status using the same
 * `isWithinRetention` helper that protects destructive deletes:
 *
 *   - For an invoice whose `created_at` is OUTSIDE the §147 AO 10-year
 *     retention window AND whose status is still `'draft'`, the
 *     `recipient_*` PII columns on that invoice are blanked. Issued /
 *     storno invoices are skipped at the column level — GoBD invoice
 *     immutability (DAT-2.a, migration 0020) forbids mutating their
 *     content even after retention. This is intentional: an issued,
 *     retention-expired invoice's recipient block was already part of
 *     the document delivered to the customer; the customer-level row
 *     blanking below is the substantive erasure.
 *
 *   - For an invoice INSIDE the retention window, no blanking occurs.
 *     Instead a refusal record is appended to `invoice_audit` so the
 *     refusal is itself part of the GoBD audit trail (auditors can see
 *     why the row still carries PII).
 *
 * The customer row itself (which is the data subject's primary record)
 * is anonymized only if NO invoice is still inside retention — keeping
 * the row intact while a retained invoice references it preserves the
 * recipient_* / customer linkage that GoBD expects. When some invoices
 * are still retained, only the per-invoice anonymization runs and the
 * customer row is left untouched.
 *
 * "Anonymization" means:
 *   - `name` -> 'Anonymisiert'
 *   - `customer_number, contact_name, email, phone, street, postal_code,
 *      city, vat_id, website` -> NULL
 *   - `country_code, type, company_id, id, created_at` are preserved —
 *     these are non-PII bookkeeping fields needed for FK + audit invariants.
 *
 * For invoices, blanking means:
 *   - `recipient_name` -> 'Anonymisiert'
 *   - `recipient_street, recipient_postal_code, recipient_city,
 *      recipient_country_code` -> NULL
 *   - everything else (money, dates, FK to customer, audit columns) is
 *     preserved.
 *
 * The function is transactional — either every permitted update lands or
 * none do. Refusal audit records are written within the same transaction
 * so a partially-failed run cannot leave a customer with an incomplete
 * paper trail.
 *
 * Legal note: This file encodes one interpretation of §147 AO + Art. 17
 * DSGVO. The retention-vs-erasure tension is sensitive — flag for legal
 * review (see PR #94 body).
 */

import { withTransaction } from "./connection";
import { isWithinRetention } from "./retention";
import type { Customer, Invoice } from "./types";

/**
 * Per-invoice outcome of an anonymization run. Returned to the caller so
 * the UI can render a "x of y invoices anonymized, z refused" summary.
 */
export interface InvoiceAnonymizationOutcome {
  invoice_id: number;
  invoice_number: string;
  status: string;
  /** 'anonymized' = recipient_* blanked; 'skipped_immutable' = aged-out
   * but issued (immutability prevents column-level edit); 'refused' =
   * still inside retention window. */
  outcome: "anonymized" | "skipped_immutable" | "refused";
  /** Populated only when `outcome === 'refused'`. German user-facing reason. */
  reason: string | null;
}

export interface CustomerAnonymizationResult {
  customer_id: number;
  /** True if the customer ROW itself was anonymized. False when at least
   * one invoice is still inside retention. */
  customer_anonymized: boolean;
  /** When `customer_anonymized` is false, the German reason. NULL otherwise. */
  customer_refusal_reason: string | null;
  /** Per-invoice breakdown — useful for both the UI and tests. */
  invoices: InvoiceAnonymizationOutcome[];
}

const RETENTION_REASON =
  "§147 AO 10-Jahres-Aufbewahrung — Löschung vor Ablauf der Aufbewahrungsfrist nicht zulässig";

const ANONYMIZED_LABEL = "Anonymisiert";

/**
 * The unix-microseconds timestamp the audit trigger column expects
 * (mirrors `CAST(unixepoch('subsec') * 1000000 AS INTEGER)` from the
 * SQL triggers in migration 0019).
 */
function nowUnixMicros(now: Date = new Date()): number {
  return Math.floor(now.getTime() * 1000);
}

/**
 * Build the JSON payload for a refusal audit row. Top-level keys mirror
 * the `{ field: { before, after } }` shape the audit triggers produce so
 * downstream tooling can parse refusal rows with the same JSON walker —
 * we just use a synthetic `anonymize_refused` field.
 */
function refusalFieldsDiff(
  reason: string,
  scope: "customer" | "invoice",
  scopeId: number,
): string {
  return JSON.stringify({
    anonymize_refused: {
      before: null,
      after: {
        reason,
        scope,
        scope_id: scopeId,
      },
    },
  });
}

/**
 * Anonymize PII for a single customer subject to the §147 AO retention
 * exception. Returns a structured result describing exactly which rows
 * were touched and which were refused. Never throws on retention — the
 * refusal is reflected in the result and a written record is appended
 * to `invoice_audit`. Throws on missing customer or unrecoverable DB
 * errors.
 *
 * `now` is injectable so tests can pin "today" without time-warping the
 * suite. Production callers should omit it.
 */
export async function anonymizeCustomer(
  customerId: number,
  now: Date = new Date(),
): Promise<CustomerAnonymizationResult> {
  return await withTransaction(async (db) => {
    const customerRows = await db.select<Customer[]>(
      "SELECT * FROM customers WHERE id = $1",
      [customerId],
    );
    const customer = customerRows[0];
    if (!customer) {
      throw new Error(`Customer ${customerId} not found`);
    }

    // Pull every invoice that currently references the customer. Audit-
    // only / historical references (handled by `dsgvo_export.collectCustomerData`
    // via fields_diff) are intentionally NOT touched — those rows are
    // already detached, and their `recipient_*` columns may belong to a
    // *different* customer that the invoice was reassigned to.
    const invoices = await db.select<Invoice[]>(
      "SELECT * FROM invoices WHERE customer_id = $1 ORDER BY id",
      [customerId],
    );

    const outcomes: InvoiceAnonymizationOutcome[] = [];
    const tsUs = nowUnixMicros(now);

    for (const inv of invoices) {
      const inWindow = isWithinRetention(
        inv.legal_country_code,
        inv.created_at,
        now,
      );

      if (inWindow) {
        // Refusal: record into invoice_audit so the audit trail shows
        // *why* the recipient_* fields were not blanked. Op = 'update'
        // because the table CHECK constraint restricts op to
        // ('insert','update','delete') — the refusal nature is encoded
        // in fields_diff.anonymize_refused. entity_type = 'invoices'
        // and entity_id = inv.id keeps the row joinable to the invoice.
        await db.execute(
          `INSERT INTO invoice_audit (entity_type, entity_id, op, actor, ts_unix_us, fields_diff)
           VALUES ('invoices', $1, 'update', 'dsgvo_anonymize', $2, $3)`,
          [
            inv.id,
            tsUs,
            refusalFieldsDiff(RETENTION_REASON, "invoice", inv.id),
          ],
        );
        outcomes.push({
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          status: inv.status,
          outcome: "refused",
          reason: RETENTION_REASON,
        });
        continue;
      }

      if (inv.status !== "draft") {
        // Aged-out but issued/storno: GoBD immutability forbids editing
        // the recipient_* block at the column level. The customer-level
        // row anonymization (below) is the substantive erasure for this
        // data subject; the issued document's snapshot is intentionally
        // preserved as the bookkeeping record.
        outcomes.push({
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          status: inv.status,
          outcome: "skipped_immutable",
          reason: null,
        });
        continue;
      }

      // Aged-out + draft: blank recipient_* PII. We deliberately keep
      // recipient_country_code as some downstream legal flows key off
      // it (e.g. reverse-charge label rendering). Set country_code to
      // NULL too to ensure no PII remains — the country is not PII per
      // se but it is part of the recipient address block.
      await db.execute(
        `UPDATE invoices
            SET recipient_name         = $1,
                recipient_street       = NULL,
                recipient_postal_code  = NULL,
                recipient_city         = NULL,
                recipient_country_code = NULL,
                updated_at             = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [ANONYMIZED_LABEL, inv.id],
      );
      outcomes.push({
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        status: inv.status,
        outcome: "anonymized",
        reason: null,
      });
    }

    const anyRefused = outcomes.some((o) => o.outcome === "refused");

    if (anyRefused) {
      // Customer row stays. Record a refusal at the customer level so
      // the audit trail surfaces a single "anonymization attempted but
      // refused" event without callers having to walk every invoice row.
      await db.execute(
        `INSERT INTO invoice_audit (entity_type, entity_id, op, actor, ts_unix_us, fields_diff)
         VALUES ('customers', $1, 'update', 'dsgvo_anonymize', $2, $3)`,
        [
          customerId,
          tsUs,
          refusalFieldsDiff(RETENTION_REASON, "customer", customerId),
        ],
      );
      return {
        customer_id: customerId,
        customer_anonymized: false,
        customer_refusal_reason: RETENTION_REASON,
        invoices: outcomes,
      };
    }

    // No invoices remain inside retention — anonymize the customer row.
    // company_id, country_code, type, id, created_at are preserved
    // (non-PII / FK-relevant bookkeeping columns). updated_at is bumped
    // so audit views show when the anonymization happened.
    await db.execute(
      `UPDATE customers
          SET name           = $1,
              customer_number = NULL,
              contact_name   = NULL,
              email          = NULL,
              phone          = NULL,
              street         = NULL,
              postal_code    = NULL,
              city           = NULL,
              vat_id         = NULL,
              website        = NULL,
              updated_at     = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [ANONYMIZED_LABEL, customerId],
    );

    // Write a positive audit record for the customer-level anonymization
    // so external auditors can see the operation happened (the customer
    // table has no triggers — DAT-4.b only audits the booking-relevant
    // tables).
    await db.execute(
      `INSERT INTO invoice_audit (entity_type, entity_id, op, actor, ts_unix_us, fields_diff)
       VALUES ('customers', $1, 'update', 'dsgvo_anonymize', $2, $3)`,
      [
        customerId,
        tsUs,
        JSON.stringify({
          anonymize_completed: {
            before: {
              name: customer.name,
              customer_number: customer.customer_number,
              email: customer.email,
              phone: customer.phone,
            },
            after: {
              name: ANONYMIZED_LABEL,
              customer_number: null,
              email: null,
              phone: null,
            },
          },
        }),
      ],
    );

    return {
      customer_id: customerId,
      customer_anonymized: true,
      customer_refusal_reason: null,
      invoices: outcomes,
    };
  });
}
