import { test, expect, describe } from "bun:test";
import "./setup";
import { testDb } from "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as ii from "../../src/lib/db/incoming-invoices";
import { getEuerData, getEuerReport } from "../../src/lib/db/tax-reports";

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
    // VAT surplus goes to the Finanzamt, so profit is net − net:
    // (100 + 50) − 40 = 110, not the gross 121.40.
    expect(r.vatPayable).toBeCloseTo(11.4, 2);
    expect(r.profit).toBeCloseTo(110, 2);
  });

  test("storno offsets the cancelled invoice in both report bases", async () => {
    const { companyId, customerId } = await seedCompany();

    const id = await seedInvoice(companyId, customerId, "R-20", "2026-02-01", 10000, 1900);
    await markPaidOn(id, "2026-02-10");

    const stornoId = await invoices.cancelInvoice(id, "Falscher Betrag");

    // Both reports run on the Zufluss basis: while the refund is
    // outstanding, only the paid original counts — the unpaid storno is
    // excluded from period rows and range report alike.
    let rows = await getEuerData(companyId, 2026, "year");
    expect(rows.reduce((s, r) => s + r.incomeNet, 0)).toBeCloseTo(100, 2);
    let r = await getEuerReport(companyId, "2026-01-01", "2026-12-31");
    expect(r.profit).toBeCloseTo(100, 2);

    // Storno marked paid → the year nets to zero in both reports.
    await markPaidOn(stornoId, "2026-03-01");
    rows = await getEuerData(companyId, 2026, "year");
    expect(rows.reduce((s, r) => s + r.incomeNet, 0)).toBeCloseTo(0, 2);
    expect(rows.reduce((s, r) => s + r.profit, 0)).toBeCloseTo(0, 2);
    r = await getEuerReport(companyId, "2026-01-01", "2026-12-31");
    expect(r.incomeTaxableNet).toBeCloseTo(0, 2);
    expect(r.incomeVat).toBeCloseTo(0, 2);
    expect(r.profit).toBeCloseTo(0, 2);
  });

  test("CSV period rows and range report agree on the year's profit", async () => {
    const { companyId, customerId } = await seedCompany();

    const a = await seedInvoice(companyId, customerId, "R-30", "2026-01-15", 20000, 3800);
    await markPaidOn(a, "2026-02-01");
    const b = await seedInvoice(companyId, customerId, "R-31", "2026-06-01", 5000, 0);
    await markPaidOn(b, "2026-07-15");
    // Unpaid invoice and open bill count in neither report.
    await seedInvoice(companyId, customerId, "R-32", "2026-08-01", 99900, 18981);
    await seedIncoming(companyId, "2026-09-01", "offen", 70000, 13300);
    await seedIncoming(companyId, "2026-03-05", "bezahlt", 4000, 760);

    const rows = await getEuerData(companyId, 2026, "month");
    const csvProfit = rows.reduce((s, r) => s + r.profit, 0);
    const report = await getEuerReport(companyId, "2026-01-01", "2026-12-31");
    // (200 + 50) − 40 = 210, on both paths.
    expect(csvProfit).toBeCloseTo(210, 2);
    expect(report.profit).toBeCloseTo(csvProfit, 2);
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

  test("updateInvoicePaidDate corrects the Zufluss date, only while paid", async () => {
    const { companyId, customerId } = await seedCompany();
    const id = await seedInvoice(companyId, customerId, "R-11", "2026-06-01", 1000, 190);
    await invoices.updateInvoiceStatus(id, "sent", "paid");

    await invoices.updateInvoicePaidDate(id, "2026-06-15");
    let row = await testDb.select<{ paid_date: string | null }[]>(
      "SELECT paid_date FROM invoices WHERE id = $1", [id]);
    expect(row[0].paid_date).toBe("2026-06-15");

    expect(invoices.updateInvoicePaidDate(id, "15.06.2026")).rejects.toThrow();

    await invoices.updateInvoiceStatus(id, "paid", "sent");
    expect(invoices.updateInvoicePaidDate(id, "2026-06-20")).rejects.toThrow();
  });

  test("updateIncomingInvoicePaidDate corrects the Abfluss date, only while bezahlt", async () => {
    const { companyId } = await seedCompany();
    const id = await seedIncoming(companyId, "2026-02-02", "bezahlt", 1000, 190);

    await ii.updateIncomingInvoicePaidDate(id, "2026-02-20");
    let row = await ii.getIncomingInvoiceById(id);
    expect(row?.paid_date).toBe("2026-02-20");

    await ii.updateIncomingInvoiceStatus(id, "offen");
    expect(ii.updateIncomingInvoicePaidDate(id, "2026-02-21")).rejects.toThrow();
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
