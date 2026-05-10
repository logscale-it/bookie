import { test, expect, describe } from "bun:test";
import "./setup";
import { testDb } from "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as payments from "../../src/lib/db/payments";
import { anonymizeCustomer } from "../../src/lib/db/dsgvo_erasure";
import type { Customer, Invoice } from "../../src/lib/db/types";

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
 * 10-year retention window. Bypasses the immutability trigger for issued
 * invoices by addressing only `created_at` (which is excluded from the
 * trigger's change list when status is draft, and we keep status draft
 * unless the test wants otherwise).
 */
function ageInvoice(id: number, createdAt: string): void {
  testDb.raw.exec(
    `UPDATE invoices SET created_at = '${createdAt}' WHERE id = ${id}`,
  );
}

describe("COMP-2.b: anonymizeCustomer — no invoices", () => {
  test("anonymizes the customer row when there are no invoices at all", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);

    const result = await anonymizeCustomer(customerId);

    expect(result.customer_anonymized).toBe(true);
    expect(result.customer_refusal_reason).toBeNull();
    expect(result.invoices).toEqual([]);

    const after = await customers.getCustomerById(customerId);
    expect(after?.name).toBe("Anonymisiert");
    expect(after?.email).toBeNull();
    expect(after?.phone).toBeNull();
    expect(after?.street).toBeNull();
    expect(after?.postal_code).toBeNull();
    expect(after?.city).toBeNull();
    expect(after?.vat_id).toBeNull();
    expect(after?.website).toBeNull();
    expect(after?.contact_name).toBeNull();
    expect(after?.customer_number).toBeNull();
    // Non-PII bookkeeping columns preserved
    expect(after?.id).toBe(customerId);
    expect(after?.company_id).toBe(companyId);
    expect(after?.country_code).toBe("DE");
    expect(after?.type).toBe("kunde");
  });

  test("writes a positive audit row on completed customer anonymization", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);

    await anonymizeCustomer(customerId);

    const audits = await testDb.select<
      {
        entity_type: string;
        entity_id: number;
        op: string;
        actor: string | null;
        fields_diff: string;
      }[]
    >(
      `SELECT entity_type, entity_id, op, actor, fields_diff
         FROM invoice_audit
        WHERE entity_type = 'customers' AND entity_id = $1`,
      [customerId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].op).toBe("update");
    expect(audits[0].actor).toBe("dsgvo_anonymize");
    const diff = JSON.parse(audits[0].fields_diff);
    expect(diff.anonymize_completed).toBeDefined();
    expect(diff.anonymize_completed.before.name).toBe("Subject Person");
    expect(diff.anonymize_completed.after.name).toBe("Anonymisiert");
  });
});

describe("COMP-2.b: anonymizeCustomer — all invoices outside retention", () => {
  test("anonymizes customer + blanks recipient_* on aged-out drafts", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const invId = await seedDraftInvoice(companyId, customerId, "INV-OLD-1");

    // Age the invoice past the 10-year window.
    ageInvoice(invId, "2010-01-01 00:00:00");

    const result = await anonymizeCustomer(customerId);

    expect(result.customer_anonymized).toBe(true);
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].outcome).toBe("anonymized");
    expect(result.invoices[0].invoice_id).toBe(invId);
    expect(result.invoices[0].reason).toBeNull();

    const inv = await invoices.getInvoiceById(invId);
    expect(inv?.recipient_name).toBe("Anonymisiert");
    expect(inv?.recipient_street).toBeNull();
    expect(inv?.recipient_postal_code).toBeNull();
    expect(inv?.recipient_city).toBeNull();
    expect(inv?.recipient_country_code).toBeNull();
    // Money + audit columns preserved.
    expect(inv?.net_cents).toBe(100000);
    expect(inv?.tax_cents).toBe(19000);
    expect(inv?.gross_cents).toBe(119000);
    expect(inv?.invoice_number).toBe("INV-OLD-1");
    expect(inv?.customer_id).toBe(customerId);

    // Customer row is blanked.
    const cust = await customers.getCustomerById(customerId);
    expect(cust?.name).toBe("Anonymisiert");
    expect(cust?.email).toBeNull();
  });

  test("aged-out issued invoice is reported as skipped_immutable", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const invId = await seedDraftInvoice(
      companyId,
      customerId,
      "INV-ISSUED-OLD",
    );

    // Order matters: the immutability trigger blocks `created_at` edits
    // once status leaves 'draft', so we age the row first and only then
    // promote it to 'issued'.
    ageInvoice(invId, "2010-01-01 00:00:00");
    await invoices.updateInvoiceStatus(invId, "draft", "issued");

    const result = await anonymizeCustomer(customerId);

    expect(result.customer_anonymized).toBe(true);
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].outcome).toBe("skipped_immutable");

    // Recipient_* must NOT have been touched (immutability trigger would
    // have aborted the transaction anyway — this is the belt-and-braces
    // assertion).
    const inv = await invoices.getInvoiceById(invId);
    expect(inv?.recipient_name).toBe("Subject Person");
    expect(inv?.recipient_street).toBe("Hauptstr. 1");

    // Customer row IS blanked because no invoice is in retention.
    const cust = await customers.getCustomerById(customerId);
    expect(cust?.name).toBe("Anonymisiert");
  });
});

