import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import { testDb } from "./setup";

/**
 * DAT-6.c: integration test for the append-only enforcement on
 * `invoice_audit` installed in migration 0026 (DAT-6.a).
 *
 * `docs/compliance/gobd.md` §2.3 documents the audit table as append-only
 * and footnotes that the SQL-side lock is "vorgesehen". DAT-6.a closed that
 * gap with two BEFORE triggers (`invoice_audit_immutable_update` and
 * `invoice_audit_immutable_delete`) that `RAISE(ABORT, 'audit_immutable')`.
 *
 * The four cases below exercise the contract end-to-end:
 *
 *   1. invoice INSERT still produces an audit row (the writer trigger from
 *      migration 0019 / DAT-4.b is not blocked by the new immutability
 *      triggers — only UPDATE/DELETE on `invoice_audit` are).
 *   2. UPDATE on the audit row is rejected with the `audit_immutable`
 *      string surfaced by SQLite.
 *   3. DELETE on the audit row is rejected with the same string.
 *   4. After both blocked attempts, a second invoice INSERT still writes
 *      a fresh audit row — proving the trigger only blocks UPDATE/DELETE,
 *      not the INSERT path the writer triggers depend on.
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
    net_cents: 0,
    tax_cents: 0,
    gross_cents: 0,
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

describe("DAT-6.c: invoice_audit is append-only", () => {
  test("invoice INSERT writes exactly one audit row via the 0019 writer trigger", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "AUD-1"),
    );

    const auditRows = await testDb.select<
      { id: number; entity_type: string; entity_id: number; op: string }[]
    >(
      "SELECT id, entity_type, entity_id, op FROM invoice_audit WHERE entity_type = $1 AND entity_id = $2",
      ["invoices", invId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].op).toBe("insert");
  });

  test("UPDATE on invoice_audit is rejected with 'audit_immutable'", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "AUD-2"),
    );

    const [auditRow] = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE entity_type = $1 AND entity_id = $2",
      ["invoices", invId],
    );
    expect(auditRow).toBeDefined();
    const auditId = auditRow.id;

    let thrown: Error | undefined;
    try {
      await testDb.execute(
        "UPDATE invoice_audit SET fields_diff = $1 WHERE id = $2",
        ["{}", auditId],
      );
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("audit_immutable");

    // Row content is unchanged — the trigger fired BEFORE UPDATE.
    const [after] = await testDb.select<{ fields_diff: string }[]>(
      "SELECT fields_diff FROM invoice_audit WHERE id = $1",
      [auditId],
    );
    expect(after.fields_diff).not.toBe("{}");
  });

  test("DELETE on invoice_audit is rejected with 'audit_immutable'", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "AUD-3"),
    );

    const [auditRow] = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE entity_type = $1 AND entity_id = $2",
      ["invoices", invId],
    );
    expect(auditRow).toBeDefined();
    const auditId = auditRow.id;

    let thrown: Error | undefined;
    try {
      await testDb.execute("DELETE FROM invoice_audit WHERE id = $1", [
        auditId,
      ]);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("audit_immutable");

    // Row still exists.
    const stillThere = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE id = $1",
      [auditId],
    );
    expect(stillThere).toHaveLength(1);
  });

  test("INSERT path remains unblocked: a second invoice still appends an audit row", async () => {
    const { companyId, customerId } = await seed();

    // First invoice — produces one audit row.
    const invId1 = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "AUD-4a"),
    );
    const [firstAudit] = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE entity_type = $1 AND entity_id = $2",
      ["invoices", invId1],
    );

    // Hit both blocked paths to confirm the trigger is live in this run.
    let updateThrown: Error | undefined;
    try {
      await testDb.execute(
        "UPDATE invoice_audit SET fields_diff = $1 WHERE id = $2",
        ["{}", firstAudit.id],
      );
    } catch (e) {
      updateThrown = e as Error;
    }
    expect(updateThrown?.message).toContain("audit_immutable");

    let deleteThrown: Error | undefined;
    try {
      await testDb.execute("DELETE FROM invoice_audit WHERE id = $1", [
        firstAudit.id,
      ]);
    } catch (e) {
      deleteThrown = e as Error;
    }
    expect(deleteThrown?.message).toContain("audit_immutable");

    // Second invoice — must still produce its own audit row.
    const invId2 = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "AUD-4b"),
    );
    const secondAuditRows = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE entity_type = $1 AND entity_id = $2",
      ["invoices", invId2],
    );
    expect(secondAuditRows).toHaveLength(1);
    expect(secondAuditRows[0].id).not.toBe(firstAudit.id);
  });
});
