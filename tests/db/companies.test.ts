import { test, expect, describe } from "bun:test";
import "./setup";
import * as companies from "../../src/lib/db/companies";

describe("companies CRUD", () => {
  test("createCompany returns lastInsertId and persists data", async () => {
    const id = await companies.createCompany({
      name: "Acme GmbH",
      legal_name: "Acme GmbH",
      street: "Hauptstr. 1",
      postal_code: "10115",
      city: "Berlin",
      country_code: "DE",
      tax_number: "123/456/789",
      vat_id: "DE123456789",
      bank_account_holder: "Acme GmbH",
      bank_iban: "DE89370400440532013000",
      bank_bic: "COBADEFFXXX",
      bank_name: "Commerzbank",
    });
    expect(id).toBeGreaterThan(0);

    const got = await companies.getCompanyById(id);
    expect(got?.name).toBe("Acme GmbH");
    expect(got?.country_code).toBe("DE");
    expect(got?.bank_iban).toBe("DE89370400440532013000");
  });

  test("listCompanies returns all rows ordered by name", async () => {
    await companies.createCompany(blankCompany("Charlie"));
    await companies.createCompany(blankCompany("Alpha"));
    await companies.createCompany(blankCompany("Bravo"));

    const list = await companies.listCompanies();
    expect(list.map((c) => c.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("updateCompany only writes whitelisted columns", async () => {
    const id = await companies.createCompany(blankCompany("Old"));
    await companies.updateCompany(id, {
      name: "New",
      city: "Hamburg",
      // @ts-expect-error — disallowed key must be silently ignored
      id: 999,
    });
    const got = await companies.getCompanyById(id);
    expect(got?.id).toBe(id);
    expect(got?.name).toBe("New");
    expect(got?.city).toBe("Hamburg");
  });

  test("deleteCompany removes the row", async () => {
    const id = await companies.createCompany(blankCompany("ToDelete"));
    await companies.deleteCompany(id);
    expect(await companies.getCompanyById(id)).toBeUndefined();
  });

  test("UNIQUE name constraint is enforced", async () => {
    await companies.createCompany(blankCompany("Duplicate"));
    await expect(
      companies.createCompany(blankCompany("Duplicate")),
    ).rejects.toThrow();
  });
});

function blankCompany(name: string) {
  return {
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
  };
}
