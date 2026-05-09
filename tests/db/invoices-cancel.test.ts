import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as invoiceItems from "../../src/lib/db/invoice-items";
import { testDb } from "./setup";
import type { Invoice, InvoiceItem } from "../../src/lib/db/types";

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
  overrides: Partial<{
    status: string;
    net: number;
    tax: number;
    gross: number;
  }> = {},
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
    net_cents: overrides.net ?? 0,
    tax_cents: overrides.tax ?? 0,
    gross_cents: overrides.gross ?? 0,
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

/**
 * Promote an invoice from 'draft' through the SQL-trigger-respecting status
 * helper so the row's status reflects what the DAT-2.a immutability trigger
 * sees as "issued". Avoids an UPDATE that the trigger would block.
 */
async function issue(invId: number) {
  await invoices.updateInvoiceStatus(invId, "draft", "issued");
}

describe("DAT-2.b: TS pre-checks for issued-invoice immutability", () => {
  test("updateInvoice on a draft succeeds (regression)", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "INV-DRAFT"),
    );
    await invoices.updateInvoice(invId, { notes: "edited" });
    const got = await invoices.getInvoiceById(invId);
    expect(got?.notes).toBe("edited");
  });

  test("updateInvoice on an issued invoice throws InvoiceImmutable", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "INV-ISSUED"),
    );
    await issue(invId);

    let thrown: Error | undefined;
    try {
      await invoices.updateInvoice(invId, { notes: "should not stick" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("InvoiceImmutable");
    // Original row must be untouched.
    const got = await invoices.getInvoiceById(invId);
    expect(got?.notes).toBeNull();
  });

  test("deleteInvoice on a draft succeeds", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "INV-DEL-DRAFT"),
    );
    await invoices.deleteInvoice(invId);
    expect(await invoices.getInvoiceById(invId)).toBeUndefined();
  });

  test("deleteInvoice on an issued invoice throws InvoiceImmutable", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "INV-DEL-ISSUED"),
    );
    await issue(invId);

    let thrown: Error | undefined;
    try {
      await invoices.deleteInvoice(invId);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("InvoiceImmutable");
    expect(await invoices.getInvoiceById(invId)).toBeDefined();
  });

  test("updateInvoice on a missing id is a no-op (does not throw)", async () => {
    // The pre-check only fires on rows that exist; a missing id stays a
    // no-op UPDATE so callers that race against a delete don't see a
    // surprise InvoiceImmutable error.
    await invoices.updateInvoice(99999, { notes: "x" });
  });
});

