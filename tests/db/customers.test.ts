import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";
import * as customers from "../../src/lib/db/customers";

async function seedCompany(name = "Acme") {
  return companies.createCompany({
    name,
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
}

function blankCustomer(companyId: number, overrides: Partial<{ name: string; type: string }> = {}) {
  return {
    company_id: companyId,
    customer_number: null,
    name: overrides.name ?? "Customer",
    contact_name: null,
    email: null,
    phone: null,
    street: null,
    postal_code: null,
    city: null,
    country_code: "DE",
    vat_id: null,
    website: null,
    type: overrides.type ?? "kunde",
  };
}

describe("customers CRUD", () => {
  test("create + read by id", async () => {
    const companyId = await seedCompany();
    const id = await customers.createCustomer(
      blankCustomer(companyId, { name: "Big Client" }),
    );
    const got = await customers.getCustomerById(id);
    expect(got?.name).toBe("Big Client");
    expect(got?.company_id).toBe(companyId);
  });

  test("listCustomers scoped to company, ordered by name", async () => {
    const c1 = await seedCompany("Co1");
    const c2 = await seedCompany("Co2");
    await customers.createCustomer(blankCustomer(c1, { name: "Zulu" }));
    await customers.createCustomer(blankCustomer(c1, { name: "Alpha" }));
    await customers.createCustomer(blankCustomer(c2, { name: "OtherCoCustomer" }));

    const list = await customers.listCustomers(c1);
    expect(list.map((c) => c.name)).toEqual(["Alpha", "Zulu"]);
  });

  test("listSuppliers filters by type", async () => {
    const cid = await seedCompany();
    await customers.createCustomer(blankCustomer(cid, { name: "K", type: "kunde" }));
    await customers.createCustomer(blankCustomer(cid, { name: "L", type: "lieferant" }));
    await customers.createCustomer(blankCustomer(cid, { name: "B", type: "beides" }));

    const suppliers = await customers.listSuppliers(cid);
    expect(suppliers.map((c) => c.name).sort()).toEqual(["B", "L"]);

    const clients = await customers.listClients(cid);
    expect(clients.map((c) => c.name).sort()).toEqual(["B", "K"]);
  });

  test("update writes whitelisted columns only", async () => {
    const cid = await seedCompany();
    const id = await customers.createCustomer(blankCustomer(cid));
    await customers.updateCustomer(id, { name: "Renamed", city: "Berlin" });
    const got = await customers.getCustomerById(id);
    expect(got?.name).toBe("Renamed");
    expect(got?.city).toBe("Berlin");
  });

  test("delete removes the row", async () => {
    const cid = await seedCompany();
    const id = await customers.createCustomer(blankCustomer(cid));
    await customers.deleteCustomer(id);
    expect(await customers.getCustomerById(id)).toBeUndefined();
  });

  test("FK to company is enforced", async () => {
    await expect(
      customers.createCustomer(blankCustomer(99999)),
    ).rejects.toThrow();
  });
});
