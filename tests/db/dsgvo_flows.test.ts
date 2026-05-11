/**
 * COMP-2.c integration test — DSGVO Art. 15 (export) + Art. 17 (erasure)
 * combined flow.
 *
 * Walks the complete data-subject-rights loop end-to-end:
 *   1. Seed company / customer / invoices (mixed retention age, mixed
 *      status) / payments / extra audit history (delete + reassign).
 *   2. Export the customer's data via the production
 *      `exportCustomerData` (`src/lib/db/dsgvo_export.ts`, COMP-2.a) and
 *      assert the bundle covers everything the DB knows about the
 *      subject.
 *   3. Run an `anonymizeCustomer`-equivalent step that mirrors the PR
 *      #162 spec for COMP-2.b (per-invoice partition by retention age,
 *      customer-row blanking only when no invoice is in retention,
 *      refusal records appended to `invoice_audit`).
 *   4. Assert the post-erasure DB still satisfies every FK constraint
 *      (`PRAGMA foreign_key_check`) and that every `invoice_audit` row
 *      that references the customer (directly or via
 *      `fields_diff.customer_id`) still resolves — i.e. no orphaned
 *      audit history.
 *
 * The erasure logic is reproduced inline (not imported from the COMP-2.b
 * branch) so this test PR is independent of #162's merge order. The
 * inline `anonymizeCustomerForTest` is faithful to PR #162's spec —
 * when that PR lands, it can be swapped for the production import in a
 * one-line change without altering the assertions.
 */

import { test, expect, describe } from "bun:test";
import "./setup";
import { testDb } from "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as payments from "../../src/lib/db/payments";
import {
  exportCustomerData,
  collectCustomerData,
} from "../../src/lib/db/dsgvo_export";
import { withTransaction } from "../../src/lib/db/connection";
import type { Customer, Invoice } from "../../src/lib/db/types";

import JSZip from "jszip";

const ANONYMIZED_LABEL = "Anonymisiert";
const RETENTION_REASON =
  "§147 AO 10-Jahres-Aufbewahrung — Löschung vor Ablauf der Aufbewahrungsfrist nicht zulässig";
const RETENTION_YEARS_DE = 10;

interface InvoiceAnonymizationOutcome {
  invoice_id: number;
  invoice_number: string;
  status: string;
  outcome: "anonymized" | "skipped_immutable" | "refused";
  reason: string | null;
}

interface CustomerAnonymizationResult {
  customer_id: number;
  customer_anonymized: boolean;
  customer_refusal_reason: string | null;
  invoices: InvoiceAnonymizationOutcome[];
}

/**
 * In-test stand-in for `anonymizeCustomer` from PR #162. Faithful to the
 * spec: per-invoice partition by §147 AO retention; aged-out drafts get
 * recipient_* blanked; aged-out non-drafts are reported as
 * `skipped_immutable`; in-window invoices get a refusal audit row. The
 * customer row is anonymized only when no invoice remains in retention.
 *
 * Uses the `getDb()`-backed `withTransaction` so the entire run is
 * atomic (matching the production guarantee).
 */
