/// <reference types="bun" />
import { test, expect, describe } from "bun:test";
import "../../db/setup";
import { testDb } from "../../db/setup";

import * as companies from "../../../src/lib/db/companies";
import * as customers from "../../../src/lib/db/customers";
import * as invoices from "../../../src/lib/db/invoices";
import {
  anonymizeCustomer,
  ANONYMIZED_NAME,
  RETENTION_REFUSAL_REASON,
} from "../../../src/lib/db/dsgvo_erasure";

async function seedCompany(name = "Acme GmbH"): Promise<number> {
  return companies.createCompany({
    name,
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

async function seedCustomer(
  companyId: number,
  name = "Erase Subject",
): Promise<number> {
  return customers.createCustomer({
    company_id: companyId,
    customer_number: "K-001",
    name,
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

async function seedInvoice(
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
}

/**
 * Test-only escape hatch: directly age an invoice's `created_at` past the
 * 10-year retention window without waiting eleven years. Mirrors the helper
 * used by `tests/db/retention.test.ts`.
 */
function ageRow(table: string, id: number, createdAt: string): void {
  testDb.raw.exec(
    `UPDATE ${table} SET created_at = '${createdAt}' WHERE id = ${id}`,
  );
}

describe("anonymizeCustomer (COMP-2.b)", () => {
  test("success path: customer with only old invoices is anonymized; FKs intact", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId, "Old Subject");
    const invId = await seedInvoice(companyId, customerId, "INV-OLD");
    // Push the only invoice well past the 10-year window.
    ageRow("invoices", invId, "2010-01-01 00:00:00");

    const result = await anonymizeCustomer(
      customerId,
      new Date("2026-05-10T00:00:00Z"),
    );
    expect(result.customerId).toBe(customerId);
    expect(result.invoiceCount).toBe(1);

    // Customer row's PII fields are wiped; the row itself still exists so
    // the invoice's FK is preserved.
    const got = await customers.getCustomerById(customerId);
    expect(got).toBeDefined();
    expect(got!.name).toBe(ANONYMIZED_NAME);
    expect(got!.contact_name).toBeNull();
    expect(got!.email).toBeNull();
    expect(got!.phone).toBeNull();
    expect(got!.street).toBeNull();
    expect(got!.postal_code).toBeNull();
    expect(got!.city).toBeNull();
    expect(got!.vat_id).toBeNull();
    expect(got!.website).toBeNull();
    // Audit / numerical columns are preserved.
    expect(got!.id).toBe(customerId);
    expect(got!.company_id).toBe(companyId);
    expect(got!.country_code).toBe("DE");
    expect(got!.customer_number).toBe("K-001");
    expect(got!.type).toBe("kunde");

    // FK invariant: every invoice that pointed at this customer still does.
    const stillLinked = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoices WHERE customer_id = $1",
      [customerId],
    );
    expect(stillLinked.map((r) => r.id)).toEqual([invId]);
  });

  test("success path: customer with NO invoices is anonymized", async () => {
    const companyId = await seedCompany("Empty Co");
    const customerId = await seedCustomer(companyId, "Untouched Subject");

    const result = await anonymizeCustomer(
      customerId,
      new Date("2026-05-10T00:00:00Z"),
    );
    expect(result.invoiceCount).toBe(0);

    const got = await customers.getCustomerById(customerId);
    expect(got!.name).toBe(ANONYMIZED_NAME);
    expect(got!.email).toBeNull();
  });

  test("refusal path: invoice inside retention window blocks erasure with German reason", async () => {
    const companyId = await seedCompany("Recent Co");
    const customerId = await seedCustomer(companyId, "Recent Subject");
    const invId = await seedInvoice(companyId, customerId, "INV-NEW");
    // Leave the invoice's CURRENT_TIMESTAMP intact — well inside 10 years.

    let thrown: Error | undefined;
    try {
      await anonymizeCustomer(customerId, new Date("2026-05-10T00:00:00Z"));
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("RetentionViolation");
    expect(thrown!.message).toBe(RETENTION_REFUSAL_REASON);
    expect(thrown!.message).toContain("§147 AO");
    expect(thrown!.message).toContain("verweigert");

    // PII must NOT have changed — the refusal is a no-op on the customer row.
    const got = await customers.getCustomerById(customerId);
    expect(got!.name).toBe("Recent Subject");
    expect(got!.email).toBe("max@example.test");
    expect(got!.phone).toBe("+49 30 12345");
    expect(got!.street).toBe("Hauptstr. 1");
    expect(got!.vat_id).toBe("DE123456789");

    // A refusal row must have been written to invoice_audit, scoped to the
    // customer entity and listing the blocking invoice id(s).
    const auditRows = await testDb.select<
      {
        entity_type: string;
        entity_id: number;
        op: string;
        fields_diff: string;
      }[]
    >(
      `SELECT entity_type, entity_id, op, fields_diff
         FROM invoice_audit
        WHERE entity_type = 'customers' AND entity_id = $1`,
      [customerId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].op).toBe("update");
    const diff = JSON.parse(auditRows[0].fields_diff) as {
      reason: string;
      blocked_by_invoice_ids: number[];
    };
    expect(diff.reason).toBe(RETENTION_REFUSAL_REASON);
    expect(diff.blocked_by_invoice_ids).toEqual([invId]);
  });

  test("refusal path: mixed-age invoices — even one young invoice blocks the whole erasure", async () => {
    const companyId = await seedCompany("Mixed Co");
    const customerId = await seedCustomer(companyId, "Mixed Subject");
    const oldInv = await seedInvoice(companyId, customerId, "INV-OLD");
    const newInv = await seedInvoice(companyId, customerId, "INV-NEW");
    ageRow("invoices", oldInv, "2010-01-01 00:00:00");
    // newInv keeps today's CURRENT_TIMESTAMP.

    let thrown: Error | undefined;
    try {
      await anonymizeCustomer(customerId, new Date("2026-05-10T00:00:00Z"));
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("RetentionViolation");

    // PII still intact.
    const got = await customers.getCustomerById(customerId);
    expect(got!.name).toBe("Mixed Subject");

    // The audit refusal row must list ONLY the young invoice as blocking.
    const auditRows = await testDb.select<{ fields_diff: string }[]>(
      `SELECT fields_diff FROM invoice_audit
        WHERE entity_type = 'customers' AND entity_id = $1`,
      [customerId],
    );
    expect(auditRows).toHaveLength(1);
    const diff = JSON.parse(auditRows[0].fields_diff) as {
      blocked_by_invoice_ids: number[];
    };
    expect(diff.blocked_by_invoice_ids).toEqual([newInv]);
  });

  test("unknown customer id throws", async () => {
    await expect(anonymizeCustomer(99999)).rejects.toThrow(
      /Customer 99999 not found/,
    );
  });
});
