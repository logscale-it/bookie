import { test, expect } from "bun:test";
import { createTestDb } from "./harness";

test("harness applies all up-migrations and creates expected tables", () => {
  const db = createTestDb();
  const rows = db.raw
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = new Set(rows.map((r) => r.name));

  for (const expected of [
    "companies",
    "customers",
    "projects",
    "invoices",
    "invoice_items",
    "time_entries",
    "payments",
    "invoice_status_history",
    "incoming_invoices",
    "settings_organization",
    "settings_invoice",
    "settings_s3",
  ]) {
    expect(names.has(expected)).toBe(true);
  }
});

test("foreign keys are enforced", () => {
  const db = createTestDb();
  expect(() =>
    db.raw.exec(
      "INSERT INTO customers (company_id, name) VALUES (999, 'orphan')",
    ),
  ).toThrow();
});

test("plugin-sql adapter: select with $1 positional params", async () => {
  const db = createTestDb();
  await db.execute(
    "INSERT INTO companies (name, country_code) VALUES ($1, $2)",
    ["Acme", "DE"],
  );
  const rows = await db.select<{ id: number; name: string }[]>(
    "SELECT id, name FROM companies WHERE name = $1",
    ["Acme"],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("Acme");
});

test("plugin-sql adapter: execute returns lastInsertId and rowsAffected", async () => {
  const db = createTestDb();
  const r1 = await db.execute(
    "INSERT INTO companies (name) VALUES ($1)",
    ["First"],
  );
  expect(r1.lastInsertId).toBe(1);
  expect(r1.rowsAffected).toBe(1);
  const r2 = await db.execute(
    "INSERT INTO companies (name) VALUES ($1)",
    ["Second"],
  );
  expect(r2.lastInsertId).toBe(2);
});
