import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as invoiceItems from "../../src/lib/db/invoice-items";
import { testDb } from "./setup";
import type { Invoice, InvoiceItem } from "../../src/lib/db/types";

/**
 * DAT-2.c: dedicated immutability + storno test layer.
 *
 * The five acceptance cases from issue #59:
 *   1. update of issued invoice rejected with InvoiceImmutable
 *   2. delete of issued invoice rejected
 *   3. status-only transition on issued invoice succeeds
 *   4. cancelInvoice produces a storno mirror
 *   5. original invoice unchanged after cancel
 *
 * Each case is exercised against the most authoritative layer for the
 * behaviour under test. The DAT-2.b TS pre-check (src/lib/db/invoices.ts)
 * and the DAT-2.a SQL trigger (migration 0020, refined in 0021) are both
 * GoBD guards: the TS pre-check throws a typed `InvoiceImmutable` Error so
 * the UI can branch on `err.name`, and the SQL trigger is the ultimate
 * backstop that fires regardless of which client issued the statement.
 *
 * Cases 1 and 2 therefore have BOTH a TS-layer test (asserting the typed
 * error name) AND a raw-SQL test (asserting the trigger raises
 * `invoice_immutable`), so a future regression that removes the pre-check
 * still leaves the SQL trigger as a tested guard.
 */

let counter = 0;
async function seed() {
  counter++;
  const companyId = await companies.createCompany({
    name: `Co-${counter}`,
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
  overrides: Partial<{
    status: string;
    netCents: number;
    taxCents: number;
    grossCents: number;
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
    net_cents: overrides.netCents ?? 0,
    tax_cents: overrides.taxCents ?? 0,
    gross_cents: overrides.grossCents ?? 0,
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

/**
 * Promote an invoice from 'draft' through the SQL-trigger-respecting status
 * helper. updateInvoiceStatus only changes `status` (and bumps updated_at),
 * so the immutability trigger's column list does not match and the row is
 * allowed to leave 'draft'.
 */
async function issue(invId: number) {
  await invoices.updateInvoiceStatus(invId, "draft", "issued");
}

describe("DAT-2.c case 1: update of issued invoice rejected with InvoiceImmutable", () => {
  test("TS pre-check throws InvoiceImmutable and original row is unchanged", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "C1-TS", {
        netCents: 12345,
        taxCents: 2345,
        grossCents: 14690,
      }),
    );
    await issue(invId);
    const before = await invoices.getInvoiceById(invId);

    let thrown: Error | undefined;
    try {
      await invoices.updateInvoice(invId, {
        notes: "tampering",
        net_cents: 99999,
      });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("InvoiceImmutable");
    // Bit-for-bit unchanged, including updated_at.
    const after = await invoices.getInvoiceById(invId);
    expect(after).toEqual(before);
  });

  test("SQL trigger fires with 'invoice_immutable' on raw UPDATE bypassing the TS pre-check", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "C1-SQL"),
    );
    await issue(invId);

    // Bypass updateInvoice/deleteInvoice entirely so the only guard left is
    // the DAT-2.a SQL trigger from migration 0020 (refined by 0021).
    let thrown: Error | undefined;
    try {
      await testDb.execute("UPDATE invoices SET notes = $1 WHERE id = $2", [
        "raw tampering",
        invId,
      ]);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("invoice_immutable");
    const row = await invoices.getInvoiceById(invId);
    expect(row?.notes).toBeNull();
  });
});

describe("DAT-2.c case 2: delete of issued invoice rejected", () => {
  test("TS pre-check throws InvoiceImmutable and the row still exists", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "C2-TS"),
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

  test("SQL trigger fires with 'invoice_immutable' on raw DELETE bypassing the TS pre-check", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "C2-SQL"),
    );
    await issue(invId);

    let thrown: Error | undefined;
    try {
      await testDb.execute("DELETE FROM invoices WHERE id = $1", [invId]);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("invoice_immutable");
    expect(await invoices.getInvoiceById(invId)).toBeDefined();
  });
});

describe("DAT-2.c case 3: status-only transition on issued invoice succeeds", () => {
  test("updateInvoiceStatus advances issued -> paid without firing the trigger", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "C3-STATUS"),
    );
    await issue(invId); // draft -> issued

    // Already-issued row is allowed to advance further (issued -> paid)
    // because the trigger's column list does not include `status` (or
    // `updated_at`, or `s3_key`).
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

  test("raw UPDATE that touches only status (and updated_at, s3_key) is permitted on an issued invoice", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "C3-SQL"),
    );
    await issue(invId);

    // The DAT-2.a trigger's column list deliberately excludes status,
    // updated_at, and s3_key; an UPDATE that only changes those columns
    // must NOT raise.
    await testDb.execute(
      "UPDATE invoices SET status = $1, s3_key = $2 WHERE id = $3",
      ["paid", "backups/INV-C3.pdf", invId],
    );

    const row = await invoices.getInvoiceById(invId);
    expect(row?.status).toBe("paid");
    expect(row?.s3_key).toBe("backups/INV-C3.pdf");
  });
});

