import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as ii from "../../src/lib/db/incoming-invoices";
import * as dashboard from "../../src/lib/db/dashboard";

let counter = 0;
async function seedCompany() {
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
  return { companyId, customerId };
}

function makeInvoice(
  companyId: number, customerId: number, num: string,
  issueDate: string, status: string, netCents: number, taxCents: number,
) {
  return {
    company_id: companyId, customer_id: customerId, project_id: null,
    invoice_number: num, status, issue_date: issueDate,
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
  };
}

describe("dashboard aggregates", () => {
  test("periodExpr generates correct SQL fragments", () => {
    expect(dashboard.periodExpr("month", "d")).toBe("strftime('%Y-%m', d)");
    expect(dashboard.periodExpr("year", "d")).toBe("strftime('%Y', d)");
    expect(dashboard.periodExpr("quarter", "d")).toContain("Q");
  });

  test("revenue groups by month, only counts sent/paid invoices in given year", async () => {
    const { companyId, customerId } = await seedCompany();
    // Drafts MUST NOT count
    await invoices.createInvoice(makeInvoice(companyId, customerId, "D1", "2026-01-15", "draft", 999900, 189900));
    // Sent + paid count
    await invoices.createInvoice(makeInvoice(companyId, customerId, "S1", "2026-01-15", "sent", 10000, 1900));
    await invoices.createInvoice(makeInvoice(companyId, customerId, "S2", "2026-01-20", "paid", 20000, 3800));
    await invoices.createInvoice(makeInvoice(companyId, customerId, "S3", "2026-03-01", "paid", 5000, 950));
    // Different year MUST NOT count
    await invoices.createInvoice(makeInvoice(companyId, customerId, "X1", "2025-01-15", "paid", 777700, 147700));

    const rows = await dashboard.getRevenueByPeriod(companyId, 2026, "month");
    expect(rows).toEqual([
      { period: "2026-01", total_net: 300, total_tax: 57 },
      { period: "2026-03", total_net: 50, total_tax: 9.5 },
    ]);
  });

  test("revenue is scoped per company", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await invoices.createInvoice(makeInvoice(a.companyId, a.customerId, "A1", "2026-01-15", "paid", 10000, 1900));
    await invoices.createInvoice(makeInvoice(b.companyId, b.customerId, "B1", "2026-01-15", "paid", 99900, 18900));

    const rowsA = await dashboard.getRevenueByPeriod(a.companyId, 2026, "month");
    expect(rowsA).toEqual([{ period: "2026-01", total_net: 100, total_tax: 19 }]);
  });

  test("costs aggregate from incoming_invoices", async () => {
    const { companyId, customerId } = await seedCompany();
    await ii.createIncomingInvoice({
      company_id: companyId, supplier_id: customerId,
      invoice_number: "IN-1", invoice_date: "2026-02-10",
      net_cents: 50000, tax_cents: 9500, status: "offen",
      file_name: null, file_type: null, s3_key: null, local_path: null, notes: null,
    });
    await ii.createIncomingInvoice({
      company_id: companyId, supplier_id: customerId,
      invoice_number: "IN-2", invoice_date: "2026-02-20",
      net_cents: 10000, tax_cents: 1900, status: "offen",
      file_name: null, file_type: null, s3_key: null, local_path: null, notes: null,
    });

    const rows = await dashboard.getCostsByPeriod(companyId, 2026, "month");
    expect(rows).toEqual([{ period: "2026-02", total_net: 600, total_tax: 114 }]);
  });

  test("getDashboardData returns both revenue and costs", async () => {
    const { companyId, customerId } = await seedCompany();
    await invoices.createInvoice(makeInvoice(companyId, customerId, "R1", "2026-01-15", "paid", 10000, 1900));
    await ii.createIncomingInvoice({
      company_id: companyId, supplier_id: customerId,
      invoice_number: "IN-1", invoice_date: "2026-01-10",
      net_cents: 5000, tax_cents: 950, status: "offen",
      file_name: null, file_type: null, s3_key: null, local_path: null, notes: null,
    });

    const data = await dashboard.getDashboardData(companyId, 2026, "month");
    expect(data.revenue).toEqual([{ period: "2026-01", total_net: 100, total_tax: 19 }]);
    expect(data.costs).toEqual([{ period: "2026-01", total_net: 50, total_tax: 9.5 }]);
  });

  test("quarter grouping puts March in Q1", async () => {
    const { companyId, customerId } = await seedCompany();
    await invoices.createInvoice(makeInvoice(companyId, customerId, "Q1a", "2026-01-15", "paid", 1000, 200));
    await invoices.createInvoice(makeInvoice(companyId, customerId, "Q1b", "2026-03-25", "paid", 2000, 400));
    await invoices.createInvoice(makeInvoice(companyId, customerId, "Q2a", "2026-04-05", "paid", 3000, 600));

    const rows = await dashboard.getRevenueByPeriod(companyId, 2026, "quarter");
    expect(rows).toEqual([
      { period: "2026-Q1", total_net: 30, total_tax: 6 },
      { period: "2026-Q2", total_net: 30, total_tax: 6 },
    ]);
  });
});
