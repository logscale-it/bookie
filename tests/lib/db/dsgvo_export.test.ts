/// <reference types="bun" />
import { test, expect, describe } from "bun:test";
import "../../db/setup";

import JSZip from "jszip";

import * as companies from "../../../src/lib/db/companies";
import * as customers from "../../../src/lib/db/customers";
import * as invoices from "../../../src/lib/db/invoices";
import * as payments from "../../../src/lib/db/payments";
import {
  exportCustomerData,
  collectCustomerData,
  suggestExportFileName,
} from "../../../src/lib/db/dsgvo_export";

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
  name = "Subject Person",
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
  invoiceNumber = "INV-1",
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

describe("dsgvo_export", () => {
  test("collectCustomerData returns the customer + invoice + payment + audit row after a mutation", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const invoiceId = await seedInvoice(companyId, customerId);
    const paymentId = await payments.createPayment({
      invoice_id: invoiceId,
      payment_date: "2026-05-10",
      amount_cents: 50000,
      method: "bank_transfer",
      reference: "REF-1",
      note: null,
    });
    // Mutate the invoice so we get an UPDATE audit row in addition to the
    // INSERT rows from create-time.
    await invoices.updateInvoice(invoiceId, { notes: "After mutation" });

    const bundle = await collectCustomerData(customerId);

    expect(bundle.customer.id).toBe(customerId);
    expect(bundle.customer.name).toBe("Subject Person");
    expect(bundle.invoices.map((i) => i.id)).toEqual([invoiceId]);
    expect(bundle.payments.map((p) => p.id)).toEqual([paymentId]);

    // Audit rows we expect after this scenario:
    //  - invoices INSERT
    //  - payments INSERT
    //  - invoices UPDATE
    const ops = bundle.auditEvents.map((a) => `${a.entity_type}:${a.op}`);
    expect(ops).toContain("invoices:insert");
    expect(ops).toContain("payments:insert");
    expect(ops).toContain("invoices:update");
  });

  test("collectCustomerData picks up audit rows for deleted invoices via fields_diff.customer_id", async () => {
    const companyId = await seedCompany("Co-Del");
    const customerId = await seedCustomer(companyId, "Deleted-Customer");
    const invoiceId = await seedInvoice(companyId, customerId, "INV-DEL");
    await invoices.deleteInvoice(invoiceId);

    const bundle = await collectCustomerData(customerId);
    // The invoices table no longer has the row, but the audit history must
    // still surface it via fields_diff.customer_id.before.
    expect(bundle.invoices).toEqual([]);
    const ops = bundle.auditEvents.map((a) => `${a.entity_type}:${a.op}`);
    expect(ops).toContain("invoices:insert");
    expect(ops).toContain("invoices:delete");
  });

  test("exportCustomerData produces a ZIP containing the four JSON files plus a PDF", async () => {
    const companyId = await seedCompany();
    const customerId = await seedCustomer(companyId);
    const invoiceId = await seedInvoice(companyId, customerId);
    await payments.createPayment({
      invoice_id: invoiceId,
      payment_date: "2026-05-10",
      amount_cents: 119000,
      method: "bank_transfer",
      reference: "REF-1",
      note: null,
    });
    await invoices.updateInvoice(invoiceId, { notes: "Updated" });

    const bytes = await exportCustomerData(customerId);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(bytes);
    const fileNames = Object.keys(zip.files).sort();
    expect(fileNames).toEqual(
      [
        "DSGVO-Auskunft.pdf",
        "audit_events.json",
        "customer.json",
        "invoices.json",
        "metadata.json",
        "payments.json",
      ].sort(),
    );

    const customerJson = JSON.parse(
      await zip.file("customer.json")!.async("string"),
    );
    expect(customerJson.id).toBe(customerId);
    expect(customerJson.name).toBe("Subject Person");
    // Every column should be present (not just the canonical fields)
    for (const col of [
      "company_id",
      "customer_number",
      "name",
      "contact_name",
      "email",
      "phone",
      "street",
      "postal_code",
      "city",
      "country_code",
      "vat_id",
      "website",
      "type",
      "created_at",
      "updated_at",
    ]) {
      expect(customerJson).toHaveProperty(col);
    }

    const invoicesJson = JSON.parse(
      await zip.file("invoices.json")!.async("string"),
    );
    expect(invoicesJson).toHaveLength(1);
    expect(invoicesJson[0].id).toBe(invoiceId);

    const paymentsJson = JSON.parse(
      await zip.file("payments.json")!.async("string"),
    );
    expect(paymentsJson).toHaveLength(1);
    expect(paymentsJson[0].invoice_id).toBe(invoiceId);

    const auditJson = JSON.parse(
      await zip.file("audit_events.json")!.async("string"),
    );
    expect(Array.isArray(auditJson)).toBe(true);
    // At least the three rows from insert/insert/update.
    expect(auditJson.length).toBeGreaterThanOrEqual(3);

    // PDF must start with the magic bytes %PDF and be non-trivial in size.
    const pdfBytes = await zip.file("DSGVO-Auskunft.pdf")!.async("uint8array");
    expect(pdfBytes.length).toBeGreaterThan(500);
    const magic = String.fromCharCode(...pdfBytes.subarray(0, 4));
    expect(magic).toBe("%PDF");

    const meta = JSON.parse(await zip.file("metadata.json")!.async("string"));
    expect(meta.bundle_kind).toBe("dsgvo_subject_access_export");
    expect(meta.customer_id).toBe(customerId);
    expect(meta.counts.invoices).toBe(1);
    expect(meta.counts.payments).toBe(1);
    expect(meta.counts.audit_events).toBeGreaterThanOrEqual(3);
  });

  test("exportCustomerData throws on unknown customer id", async () => {
    await expect(exportCustomerData(99999)).rejects.toThrow(
      /Customer 99999 not found/,
    );
  });

  test("suggestExportFileName produces a date-stamped, sanitized name", () => {
    const fixedDate = new Date("2026-05-09T10:00:00Z");
    const name = suggestExportFileName(
      { id: 7, name: "Café Möbel & Co. GmbH" },
      fixedDate,
    );
    expect(name.startsWith("dsgvo-auskunft-")).toBe(true);
    expect(name.endsWith("-2026-05-09.zip")).toBe(true);
    // No path separators or spaces — safe for use as a default save path.
    expect(name).not.toMatch(/[\s/\\]/);
  });
});