describe("DAT-2.c case 4: cancelInvoice produces a storno mirror", () => {
  test("storno row mirrors header with negated cents, points back via references_invoice_id, is itself issued", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "C4", {
        netCents: 10000,
        taxCents: 1900,
        grossCents: 11900,
      }),
    );
    await invoiceItems.createInvoiceItem({
      invoice_id: invId,
      project_id: null,
      time_entry_id: null,
      position: 1,
      description: "Beratung",
      quantity: 2,
      unit: "Std",
      unit_price_net_cents: 5000,
      tax_rate: 19,
      line_total_net_cents: 10000,
    });
    await issue(invId);

    const stornoId = await invoices.cancelInvoice(invId, "Falscher Betrag");

    const storno = (await invoices.getInvoiceById(stornoId)) as Invoice;
    expect(storno.invoice_number).toBe("C4-storno-1");
    expect(storno.status).toBe("issued");
    expect(storno.references_invoice_id).toBe(invId);
    expect(storno.cancellation_reason).toBe("Falscher Betrag");
    expect(storno.company_id).toBe(companyId);
    expect(storno.customer_id).toBe(customerId);
    // Cents are negated; legacy REAL columns ride along the createInvoice
    // default of 0 (DAT-1.d) so -0 = 0 and we don't assert on them.
    expect(storno.net_cents).toBe(-10000);
    expect(storno.tax_cents).toBe(-1900);
    expect(storno.gross_cents).toBe(-11900);

    // Line items mirror with negated quantity & line totals; unit price
    // stays positive so quantity * unit_price = line_total still holds.
    const stornoItems = (await invoiceItems.listByInvoice(stornoId)).rows;
    expect(stornoItems).toHaveLength(1);
    const sItem = stornoItems[0] as InvoiceItem;
    expect(sItem.description).toBe("Beratung");
    expect(sItem.quantity).toBe(-2);
    expect(sItem.unit_price_net_cents).toBe(5000);
    expect(sItem.line_total_net_cents).toBe(-10000);

    // Status history records the storno's birth as NULL -> issued so audit
    // tooling that walks invoice_status_history sees it.
    const hist = await testDb.select<
      { from_status: string | null; to_status: string }[]
    >(
      "SELECT from_status, to_status FROM invoice_status_history WHERE invoice_id = $1",
      [stornoId],
    );
    expect(hist).toEqual([{ from_status: null, to_status: "issued" }]);
  });
});

describe("DAT-2.c case 5: original invoice unchanged after cancel", () => {
  test("cancelInvoice leaves the original header bit-for-bit identical and its line items untouched", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "C5", {
        netCents: 50000,
        taxCents: 9500,
        grossCents: 59500,
      }),
    );
    await invoiceItems.createInvoiceItem({
      invoice_id: invId,
      project_id: null,
      time_entry_id: null,
      position: 1,
      description: "Schulung",
      quantity: 5,
      unit: "Tag",
      unit_price_net_cents: 10000,
      tax_rate: 19,
      line_total_net_cents: 50000,
    });
    await issue(invId);

    // Snapshot BEFORE cancel.
    const headerBefore = await invoices.getInvoiceById(invId);
    const itemsBefore = (await invoiceItems.listByInvoice(invId)).rows;

    await invoices.cancelInvoice(invId, "Lehrer abgesagt");

    // Snapshot AFTER cancel — must equal before.
    const headerAfter = await invoices.getInvoiceById(invId);
    const itemsAfter = (await invoiceItems.listByInvoice(invId)).rows;
    expect(headerAfter).toEqual(headerBefore);
    expect(itemsAfter).toEqual(itemsBefore);

    // Sanity: the original is still 'issued' (NOT some new 'cancelled'
    // status), references_invoice_id stays NULL on the original, and
    // cancellation_reason stays NULL on the original — only the storno
    // sibling carries those fields.
    expect(headerAfter?.status).toBe("issued");
    expect(headerAfter?.references_invoice_id).toBeNull();
    expect(headerAfter?.cancellation_reason).toBeNull();
  });
});
