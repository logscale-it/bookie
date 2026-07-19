import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as items from "../../src/lib/db/invoice-items";
import * as ii from "../../src/lib/db/incoming-invoices";
import { getDatevBookingRows } from "../../src/lib/db/datev";

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
  issueDate: string, status: string,
  lines: { netCents: number; taxRate: number }[],
) {
  const netCents = lines.reduce((s, l) => s + l.netCents, 0);
  const taxCents = lines.reduce(
    (s, l) => s + Math.round((l.netCents * l.taxRate) / 100), 0);
  const invoiceId = await invoices.createInvoice({
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
  });
  for (let i = 0; i < lines.length; i++) {
    await items.createInvoiceItem({
      invoice_id: invoiceId, project_id: null, time_entry_id: null,
      position: i, description: `Pos ${i}`, quantity: 1, unit: null,
      unit_price_net_cents: lines[i].netCents, tax_rate: lines[i].taxRate,
      line_total_net_cents: lines[i].netCents,
    });
  }
  return invoiceId;
}

describe("getDatevBookingRows", () => {
  test("one revenue booking per invoice and tax rate, gross = net + VAT", async () => {
    const { companyId, customerId } = await seedCompany();
    await seedInvoice(companyId, customerId, "RE-1", "2026-03-05", "sent", [
      { netCents: 100000, taxRate: 19 },
      { netCents: 50000, taxRate: 19 },
      { netCents: 20000, taxRate: 7 },
    ]);

    const rows = await getDatevBookingRows(companyId, 2026);
    expect(rows).toEqual([
      {
        grossCents: 178500, // 150000 net + 28500 VAT
        taxRate: 19,
        date: "2026-03-05",
        documentNumber: "RE-1",
        text: "Kunde GmbH",
        kind: "revenue",
      },
      {
        grossCents: 21400, // 20000 net + 1400 VAT
        taxRate: 7,
        date: "2026-03-05",
        documentNumber: "RE-1",
        text: "Kunde GmbH",
        kind: "revenue",
      },
    ]);
  });

  test("drafts and other years are excluded", async () => {
    const { companyId, customerId } = await seedCompany();
    await seedInvoice(companyId, customerId, "D-1", "2026-01-10", "draft", [
      { netCents: 10000, taxRate: 19 },
    ]);
    await seedInvoice(companyId, customerId, "RE-25", "2025-06-01", "paid", [
      { netCents: 10000, taxRate: 19 },
    ]);

    expect(await getDatevBookingRows(companyId, 2026)).toEqual([]);
  });

  test("incoming invoices become expense bookings with derived tax rate", async () => {
    const { companyId, customerId } = await seedCompany();
    await ii.createIncomingInvoice({
      company_id: companyId, supplier_id: customerId,
      invoice_number: "IN-7", invoice_date: "2026-02-10",
      net_cents: 5000, tax_cents: 950, status: "offen",
      file_name: null, file_type: null, s3_key: null, local_path: null,
      notes: null,
    });

    const rows = await getDatevBookingRows(companyId, 2026);
    expect(rows).toEqual([
      {
        grossCents: 5950,
        taxRate: 19,
        date: "2026-02-10",
        documentNumber: "IN-7",
        text: "Kunde GmbH",
        kind: "expense",
      },
    ]);
  });

  test("non-standard incoming tax rates fall back to 0 (booked gross)", async () => {
    const { companyId, customerId } = await seedCompany();
    await ii.createIncomingInvoice({
      company_id: companyId, supplier_id: customerId,
      invoice_number: null, invoice_date: "2026-04-01",
      net_cents: 10000, tax_cents: 1600, status: "offen", // 16% (2020 rate)
      file_name: null, file_type: null, s3_key: null, local_path: null,
      notes: null,
    });

    const rows = await getDatevBookingRows(companyId, 2026);
    expect(rows).toHaveLength(1);
    expect(rows[0].taxRate).toBe(0);
    expect(rows[0].grossCents).toBe(11600);
    expect(rows[0].documentNumber).toBe("");
  });
});
