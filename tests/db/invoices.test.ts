import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as invoiceItems from "../../src/lib/db/invoice-items";
import { testDb } from "./setup";

let counter = 0;
async function seed() {
  counter++;
  const companyId = await companies.createCompany({
    name: `Co-${counter}`,
    legal_name: null, street: null, postal_code: null, city: null,
    country_code: "DE", tax_number: null, vat_id: null,
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

function blankInvoice(
  companyId: number,
  customerId: number,
  invoiceNumber: string,
  overrides: Partial<{ status: string; net: number; tax: number; gross: number }> = {},
) {
  return {
    company_id: companyId,
    customer_id: customerId,
    project_id: null,
    invoice_number: invoiceNumber,
    status: overrides.status ?? "draft",
    issue_date: "2026-05-01",
    due_date: "2026-05-31",
    service_period_start: null,
    service_period_end: null,
    currency: "EUR",
    net_amount: overrides.net ?? 0,
    tax_amount: overrides.tax ?? 0,
    gross_amount: overrides.gross ?? 0,
    issuer_name: null, issuer_tax_number: null, issuer_vat_id: null,
    issuer_bank_account_holder: null, issuer_bank_iban: null,
    issuer_bank_bic: null, issuer_bank_name: null,
    recipient_name: null, recipient_street: null,
    recipient_postal_code: null, recipient_city: null,
    recipient_country_code: null,
    delivery_date: null, due_surcharge: 0,
    language: "de", legal_country_code: "DE",
    notes: null, s3_key: null,
  };
}

describe("invoices CRUD + items + status history", () => {
  test("create invoice + add items, list by invoice in position order", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(blankInvoice(companyId, customerId, "INV-001"));

    await invoiceItems.createInvoiceItem({
      invoice_id: invId, project_id: null, time_entry_id: null,
      position: 2, description: "Second", quantity: 1, unit: "Std",
      unit_price_net: 50, tax_rate: 19, line_total_net: 50,
    });
    await invoiceItems.createInvoiceItem({
      invoice_id: invId, project_id: null, time_entry_id: null,
      position: 1, description: "First", quantity: 2, unit: "Std",
      unit_price_net: 100, tax_rate: 19, line_total_net: 200,
    });

    const items = await invoiceItems.listByInvoice(invId);
    expect(items.map((i) => i.description)).toEqual(["First", "Second"]);
    expect(items[0].line_total_net).toBe(200);
  });

  test("invoice_number UNIQUE constraint prevents duplicates", async () => {
    const { companyId, customerId } = await seed();
    await invoices.createInvoice(blankInvoice(companyId, customerId, "INV-DUP"));
    await expect(
      invoices.createInvoice(blankInvoice(companyId, customerId, "INV-DUP")),
    ).rejects.toThrow();
  });

  test("listInvoices ordered by issue_date DESC and scoped to company", async () => {
    const a = await seed();
    const b = await seed();
    await invoices.createInvoice({
      ...blankInvoice(a.companyId, a.customerId, "A1"),
      issue_date: "2026-01-01",
    });
    await invoices.createInvoice({
      ...blankInvoice(a.companyId, a.customerId, "A2"),
      issue_date: "2026-03-15",
    });
    await invoices.createInvoice({
      ...blankInvoice(b.companyId, b.customerId, "B1"),
      issue_date: "2026-04-01",
    });

    const list = await invoices.listInvoices(a.companyId);
    expect(list.map((i) => i.invoice_number)).toEqual(["A2", "A1"]);
  });

  test("updateInvoiceStatus writes status AND appends to history transactionally", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(blankInvoice(companyId, customerId, "INV-STAT"));

    await invoices.updateInvoiceStatus(invId, "draft", "issued");
    await invoices.updateInvoiceStatus(invId, "issued", "paid");

    const got = await invoices.getInvoiceById(invId);
    expect(got?.status).toBe("paid");

    const history = await testDb.select<
      { from_status: string | null; to_status: string }[]
    >(
      "SELECT from_status, to_status FROM invoice_status_history WHERE invoice_id = $1 ORDER BY id",
      [invId],
    );
    expect(history).toEqual([
      { from_status: "draft", to_status: "issued" },
      { from_status: "issued", to_status: "paid" },
    ]);
  });

  test("status update rolls back on failure (transaction)", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(blankInvoice(companyId, customerId, "INV-RB"));

    // Drop history table mid-flight to force the second statement to fail.
    testDb.raw.exec("DROP TABLE invoice_status_history");

    await expect(
      invoices.updateInvoiceStatus(invId, "draft", "issued"),
    ).rejects.toThrow();

    const got = await invoices.getInvoiceById(invId);
    expect(got?.status).toBe("draft"); // rolled back
  });

  test("CASCADE: deleting invoice removes its items and status history", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(blankInvoice(companyId, customerId, "INV-CASC"));
    await invoiceItems.createInvoiceItem({
      invoice_id: invId, project_id: null, time_entry_id: null,
      position: 1, description: "X", quantity: 1, unit: null,
      unit_price_net: 10, tax_rate: 19, line_total_net: 10,
    });
    await invoices.updateInvoiceStatus(invId, null, "issued");

    await invoices.deleteInvoice(invId);

    expect(await invoiceItems.listByInvoice(invId)).toEqual([]);
    const hist = await testDb.select(
      "SELECT id FROM invoice_status_history WHERE invoice_id = $1",
      [invId],
    );
    expect(hist).toEqual([]);
  });

  test("RESTRICT: cannot delete customer that has invoices", async () => {
    const { companyId, customerId } = await seed();
    await invoices.createInvoice(blankInvoice(companyId, customerId, "INV-FK"));
    await expect(customers.deleteCustomer(customerId)).rejects.toThrow();
  });

  test("CHECK: service period start must be <= end", async () => {
    const { companyId, customerId } = await seed();
    await expect(
      invoices.createInvoice({
        ...blankInvoice(companyId, customerId, "INV-PERIOD"),
        service_period_start: "2026-05-31",
        service_period_end: "2026-05-01",
      }),
    ).rejects.toThrow();
  });
});