describe("COMP-2.b: anonymizeCustomer — invoices inside retention", () => {
  test("refuses customer-level anonymization when any invoice is in retention", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const invId = await seedDraftInvoice(companyId, customerId, "INV-NEW-1");
    // Default `created_at` is CURRENT_TIMESTAMP — within the 10-year window.

    const result = await anonymizeCustomer(customerId);

    expect(result.customer_anonymized).toBe(false);
    expect(result.customer_refusal_reason).toContain("§147 AO");
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].outcome).toBe("refused");
    expect(result.invoices[0].reason).toContain("§147 AO");

    // Customer row PII must still be intact.
    const cust = await customers.getCustomerById(customerId);
    expect(cust?.name).toBe("Subject Person");
    expect(cust?.email).toBe("max@example.test");
    expect(cust?.street).toBe("Hauptstr. 1");

    // Invoice's recipient_* must still be intact.
    const inv = await invoices.getInvoiceById(invId);
    expect(inv?.recipient_name).toBe("Subject Person");
  });

  test("writes a refusal audit row per refused invoice + one customer-level row", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const invId = await seedDraftInvoice(companyId, customerId, "INV-NEW-2");

    await anonymizeCustomer(customerId);

    const invoiceRefusals = await testDb.select<
      {
        entity_id: number;
        op: string;
        actor: string | null;
        fields_diff: string;
      }[]
    >(
      `SELECT entity_id, op, actor, fields_diff
         FROM invoice_audit
        WHERE entity_type = 'invoices'
          AND entity_id = $1
          AND actor = 'dsgvo_anonymize'`,
      [invId],
    );
    expect(invoiceRefusals).toHaveLength(1);
    expect(invoiceRefusals[0].op).toBe("update");
    const invDiff = JSON.parse(invoiceRefusals[0].fields_diff);
    expect(invDiff.anonymize_refused).toBeDefined();
    expect(invDiff.anonymize_refused.after.reason).toContain("§147 AO");
    expect(invDiff.anonymize_refused.after.scope).toBe("invoice");

    const customerRefusals = await testDb.select<
      { entity_id: number; fields_diff: string }[]
    >(
      `SELECT entity_id, fields_diff
         FROM invoice_audit
        WHERE entity_type = 'customers'
          AND entity_id = $1
          AND actor = 'dsgvo_anonymize'`,
      [customerId],
    );
    expect(customerRefusals).toHaveLength(1);
    const custDiff = JSON.parse(customerRefusals[0].fields_diff);
    expect(custDiff.anonymize_refused).toBeDefined();
    expect(custDiff.anonymize_refused.after.scope).toBe("customer");
  });
});

