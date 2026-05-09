import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";
import * as projects from "../../src/lib/db/projects";

let seedCounter = 0;
async function seedCompanyAndCustomer() {
  seedCounter++;
  const companyId = await companies.createCompany({
    name: `Co-${seedCounter}`,
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

function blankProject(companyId: number, customerId: number | null, name = "Proj") {
  return {
    company_id: companyId,
    customer_id: customerId,
    project_number: null,
    name,
    description: null,
    status: "active",
    hourly_rate: null,
    starts_on: null,
    ends_on: null,
  };
}

describe("projects CRUD", () => {
  test("create + read + list scoped to company", async () => {
    const a = await seedCompanyAndCustomer();
    const b = await seedCompanyAndCustomer();
    await projects.createProject(blankProject(a.companyId, a.customerId, "B-proj"));
    await projects.createProject(blankProject(a.companyId, a.customerId, "A-proj"));
    await projects.createProject(blankProject(b.companyId, b.customerId, "Other"));

    const list = await projects.listProjects(a.companyId);
    expect(list.map((p) => p.name)).toEqual(["A-proj", "B-proj"]);
  });

  test("update writes whitelisted columns", async () => {
    const { companyId, customerId } = await seedCompanyAndCustomer();
    const id = await projects.createProject(blankProject(companyId, customerId));
    await projects.updateProject(id, { name: "Renamed", hourly_rate: 90, status: "completed" });
    const got = await projects.getProjectById(id);
    expect(got?.name).toBe("Renamed");
    expect(got?.hourly_rate).toBe(90);
    expect(got?.status).toBe("completed");
  });

  test("delete removes the project", async () => {
    const { companyId, customerId } = await seedCompanyAndCustomer();
    const id = await projects.createProject(blankProject(companyId, customerId));
    await projects.deleteProject(id);
    expect(await projects.getProjectById(id)).toBeUndefined();
  });

  test("FK to company is enforced", async () => {
    await expect(
      projects.createProject(blankProject(99999, null)),
    ).rejects.toThrow();
  });

  test("deleting customer SET NULLs project.customer_id", async () => {
    const { companyId, customerId } = await seedCompanyAndCustomer();
    const id = await projects.createProject(blankProject(companyId, customerId));
    await customers.deleteCustomer(customerId);
    const got = await projects.getProjectById(id);
    expect(got?.customer_id).toBeNull();
  });

  test("UNIQUE (company_id, project_number) constraint", async () => {
    const { companyId, customerId } = await seedCompanyAndCustomer();
    await projects.createProject({ ...blankProject(companyId, customerId, "P1"), project_number: "P-001" });
    await expect(
      projects.createProject({ ...blankProject(companyId, customerId, "P2"), project_number: "P-001" }),
    ).rejects.toThrow();
  });
});
