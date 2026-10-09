import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as projects from "../../src/lib/db/projects";
import * as timeEntries from "../../src/lib/db/time-entries";

let counter = 0;
async function seed() {
  counter++;
  const companyId = await companies.createCompany({
    name: `Co-${counter}`, legal_name: null, street: null, postal_code: null,
    city: null, country_code: "DE", tax_number: null, vat_id: null,
    bank_account_holder: null, bank_iban: null, bank_bic: null, bank_name: null,
  });
  const customerId = await customers.createCustomer({
    company_id: companyId, customer_number: null, name: "Cu",
    contact_name: null, email: null, phone: null, street: null,
    postal_code: null, city: null, country_code: "DE",
    vat_id: null, website: null, type: "kunde",
  });
  const projectId = await projects.createProject({
    company_id: companyId, customer_id: customerId, project_number: null,
    name: "Proj", description: null, status: "active",
    hourly_rate: 100, starts_on: null, ends_on: null,
  });
  return { companyId, customerId, projectId };
}

function blankEntry(
  companyId: number,
  customerId: number,
  projectId: number,
  entryDate: string,
  durationMinutes: number,
) {
  return {
    company_id: companyId,
    customer_id: customerId,
    project_id: projectId,
    entry_date: entryDate,
    started_at: null,
    ended_at: null,
    duration_minutes: durationMinutes,
    description: null,
    billable: 1,
  };
}

describe("time entries", () => {
  test("create + list ordered by entry_date DESC, scoped to company", async () => {
    const a = await seed();
    const b = await seed();
    await timeEntries.createTimeEntry(blankEntry(a.companyId, a.customerId, a.projectId, "2026-04-01", 60));
    await timeEntries.createTimeEntry(blankEntry(a.companyId, a.customerId, a.projectId, "2026-05-01", 90));
    await timeEntries.createTimeEntry(blankEntry(b.companyId, b.customerId, b.projectId, "2026-06-01", 30));

    const list = (await timeEntries.listTimeEntries(a.companyId)).rows;
    expect(list.map((e) => e.entry_date)).toEqual(["2026-05-01", "2026-04-01"]);
    expect(list[0].duration_minutes).toBe(90);
  });

  test("listTimesheetEntries filters date range + customer in SQL with no 200 cap", async () => {
    const { companyId, customerId, projectId } = await seed();
    const other = await customers.createCustomer({
      company_id: companyId, customer_number: null, name: "Other",
      contact_name: null, email: null, phone: null, street: null,
      postal_code: null, city: null, country_code: "DE",
      vat_id: null, website: null, type: "kunde",
    });
    // 250 in-range entries for customerId (Jan 2025), plus out-of-range and other-customer noise.
    for (let i = 0; i < 250; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      await timeEntries.createTimeEntry(blankEntry(companyId, customerId, projectId, `2025-01-${day}`, 1));
    }
    await timeEntries.createTimeEntry(blankEntry(companyId, customerId, projectId, "2025-02-01", 1));
    await timeEntries.createTimeEntry(blankEntry(companyId, customerId, projectId, "2024-12-31", 1));
    await timeEntries.createTimeEntry(blankEntry(companyId, other, projectId, "2025-01-15", 1));

    const rows = await timeEntries.listTimesheetEntries(companyId, {
      from: "2025-01-01", to: "2025-01-31", customerId,
    });
    expect(rows.length).toBe(250);
    expect(await timeEntries.listTimesheetEntries(companyId)).toHaveLength(253);
    expect(await timeEntries.listTimesheetEntries(companyId, { from: "2025-01-28", to: "" })).toHaveLength(9);
  });

  test("update changes whitelisted columns", async () => {
    const { companyId, customerId, projectId } = await seed();
    const id = await timeEntries.createTimeEntry(
      blankEntry(companyId, customerId, projectId, "2026-05-01", 60),
    );
    await timeEntries.updateTimeEntry(id, {
      duration_minutes: 120,
      description: "Refactor",
      billable: 0,
    });
    const got = await timeEntries.getTimeEntryById(id);
    expect(got?.duration_minutes).toBe(120);
    expect(got?.description).toBe("Refactor");
    expect(got?.billable).toBe(0);
  });

  test("delete removes the row", async () => {
    const { companyId, customerId, projectId } = await seed();
    const id = await timeEntries.createTimeEntry(
      blankEntry(companyId, customerId, projectId, "2026-05-01", 30),
    );
    await timeEntries.deleteTimeEntry(id);
    expect(await timeEntries.getTimeEntryById(id)).toBeUndefined();
  });

  test("FK to company is enforced", async () => {
    await expect(
      timeEntries.createTimeEntry(blankEntry(99999, 1, 1, "2026-05-01", 30)),
    ).rejects.toThrow();
  });
});