describe("COMP-2.b: anonymizeCustomer — mixed-age invoices (verification recipe)", () => {
  test("anonymizes old invoices, refuses new ones, customer row preserved", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);

    // Old invoice — pre-window.
    const oldId = await seedDraftInvoice(companyId, customerId, "INV-OLD");
    ageInvoice(oldId, "2010-01-01 00:00:00");

    // New invoice — within window (default created_at).
    const newId = await seedDraftInvoice(companyId, customerId, "INV-NEW");

    const result = await anonymizeCustomer(customerId);

    expect(result.invoices).toHaveLength(2);

    const byId = new Map(result.invoices.map((o) => [o.invoice_id, o]));
    expect(byId.get(oldId)?.outcome).toBe("anonymized");
    expect(byId.get(newId)?.outcome).toBe("refused");

    // Customer row is NOT blanked because at least one invoice is in retention.
    expect(result.customer_anonymized).toBe(false);
    const cust = await customers.getCustomerById(customerId);
    expect(cust?.name).toBe("Subject Person");

    // Old invoice's recipient_* is blanked.
    const oldInv = await invoices.getInvoiceById(oldId);
    expect(oldInv?.recipient_name).toBe("Anonymisiert");
    expect(oldInv?.recipient_street).toBeNull();

    // New invoice's recipient_* is intact.
    const newInv = await invoices.getInvoiceById(newId);
    expect(newInv?.recipient_name).toBe("Subject Person");
    expect(newInv?.recipient_street).toBe("Hauptstr. 1");

    // FK invariants: every invoice still references the (intact) customer.
    expect(oldInv?.customer_id).toBe(customerId);
    expect(newInv?.customer_id).toBe(customerId);

    // No orphaned invoices.
    const orphans = await testDb.select<{ id: number }[]>(
      `SELECT id FROM invoices WHERE customer_id NOT IN (SELECT id FROM customers)`,
    );
    expect(orphans).toEqual([]);
  });

  test("audit trail invariants hold: every invoice still has its insert audit row", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const oldId = await seedDraftInvoice(companyId, customerId, "INV-OLD-A");
    const newId = await seedDraftInvoice(companyId, customerId, "INV-NEW-A");
    ageInvoice(oldId, "2010-01-01 00:00:00");

    await anonymizeCustomer(customerId);

    for (const id of [oldId, newId]) {
      const inserts = await testDb.select<{ id: number }[]>(
        `SELECT id FROM invoice_audit
          WHERE entity_type = 'invoices' AND entity_id = $1 AND op = 'insert'`,
        [id],
      );
      expect(inserts.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("payments attached to retained invoices are untouched", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const newId = await seedDraftInvoice(companyId, customerId, "INV-PAY");
    const payId = await payments.createPayment({
      invoice_id: newId,
      payment_date: "2026-05-10",
      amount_cents: 50000,
      method: "bank_transfer",
      reference: "REF-1",
      note: "Anzahlung",
    });

    await anonymizeCustomer(customerId);

    const pays = await testDb.select<
      { id: number; amount_cents: number; reference: string | null }[]
    >("SELECT id, amount_cents, reference FROM payments WHERE id = $1", [
      payId,
    ]);
    expect(pays).toHaveLength(1);
    expect(pays[0].amount_cents).toBe(50000);
    expect(pays[0].reference).toBe("REF-1");
  });
});

describe("COMP-2.b: anonymizeCustomer — error paths", () => {
  test("throws on unknown customer id", async () => {
    await expect(anonymizeCustomer(99999)).rejects.toThrow(
      /Customer 99999 not found/,
    );
  });

  test("idempotent: a second run on an already-anonymized customer is a no-op-style success", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);

    const first = await anonymizeCustomer(customerId);
    expect(first.customer_anonymized).toBe(true);

    // Second run should still succeed (no invoices, name already
    // 'Anonymisiert' — the UPDATE is harmless and the audit table gets
    // a second row, which is the right semantic for a re-issued request).
    const second = await anonymizeCustomer(customerId);
    expect(second.customer_anonymized).toBe(true);

    const cust = await customers.getCustomerById(customerId);
    expect(cust?.name).toBe("Anonymisiert");

    // Two audit rows now exist (one per call) — the audit trail is
    // append-only so both are preserved.
    const audits = await testDb.select<{ id: number }[]>(
      `SELECT id FROM invoice_audit WHERE entity_type = 'customers' AND entity_id = $1`,
      [customerId],
    );
    expect(audits.length).toBe(2);
  });

  test("returned Invoice shape matches DB invariants for refused rows", async () => {
    // Sanity: the per-invoice outcome carries enough info for the UI
    // (id, number, status, reason). Catches accidental shape drift.
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const invId = await seedDraftInvoice(companyId, customerId, "INV-SHAPE");
    const result = await anonymizeCustomer(customerId);
    const refused = result.invoices[0];
    expect(refused.invoice_id).toBe(invId);
    expect(refused.invoice_number).toBe("INV-SHAPE");
    expect(refused.status).toBe("draft");
    expect(refused.outcome).toBe("refused");
    expect(typeof refused.reason).toBe("string");
  });
});

describe("COMP-2.b: type signature sanity", () => {
  test("Customer / Invoice types still describe the post-anonymize rows", () => {
    // Compile-time-only check that the fields we touch exist on the
    // Customer / Invoice interfaces. Run-time assertion just keeps the
    // test structure consistent.
    const c: Partial<Customer> = {
      name: "Anonymisiert",
      email: null,
      vat_id: null,
    };
    const i: Partial<Invoice> = {
      recipient_name: "Anonymisiert",
      recipient_street: null,
    };
    expect(c.name).toBe("Anonymisiert");
    expect(i.recipient_name).toBe("Anonymisiert");
  });
});
