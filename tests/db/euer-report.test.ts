import { test, expect, describe } from "bun:test";
import "./setup";
import { testDb } from "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as ii from "../../src/lib/db/incoming-invoices";
import { getEuerReport } from "../../src/lib/db/tax-reports";

let counter = 0;
async function seedCompany() {
  counter++;
  const companyId = await companies.createCompany({
    name: `Co-${counter}`, legal_name: null, street: null, postal_code: null,
    city: null, country_code: "DE", tax_number: null, vat_id: null,
    bank_account_holder: null, bank_iban: null, bank_bic: null, bank_name: null,
  });
  const customerId = await customers.createCustomer({
    company_id: companyId, customer_number: null, name: "Kunde GmbH",
    contact_name: null, email: null, phone: null, street: null,
    postal_code: null, city: null, country_code: "DE",
    vat_id: null, website: null, type: "kunde",
  });
  return { companyId, customerId };
}

async function seedInvoice(
  companyId: number, customerId: number, num: string,
  issueDate: string, netCents: number, taxCents: number,
) {
  return invoices.createInvoice({
    company_id: companyId, customer_id: customerId, project_id: null,
    invoice_number: num, status: "sent", issue_date: issueDate,
    due_date: null, service_period_start: null, service_period_end: null,
    currency: "EUR",
    net_cents: netCents, tax_cents: taxCents, gross_cents: netCents + taxCents,
    issuer_name: null, issuer_tax_number: null, issuer_vat_id: null,
    issuer_bank_account_holder: null, issuer_bank_iban: null,
    issuer_bank_bic: null, issuer_bank_name: null,
    recipient_name: null, recipient_street: null, recipient_postal_code: null,
    recipient_city: null, recipient_country_code: null,
    delivery_date: null, due_surcharge: 0,
    language: "de", legal_country_code: "DE", notes: null, s3_key: null,
  });
}

async function markPaidOn(invoiceId: number, paidDate: string) {
  await invoices.updateInvoiceStatus(invoiceId, "sent", "paid");
  // The immutability trigger does not guard paid_date, so tests can pin
  // an explicit Zufluss date instead of date('now').
  await testDb.execute("UPDATE invoices SET paid_date = $1 WHERE id = $2", [
    paidDate, invoiceId,
  ]);
}

async function seedIncoming(
  companyId: number, invoiceDate: string, status: string,
  netCents: number, taxCents: number,
) {
  return ii.createIncomingInvoice({
    company_id: companyId, supplier_id: null, invoice_number: null,
    invoice_date: invoiceDate, net_cents: netCents, tax_cents: taxCents,
    status, file_name: null, file_type: null, s3_key: null,
    local_path: null, notes: null,
  });
}

describe("getEuerReport", () => {
  test("counts only paid rows inside the period, gross method", async () => {
    const { companyId, customerId } = await seedCompany();

    const taxable = await seedInvoice(companyId, customerId, "R-1", "2026-02-01", 10000, 1900);
    await markPaidOn(taxable, "2026-03-10");

    const taxFree = await seedInvoice(companyId, customerId, "R-2", "2026-02-15", 5000, 0);
    await markPaidOn(taxFree, "2026-04-01");

    // Paid before the period → excluded (Zuflussprinzip).
    const early = await seedInvoice(companyId, customerId, "R-3", "2025-12-01", 99900, 18981);
    await markPaidOn(early, "2025-12-31");

    // Never paid → excluded.
    await seedInvoice(companyId, customerId, "R-4", "2026-05-01", 7777, 1477);

    // Expenses: one paid in period, one open, one paid outside.
    await seedIncoming(companyId, "2026-03-05", "bezahlt", 4000, 760);
    await seedIncoming(companyId, "2026-03-06", "offen", 100000, 19000);
    await seedIncoming(companyId, "2025-11-20", "bezahlt", 50000, 9500);

    const r = await getEuerReport(companyId, "2026-01-01", "2026-12-31");
    expect(r.incomeTaxableNet).toBeCloseTo(100, 2);
    expect(r.incomeVat).toBeCloseTo(19, 2);
    expect(r.incomeTaxFreeNet).toBeCloseTo(50, 2);
    expect(r.incomeTotal).toBeCloseTo(169, 2);
    expect(r.expenseNet).toBeCloseTo(40, 2);
    expect(r.expenseVat).toBeCloseTo(7.6, 2);
    expect(r.expenseTotal).toBeCloseTo(47.6, 2);
    expect(r.profit).toBeCloseTo(121.4, 2);
  });

  test("empty period returns zeros", async () => {
    const { companyId } = await seedCompany();
    const r = await getEuerReport(companyId, "2026-01-01", "2026-01-31");
    expect(r.incomeTotal).toBe(0);
    expect(r.expenseTotal).toBe(0);
    expect(r.profit).toBe(0);
  });
});

describe("paid_date lifecycle", () => {
  test("invoice status transitions stamp and clear paid_date", async () => {
    const { companyId, customerId } = await seedCompany();
    const id = await seedInvoice(companyId, customerId, "R-10", "2026-06-01", 1000, 190);

    await invoices.updateInvoiceStatus(id, "sent", "paid");
    let row = await testDb.select<{ paid_date: string | null }[]>(
      "SELECT paid_date FROM invoices WHERE id = $1", [id]);
    expect(row[0].paid_date).not.toBeNull();

    await invoices.updateInvoiceStatus(id, "paid", "sent");
    row = await testDb.select<{ paid_date: string | null }[]>(
      "SELECT paid_date FROM invoices WHERE id = $1", [id]);
    expect(row[0].paid_date).toBeNull();
  });

  test("incoming invoice created as bezahlt gets invoice_date as paid_date", async () => {
    const { companyId } = await seedCompany();
    const id = await seedIncoming(companyId, "2026-02-02", "bezahlt", 1000, 190);
    const row = await ii.getIncomingInvoiceById(id);
    expect(row?.paid_date).toBe("2026-02-02");
  });

  test("incoming status transitions stamp and clear paid_date", async () => {
    const { companyId } = await seedCompany();
    const id = await seedIncoming(companyId, "2026-02-02", "offen", 1000, 190);

    await ii.updateIncomingInvoiceStatus(id, "bezahlt");
    let row = await ii.getIncomingInvoiceById(id);
    expect(row?.paid_date).not.toBeNull();

    await ii.updateIncomingInvoiceStatus(id, "offen");
    row = await ii.getIncomingInvoiceById(id);
    expect(row?.paid_date).toBeNull();
  });
});
