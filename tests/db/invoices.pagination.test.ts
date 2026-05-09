import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";

async function seed() {
  const companyId = await companies.createCompany({
    name: "PaginationCo",
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
  return { companyId, customerId };
}

function blankInvoice(
  companyId: number,
  customerId: number,
  invoiceNumber: string,
) {
  return {
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
    net_amount: 0,
    tax_amount: 0,
    gross_amount: 0,
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
  };
}

async function insert1000(companyId: number, customerId: number) {
  for (let i = 0; i < 1000; i++) {
    // Pad to 4 digits so invoice numbers stay unique within the company.
    const num = `INV-${i.toString().padStart(4, "0")}`;
    await invoices.createInvoice(blankInvoice(companyId, customerId, num));
  }
}

describe("listInvoices pagination (PERF-1.c)", () => {
  test("limit=50 over 1000 rows returns 50 rows and totalCount=1000", async () => {
    const { companyId, customerId } = await seed();
    await insert1000(companyId, customerId);

    const page = await invoices.listInvoices(companyId, { limit: 50 });
    expect(page.rows.length).toBe(50);
    expect(page.totalCount).toBe(1000);
  });

  test("offset=999 limit=50 returns the single trailing row", async () => {
    const { companyId, customerId } = await seed();
    await insert1000(companyId, customerId);

    const page = await invoices.listInvoices(companyId, {
      limit: 50,
      offset: 999,
    });
    expect(page.rows.length).toBe(1);
    expect(page.totalCount).toBe(1000);
  });

  test("offset past the end returns empty rows but is consistent", async () => {
    // When the page is empty, totalCount falls back to 0 because we read it
    // off the first row of the result set. This is acceptable for the UI
    // contract (the caller already knows it's beyond the end), but the test
    // documents the behaviour so a future change is intentional.
    const { companyId, customerId } = await seed();
    await insert1000(companyId, customerId);

    const page = await invoices.listInvoices(companyId, {
      limit: 50,
      offset: 5000,
    });
    expect(page.rows.length).toBe(0);
    expect(page.totalCount).toBe(0);
  });

  test("listAllInvoices paginates across companies with limit=50", async () => {
    const a = await seed();
    await insert1000(a.companyId, a.customerId);

    const page = await invoices.listAllInvoices({ limit: 50 });
    expect(page.rows.length).toBe(50);
    expect(page.totalCount).toBe(1000);

    const tail = await invoices.listAllInvoices({ limit: 50, offset: 999 });
    expect(tail.rows.length).toBe(1);
    expect(tail.totalCount).toBe(1000);
  });
});
