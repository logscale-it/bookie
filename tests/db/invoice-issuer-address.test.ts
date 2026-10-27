import { test, expect } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import { testDb } from "./setup";

// Migration 0033: the issuer address is snapshotted on the invoice, frozen
// once issued and carried over to the storno.

let n = 0;
async function newInvoice() {
  const companyId = await companies.createCompany({
    name: `Co-${++n}`,
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
  return invoices.createInvoice({
    company_id: companyId,
    customer_id: customerId,
    project_id: null,
    invoice_number: `IA-${n}`,
    status: "draft",
    issue_date: "2026-05-01",
    due_date: null,
    service_period_start: null,
    service_period_end: null,
    currency: "EUR",
    net_cents: 0,
    tax_cents: 0,
    gross_cents: 0,
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
    issuer_street: "Alte Str. 1",
    issuer_postal_code: "10115",
    issuer_city: "Berlin",
    issuer_country_code: "DE",
  });
}

test("issuer address is stored, frozen once issued, copied to the storno", async () => {
  const id = await newInvoice();
  await invoices.updateInvoiceStatus(id, "draft", "issued");
  await expect(
    testDb.execute("UPDATE invoices SET issuer_city = 'Köln' WHERE id = $1", [id]),
  ).rejects.toThrow(/invoice_immutable/);
  const storno = await invoices.getInvoiceById(
    await invoices.cancelInvoice(id, "Fehler"),
  );
  expect(storno).toMatchObject({
    issuer_street: "Alte Str. 1",
    issuer_postal_code: "10115",
    issuer_city: "Berlin",
    issuer_country_code: "DE",
  });
});