async function anonymizeCustomerForTest(
  customerId: number,
  now: Date = new Date(),
): Promise<CustomerAnonymizationResult> {
  return await withTransaction(async (db) => {
    const customerRows = await db.select<Customer[]>(
      "SELECT * FROM customers WHERE id = $1",
      [customerId],
    );
    const customer = customerRows[0];
    if (!customer) throw new Error(`Customer ${customerId} not found`);

    const invs = await db.select<Invoice[]>(
      "SELECT * FROM invoices WHERE customer_id = $1 ORDER BY id",
      [customerId],
    );

    const tsUs = Math.floor(now.getTime() * 1000);
    const outcomes: InvoiceAnonymizationOutcome[] = [];

    for (const inv of invs) {
      const inWindow = isWithinRetentionDe(inv.created_at, now);

      if (inWindow) {
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
        outcomes.push({
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          status: inv.status,
          outcome: "skipped_immutable",
          reason: null,
        });
        continue;
      }

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
            },
            after: {
              name: ANONYMIZED_LABEL,
              customer_number: null,
              email: null,
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

function refusalFieldsDiff(
  reason: string,
  scope: "customer" | "invoice",
  scopeId: number,
): string {
  return JSON.stringify({
    anonymize_refused: {
      before: null,
      after: { reason, scope, scope_id: scopeId },
    },
  });
}

/**
 * Mirrors `isWithinRetention('DE', ...)` from PR #148: uses 365.25 days
 * per year and the SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) timestamp shape.
 */
function isWithinRetentionDe(createdAt: string, now: Date): boolean {
  const iso = createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const created = new Date(withZ);
  if (Number.isNaN(created.getTime())) return true; // fail closed
  const ageMs = now.getTime() - created.getTime();
  const retentionMs = RETENTION_YEARS_DE * 365.25 * 24 * 60 * 60 * 1000;
  return ageMs < retentionMs;
}

let counter = 0;

async function seedCompany(): Promise<number> {
  counter++;
  return companies.createCompany({
    name: `Co-${counter}`,
    legal_name: null,
    street: null,
    postal_code: null,
    city: null,
    country_code: "DE",
    tax_number: null,
    vat_id: null,
    bank_account_holder: null,
    bank_iban: null,
    bank_bic: null,
    bank_name: null,
  });
}

async function seedCustomer(companyId: number): Promise<number> {
  return customers.createCustomer({
    company_id: companyId,
    customer_number: "K-001",
    name: "Subject Person",
    contact_name: "Max Mustermann",
    email: "max@example.test",
    phone: "+49 30 12345",
    street: "Hauptstr. 1",
    postal_code: "10115",
    city: "Berlin",
    country_code: "DE",
    vat_id: "DE123456789",
    website: "example.test",
    type: "kunde",
  });
}

async function seedDraftInvoice(
  companyId: number,
  customerId: number,
  invoiceNumber: string,
): Promise<number> {
  return invoices.createInvoice({
    company_id: companyId,
    customer_id: customerId,
    project_id: null,
    invoice_number: invoiceNumber,
    status: "draft",
    issue_date: "2026-05-01",
    due_date: "2026-05-31",
    service_period_start: null,
    service_period_end: null,
    currency: "EUR",
    net_cents: 100000,
    tax_cents: 19000,
    gross_cents: 119000,
    issuer_name: null,
    issuer_tax_number: null,
    issuer_vat_id: null,
    issuer_bank_account_holder: null,
    issuer_bank_iban: null,
    issuer_bank_bic: null,
    issuer_bank_name: null,
    recipient_name: "Subject Person",
    recipient_street: "Hauptstr. 1",
    recipient_postal_code: "10115",
    recipient_city: "Berlin",
    recipient_country_code: "DE",
    delivery_date: null,
    due_surcharge: 0,
    language: "de",
    legal_country_code: "DE",
    notes: null,
    s3_key: null,
  });
}

/**
 * Push an invoice's `created_at` into the past so it is outside the
 * 10-year retention window. Bypasses the immutability trigger (which
 * doesn't fire on draft rows for `created_at` only) by going through
 * the raw connection.
 */
function ageInvoice(id: number, createdAt: string): void {
  testDb.raw.exec(
    `UPDATE invoices SET created_at = '${createdAt}' WHERE id = ${id}`,
  );
}

/**
 * Returns rows where the FK targets are missing. SQLite's
 * `PRAGMA foreign_key_check` reports zero rows when every FK resolves.
 */
function fkViolations(): unknown[] {
  return testDb.raw.query("PRAGMA foreign_key_check").all() as unknown[];
}

describe("COMP-2.c: DSGVO export + erasure flows", () => {
  test("export bundle covers customer + invoices + payments + audit before any erasure", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const invoiceId = await seedDraftInvoice(companyId, customerId, "INV-1");
    const paymentId = await payments.createPayment({
      invoice_id: invoiceId,
      payment_date: "2026-05-10",
      amount_cents: 50000,
      method: "bank_transfer",
      reference: "REF-1",
      note: null,
    });
    await invoices.updateInvoice(invoiceId, { notes: "After mutation" });

    const bundle = await collectCustomerData(customerId);
    expect(bundle.customer.id).toBe(customerId);
    expect(bundle.invoices.map((i) => i.id)).toEqual([invoiceId]);
    expect(bundle.payments.map((p) => p.id)).toEqual([paymentId]);
    const ops = bundle.auditEvents.map((a) => `${a.entity_type}:${a.op}`);
    expect(ops).toContain("invoices:insert");
    expect(ops).toContain("payments:insert");
    expect(ops).toContain("invoices:update");
  });

  test("erasure: aged-out drafts blanked, customer row anonymized, FK + audit invariants hold", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);

    // Two aged-out drafts (outside 10-year window) — both should be
    // recipient-blanked and the customer row should anonymize.
    const inv1 = await seedDraftInvoice(companyId, customerId, "INV-OLD-1");
    const inv2 = await seedDraftInvoice(companyId, customerId, "INV-OLD-2");
    ageInvoice(inv1, "2010-01-01 00:00:00");
    ageInvoice(inv2, "2011-06-15 12:34:56");

    // Pre-condition snapshot: bundle currently shows real PII.
    const before = await collectCustomerData(customerId);
    expect(before.customer.name).toBe("Subject Person");
    expect(before.invoices).toHaveLength(2);
    const beforeAuditCount = before.auditEvents.length;
    expect(beforeAuditCount).toBeGreaterThanOrEqual(2); // 2 inserts

    const result = await anonymizeCustomerForTest(
      customerId,
      new Date("2026-05-10T00:00:00Z"),
    );

    expect(result.customer_anonymized).toBe(true);
    expect(result.customer_refusal_reason).toBeNull();
    expect(result.invoices).toHaveLength(2);
    expect(result.invoices.every((o) => o.outcome === "anonymized")).toBe(true);

    // Customer row is anonymized in place (same id, same company_id).
    const after = await collectCustomerData(customerId);
    expect(after.customer.id).toBe(customerId);
    expect(after.customer.company_id).toBe(companyId);
    expect(after.customer.name).toBe(ANONYMIZED_LABEL);
    expect(after.customer.email).toBeNull();
    expect(after.customer.phone).toBeNull();
    expect(after.customer.street).toBeNull();
    expect(after.customer.vat_id).toBeNull();

    // Both invoices still reference the (now-anonymized) customer.
    for (const inv of after.invoices) {
      expect(inv.customer_id).toBe(customerId);
      expect(inv.recipient_name).toBe(ANONYMIZED_LABEL);
      expect(inv.recipient_street).toBeNull();
      expect(inv.recipient_postal_code).toBeNull();
      expect(inv.recipient_city).toBeNull();
      expect(inv.recipient_country_code).toBeNull();
    }

    // FK invariant: PRAGMA foreign_key_check must be empty.
    expect(fkViolations()).toHaveLength(0);

    // Audit invariant: every audit row that referenced the customer's
    // invoices is still resolvable — neither the invoices nor the
    // customer were deleted, so historical INSERT rows must still join.
    const ops = after.auditEvents.map((a) => `${a.entity_type}:${a.op}`);
    expect(ops).toContain("invoices:insert"); // pre-erasure history preserved
    // Erasure produced UPDATE rows on the invoices (recipient_* blank).
    const updateRows = after.auditEvents.filter(
      (a) => a.entity_type === "invoices" && a.op === "update",
    );
    expect(updateRows.length).toBeGreaterThanOrEqual(2);

    // Audit row count strictly grew — nothing was lost or rewritten.
    expect(after.auditEvents.length).toBeGreaterThan(beforeAuditCount);

    // The completion audit row is on `customers` (not surfaced by
    // collectCustomerData, which scans `invoices`-keyed audit) — verify
    // directly via the test DB.
    const completionRows = testDb.raw
      .query(
        `SELECT * FROM invoice_audit
          WHERE entity_type = 'customers'
            AND entity_id = ${customerId}
            AND actor = 'dsgvo_anonymize'`,
      )
      .all() as Array<{ fields_diff: string }>;
    expect(completionRows).toHaveLength(1);
    expect(completionRows[0].fields_diff).toContain("anonymize_completed");
  });

  test("erasure refuses while ANY invoice is in retention; customer row preserved + refusal audited", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);

    // Two invoices: one aged-out draft, one fresh draft (in retention).
    const oldInv = await seedDraftInvoice(companyId, customerId, "INV-OLD");
    const freshInv = await seedDraftInvoice(companyId, customerId, "INV-NEW");
    ageInvoice(oldInv, "2010-01-01 00:00:00");
    // freshInv keeps default created_at (now) — well inside retention.

    const result = await anonymizeCustomerForTest(
      customerId,
      new Date("2026-05-10T00:00:00Z"),
    );

    expect(result.customer_anonymized).toBe(false);
    expect(result.customer_refusal_reason).toBe(RETENTION_REASON);
    expect(result.invoices).toHaveLength(2);

    const byId = new Map(result.invoices.map((o) => [o.invoice_id, o]));
    expect(byId.get(oldInv)?.outcome).toBe("anonymized");
    expect(byId.get(freshInv)?.outcome).toBe("refused");
    expect(byId.get(freshInv)?.reason).toBe(RETENTION_REASON);

    // Customer row preserved (FK target for the in-retention invoice).
    const cust = await customers.getCustomerById(customerId);
    expect(cust?.name).toBe("Subject Person");
    expect(cust?.email).toBe("max@example.test");

    // The aged-out invoice was blanked.
    const oldRow = await invoices.getInvoiceById(oldInv);
    expect(oldRow?.recipient_name).toBe(ANONYMIZED_LABEL);
    expect(oldRow?.recipient_street).toBeNull();
    // The in-window invoice still carries its recipient_* PII.
    const freshRow = await invoices.getInvoiceById(freshInv);
    expect(freshRow?.recipient_name).toBe("Subject Person");
    expect(freshRow?.recipient_street).toBe("Hauptstr. 1");

    // FK invariant: still clean.
    expect(fkViolations()).toHaveLength(0);

    // Audit invariant: a refusal row exists for the in-retention
    // invoice AND a customer-level refusal row exists.
    const invRefusal = testDb.raw
      .query(
        `SELECT fields_diff FROM invoice_audit
          WHERE entity_type = 'invoices'
            AND entity_id = ${freshInv}
            AND actor = 'dsgvo_anonymize'`,
      )
      .all() as Array<{ fields_diff: string }>;
    expect(invRefusal).toHaveLength(1);
    expect(invRefusal[0].fields_diff).toContain("anonymize_refused");
    expect(invRefusal[0].fields_diff).toContain("§147 AO");

    const custRefusal = testDb.raw
      .query(
        `SELECT fields_diff FROM invoice_audit
          WHERE entity_type = 'customers'
            AND entity_id = ${customerId}
            AND actor = 'dsgvo_anonymize'`,
      )
      .all() as Array<{ fields_diff: string }>;
    expect(custRefusal).toHaveLength(1);
    expect(custRefusal[0].fields_diff).toContain("anonymize_refused");
  });

  test("export ZIP after erasure still produces a valid bundle (FK + audit chain intact)", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);

    // Mixed: aged-out draft (will be blanked), aged-out issued
    // (skipped_immutable), in-retention draft (refused).
    const oldDraftId = await seedDraftInvoice(
      companyId,
      customerId,
      "INV-OLD-DRAFT",
    );
    const oldIssuedId = await seedDraftInvoice(
      companyId,
      customerId,
      "INV-OLD-ISSUED",
    );
    const freshDraftId = await seedDraftInvoice(
      companyId,
      customerId,
      "INV-FRESH",
    );

    // Age FIRST (while still draft — immutability trigger doesn't fire
    // on drafts), THEN flip the second one to issued. Once issued,
    // DAT-2.a immutability blocks any further `created_at` UPDATE.
    ageInvoice(oldDraftId, "2010-01-01 00:00:00");
    ageInvoice(oldIssuedId, "2010-01-01 00:00:00");
    await invoices.updateInvoiceStatus(oldIssuedId, "draft", "sent");

    // A payment on the issued aged-out invoice — proves payments_audit
    // history survives erasure and is still in the export bundle.
    await payments.createPayment({
      invoice_id: oldIssuedId,
      payment_date: "2010-02-01",
      amount_cents: 119000,
      method: "bank_transfer",
      reference: "REF-OLD",
      note: null,
    });

    const result = await anonymizeCustomerForTest(
      customerId,
      new Date("2026-05-10T00:00:00Z"),
    );

    // Expected partition.
    const byId = new Map(result.invoices.map((o) => [o.invoice_id, o]));
    expect(byId.get(oldDraftId)?.outcome).toBe("anonymized");
    expect(byId.get(oldIssuedId)?.outcome).toBe("skipped_immutable");
    expect(byId.get(freshDraftId)?.outcome).toBe("refused");
    expect(result.customer_anonymized).toBe(false); // freshDraft holds it back.

    // Post-erasure FK check.
    expect(fkViolations()).toHaveLength(0);

    // The export bundle must still produce a valid ZIP and reference
    // every invoice id (none were deleted).
    const bytes = await exportCustomerData(customerId);
    expect(bytes.length).toBeGreaterThan(0);
    const zip = await JSZip.loadAsync(bytes);

    const invoicesJson = JSON.parse(
      await zip.file("invoices.json")!.async("string"),
    ) as Array<{
      id: number;
      customer_id: number;
      recipient_name: string | null;
    }>;
    expect(invoicesJson.map((i) => i.id).sort((a, b) => a - b)).toEqual(
      [oldDraftId, oldIssuedId, freshDraftId].sort((a, b) => a - b),
    );
    // Every invoice still references the customer (no orphaning).
    expect(invoicesJson.every((i) => i.customer_id === customerId)).toBe(true);

    const auditJson = JSON.parse(
      await zip.file("audit_events.json")!.async("string"),
    ) as Array<{ entity_type: string; entity_id: number; op: string }>;
    // Audit rows for ALL three invoices' INSERTs survive.
    const insertEntityIds = auditJson
      .filter((a) => a.entity_type === "invoices" && a.op === "insert")
      .map((a) => a.entity_id);
    for (const id of [oldDraftId, oldIssuedId, freshDraftId]) {
      expect(insertEntityIds).toContain(id);
    }
    // Payment insert audit row survives.
    expect(
      auditJson.filter(
        (a) => a.entity_type === "payments" && a.op === "insert",
      ),
    ).toHaveLength(1);
  });

  test("audit rows for a previously-deleted invoice still link to the customer post-erasure", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);

    // One draft we will delete BEFORE erasure runs — its audit history
    // (insert + delete) carries fields_diff.customer_id pointing at the
    // subject. Per dsgvo_export.collectCustomerData, this is the
    // canonical way historical references survive.
    const deletedInv = await seedDraftInvoice(companyId, customerId, "INV-DEL");
    ageInvoice(deletedInv, "2010-01-01 00:00:00");
    await invoices.deleteInvoice(deletedInv);

    // Plus one aged-out draft that will be blanked + drive the customer
    // row anonymization.
    const liveInv = await seedDraftInvoice(companyId, customerId, "INV-LIVE");
    ageInvoice(liveInv, "2010-01-01 00:00:00");

    await anonymizeCustomerForTest(
      customerId,
      new Date("2026-05-10T00:00:00Z"),
    );

    expect(fkViolations()).toHaveLength(0);

    // collectCustomerData should still surface the deleted invoice's
    // audit history via fields_diff.customer_id, AND the customer row
    // still exists (anonymized) so the ids resolve cleanly.
    const bundle = await collectCustomerData(customerId);
    expect(bundle.customer.name).toBe(ANONYMIZED_LABEL);
    expect(bundle.invoices.map((i) => i.id)).toEqual([liveInv]);
    const deletedInvAudit = bundle.auditEvents.filter(
      (a) => a.entity_type === "invoices" && a.entity_id === deletedInv,
    );
    const ops = deletedInvAudit.map((a) => a.op);
    expect(ops).toContain("insert");
    expect(ops).toContain("delete");
  });
});
