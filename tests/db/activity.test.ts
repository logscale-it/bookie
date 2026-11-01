import { expect, test } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import { invoiceKind, listActivity } from "../../src/lib/db/activity";

test("local feed: creation from created_at plus status moves, newest first", async () => {
  const company_id = await companies.createCompany({
    name: "Co", legal_name: null, street: null, postal_code: null, city: null,
    country_code: "DE", tax_number: null, vat_id: null,
    bank_account_holder: null, bank_iban: null, bank_bic: null, bank_name: null,
  });
  const customer_id = await customers.createCustomer({
    company_id, customer_number: null, name: "Kunde", contact_name: null, email: null, phone: null,
    street: null, postal_code: null, city: null, country_code: "DE", vat_id: null, website: null, type: "kunde",
  });
  const id = await invoices.createInvoice({
    company_id, customer_id, project_id: null, invoice_number: "RE-1", status: "draft",
    issue_date: "2026-05-01", due_date: "2026-05-31", service_period_start: null, service_period_end: null,
    currency: "EUR", net_cents: 0, tax_cents: 0, gross_cents: 0,
    issuer_name: null, issuer_tax_number: null, issuer_vat_id: null, issuer_bank_account_holder: null,
    issuer_bank_iban: null, issuer_bank_bic: null, issuer_bank_name: null, recipient_name: null,
    recipient_street: null, recipient_postal_code: null, recipient_city: null, recipient_country_code: null,
    notes: null,
  } as any);
  await invoices.updateInvoiceStatus(id, "draft", "sent");
  await invoices.updateInvoiceStatus(id, "sent", "paid");
  const feed = await listActivity(10);
  expect(feed.map((i) => i.kind).sort()).toEqual(["created", "issued", "paid"]);
  expect(feed[0]).toMatchObject({ invoice_id: id, invoice_number: "RE-1", customer_name: "Kunde", actor_name: null });
  expect(feed.every((i) => !Number.isNaN(Date.parse(i.at)))).toBe(true);
  expect(await listActivity(1)).toHaveLength(1);
});

test("invoiceKind maps status moves", () => {
  expect(invoiceKind(null, "draft", false)).toBe("created");
  expect(invoiceKind("draft", "sent", false)).toBe("issued");
  expect(invoiceKind(null, "sent", true)).toBe("storno");
  expect(invoiceKind("paid", "sent", false)).toBe("reopened");
  expect(invoiceKind("sent", "void", false)).toBe("cancelled");
});