describe("DAT-2.b: cancelInvoice (storno)", () => {
  test("cancelInvoice on issued invoice creates a -storno-1 mirror with negated cents", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice({
      ...blankInvoice(companyId, customerId, "INV-100"),
      net_cents: 10000,
      tax_cents: 1900,
      gross_cents: 11900,
    });
    await invoiceItems.createInvoiceItem({
      invoice_id: invId, project_id: null, time_entry_id: null,
      position: 1, description: "Beratung", quantity: 2, unit: "Std",
      unit_price_net_cents: 5000, tax_rate: 19, line_total_net_cents: 10000,
    });
    await issue(invId);

    // Snapshot the original's row BEFORE storno so we can verify
    // bit-for-bit immutability afterwards.
    const before = await invoices.getInvoiceById(invId);
    const itemsBefore = (await invoiceItems.listByInvoice(invId)).rows;

    const stornoId = await invoices.cancelInvoice(invId, "Falscher Betrag");
    expect(stornoId).toBeGreaterThan(invId);

    const storno = (await invoices.getInvoiceById(stornoId)) as Invoice;
    expect(storno.invoice_number).toBe("INV-100-storno-1");
    expect(storno.status).toBe("issued");
    expect(storno.net_cents).toBe(-10000);
    expect(storno.tax_cents).toBe(-1900);
    expect(storno.gross_cents).toBe(-11900);
    // Legacy REAL columns are no longer written by createInvoice (DAT-1.d),
    // so the storno mirrors them as -0 = 0; *_cents above carries the truth.
    expect(storno.references_invoice_id).toBe(invId);
    expect(storno.cancellation_reason).toBe("Falscher Betrag");
    expect(storno.company_id).toBe(companyId);
    expect(storno.customer_id).toBe(customerId);

    // Original row is bit-for-bit unchanged.
    const after = await invoices.getInvoiceById(invId);
    expect(after).toEqual(before);

    // Line items mirrored with negated quantity & line totals; unit price
    // stays positive so quantity * unit_price = line_total still holds.
    const stornoItems = (await invoiceItems.listByInvoice(stornoId)).rows;
    expect(stornoItems).toHaveLength(1);
    const sItem = stornoItems[0] as InvoiceItem;
    expect(sItem.description).toBe("Beratung");
    expect(sItem.quantity).toBe(-2);
    expect(sItem.unit_price_net_cents).toBe(5000);
    expect(sItem.line_total_net_cents).toBe(-10000);

    // Original line items unchanged.
    const itemsAfter = (await invoiceItems.listByInvoice(invId)).rows;
    expect(itemsAfter).toEqual(itemsBefore);

    // A status-history row exists for the storno (from-NULL -> 'issued').
    const hist = await testDb.select<
      { from_status: string | null; to_status: string }[]
    >(
      "SELECT from_status, to_status FROM invoice_status_history WHERE invoice_id = $1",
      [stornoId],
    );
    expect(hist).toEqual([{ from_status: null, to_status: "issued" }]);
  });

  test("cancelInvoice on a draft throws InvoiceImmutable (drafts must be deleted, not stornoed)", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "INV-DRAFT-CANCEL"),
    );

    let thrown: Error | undefined;
    try {
      await invoices.cancelInvoice(invId, "test");
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("InvoiceImmutable");
    // No storno row was created.
    const all = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoices WHERE references_invoice_id = $1",
      [invId],
    );
    expect(all).toEqual([]);
  });

  test("cancelInvoice twice yields -storno-1 then -storno-2", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "INV-TWICE"),
    );
    await issue(invId);

    const first = await invoices.cancelInvoice(invId, "first attempt");
    const second = await invoices.cancelInvoice(invId, "second attempt");

    const firstRow = await invoices.getInvoiceById(first);
    const secondRow = await invoices.getInvoiceById(second);
    expect(firstRow?.invoice_number).toBe("INV-TWICE-storno-1");
    expect(secondRow?.invoice_number).toBe("INV-TWICE-storno-2");
    expect(firstRow?.cancellation_reason).toBe("first attempt");
    expect(secondRow?.cancellation_reason).toBe("second attempt");
  });

  test("cancelInvoice rolls back if line item insert fails", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "INV-RB-STORNO"),
    );
    await invoiceItems.createInvoiceItem({
      invoice_id: invId, project_id: null, time_entry_id: null,
      position: 1, description: "X", quantity: 1, unit: null,
      unit_price_net_cents: 1000, tax_rate: 19, line_total_net_cents: 1000,
    });
    await issue(invId);

    // Drop invoice_items mid-flight so the storno's line item INSERT
    // fails. The header INSERT runs first, so rollback is what saves us.
    testDb.raw.exec("DROP TABLE invoice_items");

    let thrown: Error | undefined;
    try {
      await invoices.cancelInvoice(invId, "should rollback");
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();

    // The storno header should NOT exist after rollback.
    const stornos = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoices WHERE references_invoice_id = $1",
      [invId],
    );
    expect(stornos).toEqual([]);
  });

  test("storno row is itself immutable: subsequent updateInvoice on it throws", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "INV-IMM-STORNO"),
    );
    await issue(invId);
    const stornoId = await invoices.cancelInvoice(invId, "test");

    let thrown: Error | undefined;
    try {
      await invoices.updateInvoice(stornoId, { notes: "tampering" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("InvoiceImmutable");
  });
});
