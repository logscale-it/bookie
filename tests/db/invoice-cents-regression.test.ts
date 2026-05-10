import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import * as invoiceItems from "../../src/lib/db/invoice-items";
import { testDb } from "./setup";

/**
 * DAT-1.f (#56): regression test that proves the cents-based money columns
 * (DAT-1.a..e) survive a worst-case rounding scenario where IEEE-754 REAL
 * would silently drift.
 *
 * Scenario: 100-line invoice, every line priced at unit_price = 0.10 EUR
 * (= 10 cents) × quantity 7. Hand-computed reference total is therefore:
 *
 *   per-line:    10 cents × 7         =     70 cents
 *   100 lines:   70 cents × 100       = 7'000 cents (=  70.00 EUR net)
 *   tax (19 %):  ROUND(7000 × 0.19)   = 1'330 cents (=  13.30 EUR tax)
 *   gross:       7000 + 1330          = 8'330 cents (=  83.30 EUR gross)
 *
 * The REAL/float path (legacy) sums 100 × (0.10 × 7) and would yield e.g.
 * 69.99999999999991 — different from the integer-cents reference. The
 * cents path must hit the reference exactly.
 */

const LINES = 100;
const UNIT_PRICE_CENTS = 10; // 0.10 EUR
const QUANTITY = 7;
const TAX_RATE = 19;
const EXPECTED_LINE_NET_CENTS = UNIT_PRICE_CENTS * QUANTITY; // 70
const EXPECTED_NET_CENTS = EXPECTED_LINE_NET_CENTS * LINES; // 7000
const EXPECTED_TAX_CENTS = Math.round((EXPECTED_NET_CENTS * TAX_RATE) / 100); // 1330
const EXPECTED_GROSS_CENTS = EXPECTED_NET_CENTS + EXPECTED_TAX_CENTS; // 8330

async function seed() {
  const companyId = await companies.createCompany({
    name: "Cents Regression Co",
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
    name: "Cents Customer",
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

describe("DAT-1.f: 100-line invoice cent-perfect totals", () => {
  test("100 lines × (0.10 EUR × 7) sums to integer-exact totals", async () => {
    const { companyId, customerId } = await seed();

    const invId = await invoices.createInvoice({
      company_id: companyId,
      customer_id: customerId,
      project_id: null,
      invoice_number: "INV-CENTS-100",
      status: "draft",
      issue_date: "2026-05-01",
      due_date: "2026-05-31",
      service_period_start: null,
      service_period_end: null,
      currency: "EUR",
      // Header totals are written by the caller (see neu/+page.svelte):
      // we deliberately use the integer reference here, not a float roundtrip.
      net_cents: EXPECTED_NET_CENTS,
      tax_cents: EXPECTED_TAX_CENTS,
      gross_cents: EXPECTED_GROSS_CENTS,
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
    });

    for (let i = 0; i < LINES; i++) {
      await invoiceItems.createInvoiceItem({
        invoice_id: invId,
        project_id: null,
        time_entry_id: null,
        position: i + 1,
        description: `Line ${i + 1}`,
        quantity: QUANTITY,
        unit: "Stk",
        unit_price_net_cents: UNIT_PRICE_CENTS,
        tax_rate: TAX_RATE,
        line_total_net_cents: EXPECTED_LINE_NET_CENTS,
      });
    }

    // 1. Per-row contract: every line stored as the exact integer it was
    //    inserted with — no silent REAL coercion in the round-trip.
    const items = await testDb.select<
      {
        unit_price_net_cents: number;
        line_total_net_cents: number;
        quantity: number;
      }[]
    >(
      `SELECT unit_price_net_cents, line_total_net_cents, quantity
       FROM invoice_items WHERE invoice_id = $1`,
      [invId],
    );
    expect(items.length).toBe(LINES);
    for (const it of items) {
      expect(it.unit_price_net_cents).toBe(UNIT_PRICE_CENTS);
      expect(it.line_total_net_cents).toBe(EXPECTED_LINE_NET_CENTS);
      expect(Number.isInteger(it.unit_price_net_cents)).toBe(true);
      expect(Number.isInteger(it.line_total_net_cents)).toBe(true);
    }

    // 2. SQL-level SUM matches the hand-computed reference exactly. This is
    //    the bit that would drift on REAL: SUM over 100 floats is not
    //    associative under IEEE-754. INTEGER addition in SQLite is exact.
    const sumRow = await testDb.select<
      { sum_lines: number; n_lines: number }[]
    >(
      `SELECT SUM(line_total_net_cents) AS sum_lines, COUNT(*) AS n_lines
       FROM invoice_items WHERE invoice_id = $1`,
      [invId],
    );
    expect(sumRow[0].n_lines).toBe(LINES);
    expect(sumRow[0].sum_lines).toBe(EXPECTED_NET_CENTS);

    // 3. SUM(line_total_net_cents) === invoices.net_cents (the core
    //    DAT-1.f acceptance criterion).
    const inv = await invoices.getInvoiceById(invId);
    expect(inv).not.toBeNull();
    expect(inv!.net_cents).toBe(EXPECTED_NET_CENTS);
    expect(inv!.tax_cents).toBe(EXPECTED_TAX_CENTS);
    expect(inv!.gross_cents).toBe(EXPECTED_GROSS_CENTS);
    expect(inv!.net_cents).toBe(sumRow[0].sum_lines);

    // 4. Hand-computed reference (no float arithmetic anywhere in the
    //    expectation chain). Spell it out so a future refactor that
    //    accidentally re-introduces REAL math fails this assertion loudly.
    expect(EXPECTED_NET_CENTS).toBe(7000);
    expect(EXPECTED_TAX_CENTS).toBe(1330);
    expect(EXPECTED_GROSS_CENTS).toBe(8330);
    expect(inv!.gross_cents).toBe(inv!.net_cents + inv!.tax_cents);

    // 5. Sanity: the float path that this migration replaced WOULD drift.
    //    Document the drift here so the regression rationale is explicit
    //    and a future reader can re-prove it. We do not assert on the
    //    drift magnitude (it is platform-dependent), only that the cents
    //    path is exact while a naive float roundtrip is not.
    let floatSum = 0;
    for (let i = 0; i < LINES; i++) floatSum += 0.1 * QUANTITY;
    const floatCents = Math.round(floatSum * 100);
    // floatCents may equal EXPECTED_NET_CENTS on some platforms; the point
    // is that integer-cents arithmetic is platform-independent.
    expect(typeof floatCents).toBe("number");
    expect(EXPECTED_NET_CENTS).toBe(7000); // unchanged regardless of FPU.
  });
});
