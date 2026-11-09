import { afterAll, afterEach, expect, test } from "bun:test";
import {
  getOrganizationSettings,
  saveInvoiceSettings,
  saveOrganizationSettings,
} from "$lib/db/settings";

const saved = {
  localStorage: (globalThis as any).localStorage,
  fetch: globalThis.fetch,
};
afterAll(() => Object.assign(globalThis, saved));
const calls: { path: string; method: string; body?: any }[] = [];
const routes: Record<string, [number, unknown]> = {};
(globalThis as any).localStorage = {
  getItem: () => JSON.stringify({ url: "http://s", token: "t", email: "e" }),
  removeItem: () => {},
};
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const path = url.slice("http://s".length);
  const method = init.method ?? "GET";
  calls.push({
    path,
    method,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  });
  const [status, body] = routes[`${method} ${path}`] ?? [200, { ok: true }];
  return new Response(JSON.stringify(body), { status });
}) as any;
afterEach(() => (calls.length = 0));

test("organisation settings merge company + settings and map field names", async () => {
  routes["GET /api/company"] = [
    200,
    { id: 1, name: "ACME", country_code: "DE", vat_id: "DE1", street: null },
  ];
  routes["GET /api/settings"] = [
    200,
    {
      company_id: 1,
      default_locale: "en",
      datev_skr: "04",
      einvoice_format: null,
      currency: "EUR",
    },
  ];
  const org = await getOrganizationSettings();
  expect(org).toMatchObject({
    name: "ACME",
    country: "DE",
    vatin: "DE1",
    street: "",
    address: "",
    einvoice_format: "plain",
    default_locale: "en",
    datev_skr: "04",
  });
  expect("currency" in org).toBe(false);

  await saveOrganizationSettings({ ...org, address: "x", country: "" });
  const [company, settings] = calls.filter((c) => c.method === "PATCH");
  expect(company.path).toBe("/api/company");
  expect(company.body).toMatchObject({ name: "ACME", vat_id: "DE1" });
  expect(
    ["address", "vatin", "country", "country_code", "default_locale"].some(
      (k) => k in company.body,
    ),
  ).toBe(false);
  expect(settings.path).toBe("/api/settings");
  expect(Object.keys(settings.body).sort()).toEqual([
    "datev_client_number",
    "datev_consultant_number",
    "datev_private_accounts",
    "datev_skr",
    "default_legal_country",
    "default_locale",
    "einvoice_format",
  ]);
});

test("free-text country goes to the server as ISO code", async () => {
  const org = await getOrganizationSettings();
  for (const [country, code] of [
    ["Deutschland", "DE"],
    ["at", "AT"],
    ["Österreich", "AT"],
    ["Mars", "NL"], // unknown: the legal country
  ]) {
    calls.length = 0;
    await saveOrganizationSettings({
      ...org,
      country,
      default_legal_country: "NL",
    });
    expect(
      calls.find((c) => c.path === "/api/company" && c.method === "PATCH")!.body
        .country_code,
    ).toBe(code);
  }
});

test("lowering the invoice incrementor surfaces a readable error", async () => {
  routes["PATCH /api/settings"] = [409, { error: "incrementor_decrease" }];
  const data = {
    currency: "EUR",
    decimal_places: 2,
    days_till_due: 14,
    due_surcharge: 0,
    notes: "",
    invoice_number_format: "RE-{COUNT}",
    invoice_number_incrementor: 1,
    company_logo_data_url: null,
  };
  await expect(saveInvoiceSettings(data)).rejects.toThrow("Rechnungsnummer");
});
