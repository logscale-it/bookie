import { test, expect, describe } from "bun:test";
import "./setup";
import { testDb } from "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as payments from "../../src/lib/db/payments";
import * as audit from "../../src/lib/db/audit";
import {
  isWithinRetention,
  assertOutsideRetention,
} from "../../src/lib/db/retention";

let counter = 0;
async function seedDraftInvoice(): Promise<{
  companyId: number;
  customerId: number;
  invId: number;
}> {
  counter++;
  const companyId = await companies.createCompany({
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
  const customerId = await customers.createCustomer({
    company_id: companyId,
    customer_number: null,
    name: "Cu",
    contact_name: null,
    email: null,
    phone: null,
    street: null,
    postal_code: null,
    city: null,
    country_code: "DE",
    vat_id: null,
    website: null,
    type: "kunde",
  });
  const invId = await invoices.createInvoice({
    company_id: companyId,
    customer_id: customerId,
    project_id: null,
    invoice_number: `RET-${counter}`,
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
    recipient_name: null,
    recipient_street: null,
    recipient_postal_code: null,
    recipient_city: null,
    recipient_country_code: null,
    delivery_date: null,
    due_surcharge: 0,
    language: "de",
    legal_country_code: "DE",
    notes: null,
    s3_key: null,
  });
  return { companyId, customerId, invId };
}

/**
 * Push a row's `created_at` into the past by directly updating the SQLite
 * row. Bypasses the audit triggers (which only fire on the listed tables)
 * and the application-level guards — this is the test-only escape hatch
 * that lets us simulate a row that has aged out of the retention window
 * without waiting 11 years.
 */
function ageRow(
  table: string,
  id: number,
  createdAt: string,
): void {
  testDb.raw.exec(
    `UPDATE ${table} SET created_at = '${createdAt}' WHERE id = ${id}`,
  );
}

describe("COMP-1.a: retention helper", () => {
  test("isWithinRetention: today is within window", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    expect(isWithinRetention("DE", "2026-05-10 00:00:00", now)).toBe(true);
  });

  test("isWithinRetention: 11 years ago is outside window", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    expect(isWithinRetention("DE", "2015-05-10 00:00:00", now)).toBe(false);
  });

  test("isWithinRetention: unknown country falls back to DE (10y)", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    expect(isWithinRetention("XX", "2020-01-01 00:00:00", now)).toBe(true);
    expect(isWithinRetention("XX", "2010-01-01 00:00:00", now)).toBe(false);
  });

  test("assertOutsideRetention: throws RetentionViolation inside window", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    let thrown: Error | undefined;
    try {
      assertOutsideRetention("Zahlung", "DE", "2026-05-09 12:00:00", now);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("RetentionViolation");
    expect(thrown!.message).toContain("10 Jahren");
  });

  test("assertOutsideRetention: no-op outside window", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    expect(() =>
      assertOutsideRetention("Zahlung", "DE", "2010-01-01 00:00:00", now),
    ).not.toThrow();
  });

  test("malformed timestamp fails closed (treated as inside window)", () => {
    expect(isWithinRetention("DE", "not-a-date")).toBe(true);
  });
});

describe("COMP-1.a: deletePayment retention guard", () => {
  test("rejects delete of a payment created today", async () => {
    const { invId } = await seedDraftInvoice();
    const payId = await payments.createPayment({
      invoice_id: invId,
      payment_date: "2026-05-10",
      amount_cents: 50000,
      method: null,
      reference: null,
      note: null,
    });

    let thrown: Error | undefined;
    try {
      await payments.deletePayment(payId);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("RetentionViolation");
    expect(thrown!.message).toContain("Aufbewahrungsfrist");

    // Row must still exist.
    const still = await testDb.select<{ id: number }[]>(
      "SELECT id FROM payments WHERE id = $1",
      [payId],
    );
    expect(still).toHaveLength(1);
  });

  test("permits delete after backdating created_at past the window", async () => {
    const { invId } = await seedDraftInvoice();
    const payId = await payments.createPayment({
      invoice_id: invId,
      payment_date: "2015-05-10",
      amount_cents: 50000,
      method: null,
      reference: null,
      note: null,
    });
    ageRow("payments", payId, "2010-01-01 00:00:00");

    await payments.deletePayment(payId); // must not throw

    const still = await testDb.select<{ id: number }[]>(
      "SELECT id FROM payments WHERE id = $1",
      [payId],
    );
    expect(still).toHaveLength(0);
  });

  test("missing-id delete is a no-op (does not throw)", async () => {
    await payments.deletePayment(99999); // no row, no guard, no throw
  });
});

describe("COMP-1.a: deleteInvoice retention guard", () => {
  test("rejects delete of a draft invoice created today", async () => {
    const { invId } = await seedDraftInvoice();

    let thrown: Error | undefined;
    try {
      await invoices.deleteInvoice(invId);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("RetentionViolation");

    // Row must still exist.
    expect(await invoices.getInvoiceById(invId)).toBeDefined();
  });

  test("permits delete of a draft invoice once aged past the window", async () => {
    const { invId } = await seedDraftInvoice();
    ageRow("invoices", invId, "2010-01-01 00:00:00");

    await invoices.deleteInvoice(invId); // must not throw
    expect(await invoices.getInvoiceById(invId)).toBeUndefined();
  });

  test("InvoiceImmutable still wins over RetentionViolation for non-drafts", async () => {
    // An issued invoice that is also inside the retention window should
    // surface the more specific InvoiceImmutable failure mode — the UI
    // already knows how to render that one.
    const { invId } = await seedDraftInvoice();
    await invoices.updateInvoiceStatus(invId, "draft", "issued");

    let thrown: Error | undefined;
    try {
      await invoices.deleteInvoice(invId);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("InvoiceImmutable");
  });
});

describe("COMP-1.a: deleteAuditRow retention guard", () => {
  test("rejects delete of a fresh audit row", async () => {
    const { invId } = await seedDraftInvoice();
    // Creating the invoice already produced an `invoices_audit_insert` row.
    const rows = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE entity_type = 'invoices' AND entity_id = $1",
      [invId],
    );
    expect(rows.length).toBeGreaterThan(0);
    const auditId = rows[0].id;

    let thrown: Error | undefined;
    try {
      await audit.deleteAuditRow(auditId);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("RetentionViolation");

    const still = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE id = $1",
      [auditId],
    );
    expect(still).toHaveLength(1);
  });

  test("permits delete after backdating ts_unix_us past the window", async () => {
    const { invId } = await seedDraftInvoice();
    const rows = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE entity_type = 'invoices' AND entity_id = $1",
      [invId],
    );
    const auditId = rows[0].id;
    // 11 years ago, in microseconds since the Unix epoch.
    const elevenYearsAgoUs = (Date.now() - 11 * 365.25 * 24 * 3600 * 1000) * 1000;
    testDb.raw.exec(
      `UPDATE invoice_audit SET ts_unix_us = ${Math.floor(elevenYearsAgoUs)} WHERE id = ${auditId}`,
    );

    await audit.deleteAuditRow(auditId); // must not throw

    const still = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE id = $1",
      [auditId],
    );
    expect(still).toHaveLength(0);
  });

  test("missing-id audit delete is a no-op", async () => {
    await audit.deleteAuditRow(99999); // no row, no guard, no throw
  });
});
