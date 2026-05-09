import { test, expect } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as projects from "../../src/lib/db/projects";
import * as invoices from "../../src/lib/db/invoices";
import * as invoiceItems from "../../src/lib/db/invoice-items";
import * as payments from "../../src/lib/db/payments";
import * as dashboard from "../../src/lib/db/dashboard";

test("end-to-end: company → customer → project → invoice w/ items → paid → dashboard", async () => {
  // 1. Company
  const companyId = await companies.createCompany({
    name: "Acme",
    legal_name: "Acme GmbH", street: "Hauptstr. 1", postal_code: "10115",
    city: "Berlin", country_code: "DE", tax_number: null, vat_id: null,
    bank_account_holder: null, bank_iban: null, bank_bic: null, bank_name: null,
  });

  // 2. Customer
  const customerId = await customers.createCustomer({
    company_id: companyId, customer_number: "C-001", name: "Big Client",
    contact_name: null, email: "client@example.com", phone: null,
    street: null, postal_code: null, city: null, country_code: "DE",
    vat_id: null, website: null, type: "kunde",
  });

  // 3. Project
  const projectId = await projects.createProject({
    company_id: companyId, customer_id: customerId, project_number: "P-001",
    name: "Website Refactor", description: null, status: "active",
    hourly_rate: 100, starts_on: "2026-04-01", ends_on: null,
  });

  // 4. Invoice with two line items (issued -> paid)
  const invoiceId = await invoices.createInvoice({
    company_id: companyId, customer_id: customerId, project_id: projectId,
    invoice_number: "RE-2026-001", status: "draft",
    issue_date: "2026-05-01", due_date: "2026-05-31",
    service_period_start: "2026-04-01", service_period_end: "2026-04-30",
    currency: "EUR", net_cents: 0, tax_cents: 0, gross_cents: 0,
    issuer_name: null, issuer_tax_number: null, issuer_vat_id: null,
    issuer_bank_account_holder: null, issuer_bank_iban: null,
    issuer_bank_bic: null, issuer_bank_name: null,
    recipient_name: "Big Client", recipient_street: null,
    recipient_postal_code: null, recipient_city: null,
    recipient_country_code: "DE", delivery_date: null,
    due_surcharge: 0, language: "de", legal_country_code: "DE",
    notes: null, s3_key: null,
  });

  await invoiceItems.createInvoiceItem({
    invoice_id: invoiceId, project_id: projectId, time_entry_id: null,
    position: 1, description: "Development", quantity: 10, unit: "Std",
    unit_price_net_cents: 10000, tax_rate: 19, line_total_net_cents: 100000,
  });
  await invoiceItems.createInvoiceItem({
    invoice_id: invoiceId, project_id: projectId, time_entry_id: null,
    position: 2, description: "Code review", quantity: 2, unit: "Std",
    unit_price_net_cents: 10000, tax_rate: 19, line_total_net_cents: 20000,
  });

  // Compute totals from items and persist on invoice
  const items = (await invoiceItems.listByInvoice(invoiceId)).rows;
  const netCents = items.reduce((s, it) => s + it.line_total_net_cents, 0);
  const taxCents = items.reduce(
    (s, it) => s + Math.round((it.line_total_net_cents * it.tax_rate) / 100),
    0,
  );
  await invoices.updateInvoice(invoiceId, {
    net_cents: netCents, tax_cents: taxCents, gross_cents: netCents + taxCents,
  });

  // 5. Status: draft → sent
  await invoices.updateInvoiceStatus(invoiceId, "draft", "sent");

  // 6. Payment for the full amount → paid
  await payments.createPayment({
    invoice_id: invoiceId, payment_date: "2026-05-15",
    amount_cents: netCents + taxCents, method: "bank_transfer",
    reference: "REF-001", note: null,
  });
  await invoices.updateInvoiceStatus(invoiceId, "sent", "paid");

  // Verify final invoice state
  const inv = await invoices.getInvoiceById(invoiceId);
  expect(inv?.status).toBe("paid");
  expect(inv?.net_cents).toBe(120000);
  expect(inv?.tax_cents).toBe(22800);
  expect(inv?.gross_cents).toBe(142800);

  // 7. Dashboard sees this invoice
  const data = await dashboard.getDashboardData(companyId, 2026, "month");
  expect(data.revenue).toEqual([
    { period: "2026-05", total_net: 1200, total_tax: 228 },
  ]);

  // 8. Invariants: payment exists, history has both transitions
  const pays = (await payments.listByInvoice(invoiceId)).rows;
  expect(pays).toHaveLength(1);
  expect(pays[0].amount_cents).toBe(142800);

  // 9. Cannot delete the customer (RESTRICT) or invoice (has payment)
  await expect(customers.deleteCustomer(customerId)).rejects.toThrow();
  await expect(invoices.deleteInvoice(invoiceId)).rejects.toThrow();
});
