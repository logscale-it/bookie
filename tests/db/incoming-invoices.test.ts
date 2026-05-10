import { test, expect, describe } from "bun:test";
import { testDb } from "./setup";
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
    net_cents: 10000,
    tax_cents: 1900,
    status: "offen",
    file_name: null,
    file_type: null,
    s3_key: null,
    local_path: null,
    notes: null,
  };
}

describe("incoming invoices", () => {
  test("create computes gross_cents = net_cents + tax_cents", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-001"));
    const got = await ii.getIncomingInvoiceById(id);
    expect(got?.gross_cents).toBe(11900);
  });

  test("update with new net/tax recomputes gross_cents", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-002"));
    await ii.updateIncomingInvoice(id, { net_cents: 20000, tax_cents: 3800 });
    const got = await ii.getIncomingInvoiceById(id);
    expect(got?.net_cents).toBe(20000);
    expect(got?.tax_cents).toBe(3800);
    expect(got?.gross_cents).toBe(23800);
  });

  test("update without amount change keeps gross stable", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-003"));
    await ii.updateIncomingInvoice(id, { notes: "hello" });
    const got = await ii.getIncomingInvoiceById(id);
    expect(got?.gross_cents).toBe(11900);
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
    expect(got?.gross_cents).toBe(11900);
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

  // DAT-5.b (#66): the read path must surface `local_path` for rows whose
  // PDF lives on disk (either a no-S3 upload or a backfilled legacy row).
  test("getIncomingInvoiceFile surfaces local_path", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice({
      ...blankIncoming(companyId, supplierId, "S-LOCAL"),
      file_name: "supplier.pdf",
      file_type: "application/pdf",
      local_path: "/tmp/incoming_invoices/supplier.pdf",
    });
    const file = await ii.getIncomingInvoiceFile(id);
    expect(file?.local_path).toBe("/tmp/incoming_invoices/supplier.pdf");
    expect(file?.s3_key).toBeNull();
    // The legacy `file_data` column is never returned by the read path.
    expect((file as Record<string, unknown>).file_data).toBeUndefined();
  });

  // DAT-5.b: even if the row still holds a legacy BLOB on disk (e.g. a
  // pre-backfill row), `getIncomingInvoiceFile` must NOT return it. The
  // download UI no longer has a fallback path; the row is treated as
  // "no file" until the DAT-5.a backfill evacuates it.
  test("getIncomingInvoiceFile never surfaces the legacy file_data BLOB", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice({
      ...blankIncoming(companyId, supplierId, "S-LEGACY"),
      file_name: "old.pdf",
      file_type: "application/pdf",
    });
    // Simulate the legacy state: a row with a populated BLOB but no s3_key
    // or local_path (the exact rows DAT-5.a evacuates). The production
    // create wrapper deliberately doesn't write `file_data`, so we go
    // through the raw bun:sqlite handle.
    testDb.raw
      .query("UPDATE incoming_invoices SET file_data = $blob WHERE id = $id")
      .run({ $blob: new Uint8Array([0x25, 0x50, 0x44, 0x46]), $id: id });
    const file = await ii.getIncomingInvoiceFile(id);
    // The function must not include the BLOB key at all, regardless of
    // whether the column happens to be populated underneath.
    expect((file as Record<string, unknown>).file_data).toBeUndefined();
    expect(file?.s3_key).toBeNull();
    expect(file?.local_path).toBeNull();
  });

  test("delete removes the row", async () => {
    const { companyId, supplierId } = await seed();
    const id = await ii.createIncomingInvoice(blankIncoming(companyId, supplierId, "S-DEL"));
    await ii.deleteIncomingInvoice(id);
    expect(await ii.getIncomingInvoiceById(id)).toBeUndefined();
  });
});
