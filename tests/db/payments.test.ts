import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as payments from "../../src/lib/db/payments";

let counter = 0;
async function seedInvoice(): Promise<number> {
  counter++;
  const companyId = await companies.createCompany({
    name: `Co-${counter}`, legal_name: null, street: null, postal_code: null,
    city: null, country_code: "DE", tax_number: null, vat_id: null,
    bank_account_holder: null, bank_iban: null, bank_bic: null, bank_name: null,
  });
  const customerId = await customers.createCustomer({
    company_id: companyId, customer_number: null, name: "Cu",
    contact_name: null, email: null, phone: null, street: null,
    postal_code: null, city: null, country_code: "DE",
    vat_id: null, website: null, type: "kunde",
  });
  return invoices.createInvoice({
    company_id: companyId, customer_id: customerId, project_id: null,
    invoice_number: `INV-${counter}`, status: "issued",
    issue_date: "2026-05-01", due_date: "2026-05-31",
    service_period_start: null, service_period_end: null,
    currency: "EUR", net_cents: 100000, tax_cents: 19000, gross_cents: 119000,
    issuer_name: null, issuer_tax_number: null, issuer_vat_id: null,
    issuer_bank_account_holder: null, issuer_bank_iban: null,
    issuer_bank_bic: null, issuer_bank_name: null,
    recipient_name: null, recipient_street: null,
    recipient_postal_code: null, recipient_city: null,
    recipient_country_code: null, delivery_date: null, due_surcharge: 0,
    language: "de", legal_country_code: "DE", notes: null, s3_key: null,
  });
}

describe("payments", () => {
  test("create + list ordered by payment_date DESC", async () => {
    const invId = await seedInvoice();
    await payments.createPayment({
      invoice_id: invId, payment_date: "2026-05-10", amount_cents: 50000,
      method: "bank_transfer", reference: "REF-1", note: null,
    });
    await payments.createPayment({
      invoice_id: invId, payment_date: "2026-05-20", amount_cents: 69000,
      method: "bank_transfer", reference: "REF-2", note: null,
    });

    const list = (await payments.listByInvoice(invId)).rows;
    expect(list.map((p) => p.reference)).toEqual(["REF-2", "REF-1"]);
  });

  test("CHECK: amount_cents must be > 0", async () => {
    const invId = await seedInvoice();
    await expect(
      payments.createPayment({
        invoice_id: invId, payment_date: "2026-05-10", amount_cents: 0,
        method: null, reference: null, note: null,
      }),
    ).rejects.toThrow();
  });

  test("RESTRICT: cannot delete invoice that has payments", async () => {
    const invId = await seedInvoice();
    await payments.createPayment({
      invoice_id: invId, payment_date: "2026-05-10", amount_cents: 10000,
      method: null, reference: null, note: null,
    });
    await expect(invoices.deleteInvoice(invId)).rejects.toThrow();
  });

  test("deletePayment frees the draft invoice for deletion", async () => {
    const invId = await seedInvoice();
    // Step back to 'draft' so the immutability trigger lets us delete.
    await invoices.updateInvoiceStatus(invId, "issued", "draft");
    const payId = await payments.createPayment({
      invoice_id: invId, payment_date: "2026-05-10", amount_cents: 10000,
      method: null, reference: null, note: null,
    });
    await payments.deletePayment(payId);
    await invoices.deleteInvoice(invId); // must not throw
    expect(await invoices.getInvoiceById(invId)).toBeUndefined();
  });
});
