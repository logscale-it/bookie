import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as ii from "../../src/lib/db/incoming-invoices";

let counter = 0;
async function seed() {
  counter++;
  const companyId = await companies.createCompany({
    name: `Co-${counter}`, legal_name: null, street: null, postal_code: null,
    city: null, country_code: "DE", tax_number: null, vat_id: null,
    bank_account_holder: null, bank_iban: null, bank_bic: null, bank_name: null,
  });
  const supplierId = await customers.createCustomer({
    company_id: companyId, customer_number: null, name: "Supplier Co",
    contact_name: null, email: null, phone: null, street: null,
    postal_code: null, city: null, country_code: "DE",
    vat_id: null, website: null, type: "lieferant",
  });
  return { companyId, supplierId };
}

function blankIncoming(companyId: number, supplierId: number | null, invoiceNumber: string) {
  return {
    company_id: companyId,
    supplier_id: supplierId,
    invoice_number: invoiceNumber,
    invoice_date: "2026-04-15",
    net_amount: 100,
    tax_amount: 19,
    status: "offen",
    file_data: null,
    file_name: null,
    file_type: null,
    s3_key: null,
    notes: null,
  };
}

describe("incoming invoices", () => {
  test("create computes gross_amount = net + tax", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-001"));
    const got = await ii.getIncomingInvoiceById(id);
    expect(got?.gross_amount).toBe(119);
  });

  test("update with new net/tax recomputes gross_amount", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-002"));
    await ii.updateIncomingInvoice(id, { net_amount: 200, tax_amount: 38 });
    const got = await ii.getIncomingInvoiceById(id);
    expect(got?.net_amount).toBe(200);
    expect(got?.tax_amount).toBe(38);
    expect(got?.gross_amount).toBe(238);
  });

  test("update without amount change keeps gross stable", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-003"));
    await ii.updateIncomingInvoice(id, { notes: "hello" });
    const got = await ii.getIncomingInvoiceById(id);
    expect(got?.gross_amount).toBe(119);
    expect(got?.notes).toBe("hello");
  });

  test("listIncomingInvoices joins supplier_name and orders by invoice_date DESC", async () => {
    const { companyId, supplierId } = await seed();
    await ii.createIncomingInvoice({
      ...blankIncoming(companyId, supplierId, "OLD"),
      invoice_date: "2026-01-01",
    });
    await ii.createIncomingInvoice({
      ...blankIncoming(companyId, supplierId, "NEW"),
      invoice_date: "2026-04-01",
    });
    const list = (await ii.listIncomingInvoices(companyId)).rows;
    expect(list.map((r) => r.invoice_number)).toEqual(["NEW", "OLD"]);
    expect(list[0].supplier_name).toBe("Supplier Co");
  });

  test("updateIncomingInvoiceStatus changes only status", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-STAT"));
    await ii.updateIncomingInvoiceStatus(id, "bezahlt");
    const got = await ii.getIncomingInvoiceById(id);
    expect(got?.status).toBe("bezahlt");
    expect(got?.gross_amount).toBe(119);
  });

  test("getIncomingInvoiceFile returns file fields including s3_key", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice({
      ...blankIncoming(companyId, supplierId, "S-FILE"),
      file_name: "rechnung.pdf",
      file_type: "application/pdf",
      s3_key: "prefix/rechnung.pdf",
    });
    const file = await ii.getIncomingInvoiceFile(id);
    expect(file?.file_name).toBe("rechnung.pdf");
    expect(file?.s3_key).toBe("prefix/rechnung.pdf");
  });

  test("delete removes the row", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-DEL"));
    await ii.deleteIncomingInvoice(id);
    expect(await ii.getIncomingInvoiceById(id)).toBeUndefined();
  });
});
