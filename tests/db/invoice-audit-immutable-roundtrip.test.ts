import { test, expect, describe } from "bun:test";
import "./setup";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as invoices from "../../src/lib/db/invoices";
import { testDb } from "./setup";

/**
 * DAT-6.b: round-trip test for the 0026_down rollback migration.
 *
 * `docs/compliance/gobd.md` §2.3 documents the audit table as append-only
 * and footnotes that the SQL-side lock is "vorgesehen". DAT-6.a (PR #205)
 * installed two BEFORE triggers (`invoice_audit_immutable_update`,
 * `invoice_audit_immutable_delete`) in migration 0026. DAT-6.b (this issue)
 * delivers the corresponding `0026_down/01_invoice_audit_immutable.sql`
 * that drops those triggers, so an operator can roll back to the pre-0026
 * state without orphaning schema.
 *
 * The Rust round-trip harness in `src-tauri/tests/migrations.rs` already
 * asserts that pre-up and post-down schema snapshots match for every
 * migration that lacks a `.noop_down` marker. This Bun test layers an
 * application-level assertion on top: after running the down SQL,
 * `UPDATE`/`DELETE` on `invoice_audit` is no longer blocked, and after
 * re-running the up SQL, the DAT-6.c contract (UPDATE/DELETE raise
 * `audit_immutable`) is restored. That double-check proves both halves
 * of the migration are correctly paired, not just structurally present.
 */

const MIGRATION_DIR = resolve(import.meta.dir, "../../src-tauri/migrations");
const DOWN_SQL = readFileSync(
  `${MIGRATION_DIR}/0026_down/01_invoice_audit_immutable.sql`,
  "utf8",
);
const UP_SQL = readFileSync(
  `${MIGRATION_DIR}/0026/01_invoice_audit_immutable.sql`,
  "utf8",
);

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

function triggerNames(): string[] {
  const rows = testDb.raw
    .query(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'invoice_audit_immutable_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("DAT-6.b: 0026_down rollback round-trip", () => {
  test("baseline (post-up): both immutability triggers are installed", () => {
    expect(triggerNames()).toEqual([
      "invoice_audit_immutable_delete",
      "invoice_audit_immutable_update",
    ]);
  });

  test("after 0026_down: triggers are dropped and UPDATE/DELETE are permitted", async () => {
    const { companyId, customerId } = await seed();
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "RT-1"),
    );
    const [auditRow] = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE entity_type = $1 AND entity_id = $2",
      ["invoices", invId],
    );
    expect(auditRow).toBeDefined();

    // Apply the down migration.
    testDb.raw.exec(DOWN_SQL);

    expect(triggerNames()).toEqual([]);

    // UPDATE now succeeds — the trigger is gone.
    await testDb.execute(
      "UPDATE invoice_audit SET fields_diff = $1 WHERE id = $2",
      ["{}", auditRow.id],
    );
    const [afterUpdate] = await testDb.select<{ fields_diff: string }[]>(
      "SELECT fields_diff FROM invoice_audit WHERE id = $1",
      [auditRow.id],
    );
    expect(afterUpdate.fields_diff).toBe("{}");

    // DELETE now succeeds — the trigger is gone.
    const del = await testDb.execute(
      "DELETE FROM invoice_audit WHERE id = $1",
      [auditRow.id],
    );
    expect(del.rowsAffected).toBe(1);
  });

  test("down → up restores the DAT-6.c contract", async () => {
    const { companyId, customerId } = await seed();

    // Drop the triggers, then re-install them.
    testDb.raw.exec(DOWN_SQL);
    expect(triggerNames()).toEqual([]);
    testDb.raw.exec(UP_SQL);
    expect(triggerNames()).toEqual([
      "invoice_audit_immutable_delete",
      "invoice_audit_immutable_update",
    ]);

    // The DAT-6.c contract holds again.
    const invId = await invoices.createInvoice(
      blankInvoice(companyId, customerId, "RT-2"),
    );
    const [auditRow] = await testDb.select<{ id: number }[]>(
      "SELECT id FROM invoice_audit WHERE entity_type = $1 AND entity_id = $2",
      ["invoices", invId],
    );
    expect(auditRow).toBeDefined();

    let updateThrown: Error | undefined;
    try {
      await testDb.execute(
        "UPDATE invoice_audit SET fields_diff = $1 WHERE id = $2",
        ["{}", auditRow.id],
      );
    } catch (e) {
      updateThrown = e as Error;
    }
    expect(updateThrown?.message).toContain("audit_immutable");

    let deleteThrown: Error | undefined;
    try {
      await testDb.execute("DELETE FROM invoice_audit WHERE id = $1", [
        auditRow.id,
      ]);
    } catch (e) {
      deleteThrown = e as Error;
    }
    expect(deleteThrown?.message).toContain("audit_immutable");
  });
});
