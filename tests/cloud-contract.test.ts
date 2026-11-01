// Contract test against a live bookie-server from the sibling checkout
// (../bookie-server); skipped when it is not there.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createTestDb } from "./db/harness";
import { __setDbForTesting } from "$lib/db/connection";
import { getActionItems, getDashboardData } from "$lib/db/dashboard";
import { listActivity } from "$lib/db/activity";
import { getEuerData, getEuerReport, getUstvaData } from "$lib/db/tax-reports";
import { getDatevBookingRows } from "$lib/db/datev";
import * as inc from "$lib/db/incoming-invoices";
import { buildImport, pushImport } from "$lib/cloud-import";
import * as rec from "$lib/db/recurring";
import {
  createInvoice,
  getInvoiceById,
  issueInvoice,
  listInvoices,
  syncInvoiceItems,
  updateInvoicePaidDate,
  updateInvoiceStatus,
} from "$lib/db/invoices";

const savedStorage = (globalThis as any).localStorage;
afterAll(() => ((globalThis as any).localStorage = savedStorage));

const SERVER = `${import.meta.dir}/../../bookie-server`;
const has = existsSync(`${SERVER}/index.ts`);
Bun.env.AUTH_ENC_KEY ??= randomBytes(32).toString("base64");
const load = (p: string) => (has ? import(`${SERVER}/${p}`) : ({} as any));
const { startServer } = await load("index.ts");
const { testDb } = await load("test/helpers.ts");
const { createSession, hashPassword } = await load("src/auth.ts");
const { runDue } = await load("src/api/recurring.ts");

test.skipIf(!has)(
  "cloud reports equal local reports for the same data",
  async () => {
    const sdb = await testDb();
    const server = startServer(sdb, 0);
    const ldb = createTestDb();
    __setDbForTesting(ldb);
    let session: string | null = null;
    (globalThis as any).localStorage = {
      getItem: () => session,
      removeItem() {},
    };

    const [u] =
      await sdb.sql`INSERT INTO users (email, name, password_hash) VALUES ('p@x.de', 'U', ${await hashPassword("x")}) RETURNING id`;
    await sdb.sql`INSERT INTO companies (id, name, subscription_status) VALUES (1, 'C', 'active')`;
    // Signup inserts this row; the server no longer creates it lazily.
    await sdb.sql`INSERT INTO company_settings (company_id) VALUES (1)`;
    await sdb.sql`INSERT INTO company_members (company_id, user_id, role) VALUES (1, ${u.id}, 'admin')`;
    await ldb.execute(
      "INSERT INTO companies (id, name, country_code) VALUES (1, 'C', 'DE')",
    );
    const both = async (table: string, row: Record<string, unknown>) => {
      const k = Object.keys(row);
      await ldb.execute(
        `INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map((_, i) => `$${i + 1}`).join(",")})`,
        Object.values(row),
      );
      await sdb.sql`INSERT INTO ${sdb.sql(table)} ${sdb.sql(row)}`;
    };
    await both("customers", {
      id: 1,
      company_id: 1,
      name: "Kunde",
      type: "kunde",
    });
    await both("customers", {
      id: 2,
      company_id: 1,
      name: "Lieferant",
      type: "lieferant",
    });
    const y = new Date().getFullYear();
    let iid = 0,
      itid = 0;
    const inv = async (
      status: string,
      issue: string,
      items: [number, number][],
      o: Record<string, unknown> = {},
    ) => {
      const net = items.reduce((a, [x]) => a + x, 0),
        tax = Math.round(items.reduce((a, [x, r]) => a + (x * r) / 100, 0));
      const id = ++iid;
      await both("invoices", {
        id,
        company_id: 1,
        customer_id: 1,
        invoice_number: `RE${id}`,
        status,
        issue_date: issue,
        net_cents: net,
        tax_cents: tax,
        gross_cents: net + tax,
        recipient_name: "Kunde",
        ...o,
      });
      for (const [x, r] of items)
        await both("invoice_items", {
          id: ++itid,
          invoice_id: id,
          description: "x",
          quantity: 1,
          unit_price_net_cents: x,
          tax_rate: r,
          line_total_net_cents: x,
        });
    };
    await inv(
      "sent",
      `${y}-01-15`,
      [
        [10000, 19],
        [5000, 7],
      ],
      { due_date: `${y}-02-01` },
    );
    await inv("paid", `${y}-02-10`, [[20000, 19]], { paid_date: `${y}-02-12` });
    await inv("paid", `${y - 1}-12-20`, [[3333, 19]], {
      paid_date: `${y}-01-03`,
    });
    await inv("sent", `${y}-03-05`, [[-20000, 19]]);
    await inv("void", `${y}-01-20`, [[100000, 19]]);
    await inv("draft", `${y}-01-25`, [[30000, 0]]);
    await inv("paid", `${y}-04-01`, [[8000, 0]], { paid_date: `${y}-05-01` });
    await both("incoming_invoices", {
      id: 1,
      company_id: 1,
      supplier_id: 2,
      invoice_number: "L-1",
      invoice_date: `${y}-01-10`,
      status: "offen",
      net_cents: 10000,
      tax_cents: 1900,
      gross_cents: 11900,
    });
    await both("incoming_invoices", {
      id: 2,
      company_id: 1,
      supplier_id: 2,
      invoice_date: `${y}-04-02`,
      paid_date: `${y}-04-20`,
      status: "bezahlt",
      net_cents: 5000,
      tax_cents: 350,
      gross_cents: 5350,
    });

    const all = async () => ({
      ...(await getDashboardData(1, y, "month")),
      q: await getDashboardData(1, y, "quarter"),
      actions: await getActionItems(1),
      ustva: await getUstvaData(1, y, "quarter"),
      euer: await getEuerData(1, y, "month"),
      euerReport: await getEuerReport(1, `${y}-01-01`, `${y}-06-30`),
      datev: await getDatevBookingRows(1, y),
    });
    try {
      const local = await all();
      session = JSON.stringify({
        url: server.url.origin,
        token: await createSession(sdb, Number(u.id)),
        email: "e",
      });
      const remote = await all();
      expect(remote).toEqual(local);
      expect(local.euer.length).toBeGreaterThan(0);
      expect(local.actions.overdue.count).toBe(1);
    } finally {
      __setDbForTesting(null);
      server.stop(true);
    }
  },
);

test.skipIf(!has)(
  "desktop cloud incoming + recurring against a live server",
  async () => {
    const db = await testDb();
    const server = startServer(db, 0);
    const [u] =
      await db.sql`INSERT INTO users (email, name, password_hash) VALUES ('e2e@x.de', 'U', ${await hashPassword("x")}) RETURNING id`;
    const [c] =
      await db.sql`INSERT INTO companies (name, subscription_status) VALUES ('C', 'active') RETURNING id`;
    await db.sql`INSERT INTO company_settings (company_id) VALUES (${c.id})`;
    await db.sql`INSERT INTO company_members (company_id, user_id, role) VALUES (${c.id}, ${u.id}, 'admin')`;
    const [s] =
      await db.sql`INSERT INTO customers (company_id, name, type) VALUES (${c.id}, 'Miete GmbH', 'lieferant') RETURNING id`;
    const token = await createSession(db, Number(u.id));
    (globalThis as any).localStorage = {
      getItem: () =>
        JSON.stringify({ url: server.url.origin, token, email: "e" }),
      removeItem() {},
    };
    try {
      const row = {
        company_id: 0,
        supplier_id: Number(s.id),
        invoice_number: "M-1",
        invoice_date: "2026-01-31",
        net_cents: 1000,
        tax_cents: 190,
        status: "offen",
        file_name: null,
        file_type: null,
        s3_key: null,
        local_path: null,
        notes: "Miete",
      };
      const id = await inc.createIncomingInvoice(row);
      await inc.createIncomingInvoice({
        ...row,
        invoice_date: "2026-02-01",
        status: "bezahlt",
      });
      const page: inc.PageResult<inc.IncomingInvoiceWithSupplier> =
        await inc.listIncomingInvoices(0, { limit: 1, offset: 0 });
      expect(page.totalCount).toBe(2);
      expect(page.rows[0]).toMatchObject({
        invoice_date: "2026-02-01",
        paid_date: "2026-02-01",
        gross_cents: 1190,
        supplier_name: "Miete GmbH",
      });
      await inc.updateIncomingInvoice(id, { tax_cents: 0 });
      await expect(
        inc.updateIncomingInvoicePaidDate(id, "2026-02-05"),
      ).rejects.toThrow("nur bei bezahlten");
      await inc.updateIncomingInvoiceStatus(id, "bezahlt");
      await inc.updateIncomingInvoicePaidDate(id, "2026-02-05");
      expect(await inc.getIncomingInvoiceById(id)).toMatchObject({
        gross_cents: 1000,
        status: "bezahlt",
        paid_date: "2026-02-05",
      });

      const snap = await rec.snapshotIncoming(id);
      await rec.createRecurring({
        company_id: 0,
        kind: "incoming",
        label: snap.label,
        frequency: "monthly",
        interval_count: 1,
        next_run_date: "2026-02-28",
        end_date: null,
        payload: snap.payload,
      });
      expect(await runDue(db, "2026-03-30")).toBe(2);
      const all = await inc.listIncomingInvoices(0);
      expect(all.rows.map((r) => r.invoice_date)).toEqual([
        "2026-03-28",
        "2026-02-28",
        "2026-02-01",
        "2026-01-31",
      ]);
      expect(all.rows[0]).toMatchObject({
        status: "offen",
        net_cents: 1000,
        supplier_id: Number(s.id),
      });

      const [k] =
        await db.sql`INSERT INTO customers (company_id, name, type) VALUES (${c.id}, 'Kunde', 'kunde') RETURNING id`;
      const invId = await createInvoice({
        company_id: 0,
        customer_id: Number(k.id),
        project_id: null,
        invoice_number: "",
        status: "draft",
        issue_date: "2026-01-15",
        due_date: "2026-01-29",
        currency: "EUR",
        recipient_name: "Kunde",
        language: "de",
        legal_country_code: "DE",
        delivery_date: "2026-01-15",
        due_surcharge: 0,
      } as any);
      await syncInvoiceItems(invId, [
        {
          description: "Wartung",
          quantity: 1,
          unit: "Std",
          unit_price_net_cents: 5000,
          tax_rate: 19,
        } as any,
      ]);
      const isnap = await rec.snapshotInvoice(invId);
      await rec.createRecurring({
        company_id: 0,
        kind: "invoice",
        label: isnap.label,
        frequency: "monthly",
        interval_count: 1,
        next_run_date: "2026-02-15",
        end_date: null,
        payload: isnap.payload,
      });
      expect(await runDue(db, "2026-02-20")).toBe(1);
      const invs = (await listInvoices(0)).rows;
      expect(invs.length).toBe(2);
      expect(invs.find((i) => i.issue_date === "2026-02-15")).toMatchObject({
        status: "draft",
        net_cents: 5000,
        customer_id: Number(k.id),
      });

      // Zufluss date correction on a paid invoice
      await expect(updateInvoicePaidDate(invId, "2026-01-20")).rejects.toThrow(
        "nur bei bezahlten",
      );
      await issueInvoice(invId);
      await updateInvoiceStatus(invId, "sent", "paid");
      await updateInvoicePaidDate(invId, "2026-01-20");
      expect(await getInvoiceById(invId)).toMatchObject({
        status: "paid",
        paid_date: "2026-01-20",
      });

      await inc.deleteIncomingInvoice(id);
      expect(await inc.getIncomingInvoiceById(id)).toBeUndefined();
    } finally {
      server.stop(true);
    }
  },
);

test.skipIf(!has)(
  "local incoming invoices and recurring entries import into an empty cloud company",
  async () => {
    const sdb = await testDb();
    const server = startServer(sdb, 0);
    const ldb = createTestDb();
    ldb.raw.exec(`
    INSERT INTO companies (id, name, country_code) VALUES (1, 'C', 'DE');
    INSERT INTO customers (id, company_id, name, country_code, type) VALUES (10, 1, 'Vermieter', 'DE', 'lieferant');
    INSERT INTO incoming_invoices (company_id, supplier_id, invoice_number, invoice_date, status, paid_date, net_cents, tax_cents, gross_cents, local_path)
      VALUES (1, 10, 'M-1', '2026-01-01', 'bezahlt', '2026-01-05', 1000, 190, 1190, '/x.pdf');
    INSERT INTO recurring_entries (company_id, kind, label, frequency, interval_count, next_run_date, payload)
      VALUES (1, 'incoming', 'Miete', 'monthly', 1, '2026-02-01', '{"company_id":1,"supplier_id":10,"invoice_number":"M","net_cents":1000,"tax_cents":190,"status":"offen","file_name":null,"file_type":null,"s3_key":null,"local_path":null,"notes":null}');
  `);
    const [u] =
      await sdb.sql`INSERT INTO users (email, name, password_hash) VALUES ('i@x.de', 'U', ${await hashPassword("x")}) RETURNING id`;
    const [c] =
      await sdb.sql`INSERT INTO companies (name, subscription_status) VALUES ('Cloud', 'active') RETURNING id`;
    await sdb.sql`INSERT INTO company_members (company_id, user_id, role) VALUES (${c.id}, ${u.id}, 'admin')`;
    const token = await createSession(sdb, Number(u.id));
    (globalThis as any).localStorage = {
      getItem: () =>
        JSON.stringify({ url: server.url.origin, token, email: "e" }),
      removeItem() {},
    };
    try {
      expect(await pushImport(await buildImport(ldb))).toMatchObject({
        customers: 1,
        incoming_invoices: 1,
        recurring_entries: 1,
      });
      const { rows } = await inc.listIncomingInvoices(0);
      expect(rows).toEqual([
        expect.objectContaining({
          invoice_number: "M-1",
          paid_date: "2026-01-05",
          supplier_name: "Vermieter",
          s3_key: null,
        }),
      ]);
      expect(await runDue(sdb, "2026-02-01")).toBe(1);
      expect((await inc.listIncomingInvoices(0)).rows[0]).toMatchObject({
        invoice_date: "2026-02-01",
        supplier_name: "Vermieter",
        status: "offen",
      });
    } finally {
      await ldb.close();
      server.stop(true);
    }
  },
);

test.skipIf(!has)(
  "customer DSGVO export bundle and refused erasure through the server",
  async () => {
    const { exportCustomerData } = await import("$lib/db/dsgvo_export");
    const { anonymizeCustomer } = await import("$lib/db/dsgvo_erasure");
    const sdb = await testDb();
    const server = startServer(sdb, 0);
    const [u] =
      await sdb.sql`INSERT INTO users (email, name, password_hash) VALUES ('d@x.de', 'U', ${await hashPassword("x")}) RETURNING id`;
    const [c] =
      await sdb.sql`INSERT INTO companies (name, subscription_status) VALUES ('C', 'active') RETURNING id`;
    await sdb.sql`INSERT INTO company_members (company_id, user_id, role) VALUES (${c.id}, ${u.id}, 'admin')`;
    const [k] =
      await sdb.sql`INSERT INTO customers (company_id, name, email) VALUES (${c.id}, 'Max', 'max@x.de') RETURNING id`;
    await sdb.sql`INSERT INTO invoices (company_id, customer_id, invoice_number, status, issue_date, gross_cents) VALUES (${c.id}, ${k.id}, 'RE-1', 'sent', '2026-01-01', 100)`;
    const token = await createSession(sdb, Number(u.id));
    (globalThis as any).localStorage = {
      getItem: () =>
        JSON.stringify({ url: server.url.origin, token, email: "e" }),
      removeItem() {},
    };
    try {
      const { textEntries, binaryEntries } = await exportCustomerData(
        Number(k.id),
      );
      const files = Object.fromEntries(textEntries);
      expect(JSON.parse(files["customer.json"]!)).toMatchObject({
        name: "Max",
        email: "max@x.de",
      });
      expect(JSON.parse(files["invoices.json"]!)).toHaveLength(1);
      expect(binaryEntries[0]![1].length).toBeGreaterThan(500); // the PDF
      await expect(anonymizeCustomer(Number(k.id))).rejects.toMatchObject({
        name: "RetentionViolation",
      });
    } finally {
      server.stop(true);
    }
  },
);

test.skipIf(!has)(
  "recurring schedules list, edit (anchored month end) and delete through the server",
  async () => {
    const sdb = await testDb();
    const server = startServer(sdb, 0);
    const [u] =
      await sdb.sql`INSERT INTO users (email, name, password_hash) VALUES ('r@x.de', 'U', ${await hashPassword("x")}) RETURNING id`;
    const [c] =
      await sdb.sql`INSERT INTO companies (name, subscription_status) VALUES ('C', 'active') RETURNING id`;
    await sdb.sql`INSERT INTO company_members (company_id, user_id, role) VALUES (${c.id}, ${u.id}, 'admin')`;
    const token = await createSession(sdb, Number(u.id));
    (globalThis as any).localStorage = {
      getItem: () =>
        JSON.stringify({ url: server.url.origin, token, email: "e" }),
      removeItem() {},
    };
    try {
      const id = await rec.createRecurring({
        company_id: 0,
        kind: "incoming",
        label: "Miete",
        frequency: "monthly",
        interval_count: 1,
        next_run_date: "2026-11-01",
        end_date: null,
        payload: { net_cents: 100000, tax_cents: 0 },
      });
      await rec.updateRecurring(id, {
        label: "Büro",
        next_run_date: "2026-01-31",
        end_date: "2026-12-31",
      });
      const [r] = await rec.listRecurring();
      expect(r).toMatchObject({
        id,
        label: "Büro",
        next_run_date: "2026-01-31",
      });
      expect(JSON.parse(r!.payload)).toMatchObject({ net_cents: 100000 });

      expect(await runDue(sdb, "2026-03-01")).toBe(2); // Jan 31, Feb 28
      expect((await rec.listRecurring())[0]!.next_run_date).toBe("2026-03-31");

      await rec.updateRecurring(id, { active: 0 });
      expect(await runDue(sdb, "2026-06-01")).toBe(0);
      await rec.deleteRecurring(id);
      expect(await rec.listRecurring()).toEqual([]);
    } finally {
      server.stop(true);
    }
  },
);

test.skipIf(!has)(
  "subcontractor hours at a client mirror into the own company and invoice at the own rate",
  async () => {
    const team = await import("$lib/team");
    const te = await import("$lib/db/time-entries");
    const { createInvoiceFromTimeEntries } = await import("$lib/db/invoices");
    const sdb = await testDb();
    const server = startServer(sdb, 0);
    const one = async (q: Promise<any[]>) => Number((await q)[0].id);
    const client = await one(
      sdb.sql`INSERT INTO companies (name, subscription_status) VALUES ('AG', 'active') RETURNING id`,
    );
    const own = await one(
      sdb.sql`INSERT INTO companies (name, subscription_status) VALUES ('SU', 'active') RETURNING id`,
    );
    const ag = await one(
      sdb.sql`INSERT INTO users (email, name, password_hash) VALUES ('ag@x.de', 'AG', ${await hashPassword("x")}) RETURNING id`,
    );
    const su = await one(
      sdb.sql`INSERT INTO users (email, name, password_hash) VALUES ('su@x.de', 'SU', ${await hashPassword("x")}) RETURNING id`,
    );
    await sdb.sql`INSERT INTO company_members (company_id, user_id, role) VALUES (${client}, ${ag}, 'admin'), (${own}, ${su}, 'admin')`;
    await sdb.sql`INSERT INTO company_members (company_id, user_id, role, cost_rate_cents) VALUES (${client}, ${su}, 'subcontractor', 4000)`;
    const cp = await one(
      sdb.sql`INSERT INTO projects (company_id, name, hourly_rate_cents) VALUES (${client}, 'Relaunch', 12000) RETURNING id`,
    );
    await sdb.sql`INSERT INTO project_assignments (company_id, project_id, user_id) VALUES (${client}, ${cp}, ${su})`;
    const oc = await one(
      sdb.sql`INSERT INTO customers (company_id, name) VALUES (${own}, 'AG') RETURNING id`,
    );
    const op = await one(
      sdb.sql`INSERT INTO projects (company_id, customer_id, name, hourly_rate_cents) VALUES (${own}, ${oc}, 'AG Relaunch', 7000) RETURNING id`,
    );
    const agToken = await createSession(sdb, ag);
    const ownToken = await createSession(sdb, su); // admin company first
    const atClient = await createSession(sdb, su);
    let token = atClient;
    (globalThis as any).localStorage = {
      getItem: () =>
        JSON.stringify({ url: server.url.origin, token, email: "e" }),
      removeItem() {},
    };
    try {
      const { api } = await import("$lib/cloud");
      await api("/session/company", "POST", { companyId: client });
      const [onClient] = await team.myAssignments();
      expect(onClient).toMatchObject({
        project_id: cp,
        linked_project_id: null,
      });
      const id = await te.createTimeEntry({
        company_id: 0,
        customer_id: null,
        project_id: cp,
        entry_date: "2026-10-05",
        started_at: null,
        ended_at: null,
        duration_minutes: 90,
        description: "Design",
        billable: 1,
      });

      token = ownToken;
      expect((await team.linkProject(cp, op)).mirrored).toBe(1);
      const [mirror] = (await te.listTimeEntries(0)).rows;
      expect(mirror).toMatchObject({
        source_entry_id: id,
        project_id: op,
        customer_id: oc,
        duration_minutes: 90,
      });
      await expect(
        te.updateTimeEntry(mirror!.id, { duration_minutes: 1 }),
      ).rejects.toMatchObject({ code: "locked" });
      await expect(
        createInvoiceFromTimeEntries({ customer_id: oc }),
      ).rejects.toMatchObject({ code: "no_entries" });

      token = agToken;
      expect((await team.approveMonth(su, "2026-10")).approved).toBe(1);

      token = ownToken;
      const invId = await createInvoiceFromTimeEntries({ customer_id: oc });
      const [item] =
        await sdb.sql`SELECT quantity, unit_price_net_cents, time_entry_id FROM invoice_items WHERE invoice_id = ${invId}`;
      expect([
        Number(item.quantity),
        Number(item.unit_price_net_cents),
        Number(item.time_entry_id),
      ]).toEqual([1.5, 7000, mirror!.id]);
    } finally {
      server.stop(true);
    }
  },
);

test.skipIf(!has)(
  "team overview: reject reaches the member, approval locks entries, report and project burn",
  async () => {
    const team = await import("$lib/team");
    const te = await import("$lib/db/time-entries");
    const pj = await import("$lib/db/projects");
    const { outbox } = await load("src/mail.ts");
    delete Bun.env.MAIL_API_KEY; // .env may carry the real key
    const sdb = await testDb();
    const server = startServer(sdb, 0);
    const one = async (q: Promise<any[]>) => Number((await q)[0].id);
    const c = await one(
      sdb.sql`INSERT INTO companies (name, subscription_status) VALUES ('Firma', 'active') RETURNING id`,
    );
    const user = (mail: string, name: string) =>
      one(
        sdb.sql`INSERT INTO users (email, name, password_hash) VALUES (${mail}, ${name}, 'x') RETURNING id`,
      );
    const boss = await user("boss@x.de", "Chefin");
    const ben = await user("ben@x.de", "Ben");
    await sdb.sql`INSERT INTO company_members (company_id, user_id, role) VALUES (${c}, ${boss}, 'admin'), (${c}, ${ben}, 'member')`;
    const bossToken = await createSession(sdb, boss);
    const benToken = await createSession(sdb, ben);
    await sdb.sql`UPDATE sessions SET company_id = ${c}`;
    let token = bossToken;
    (globalThis as any).localStorage = {
      getItem: () =>
        JSON.stringify({ url: server.url.origin, token, email: "e" }),
      removeItem() {},
    };
    try {
      const p = await pj.createProject({
        company_id: 0,
        customer_id: null,
        project_number: null,
        name: "Relaunch",
        description: null,
        status: "active",
        hourly_rate: 100,
        starts_on: null,
        ends_on: null,
        budget_minutes: 240,
        budget_cents: 50000,
      });
      expect(await pj.getProjectById(p)).toMatchObject({
        budget_minutes: 240,
        budget_cents: 50000,
      });

      token = benToken;
      const id = await te.createTimeEntry({
        company_id: 0,
        customer_id: null,
        project_id: p,
        entry_date: "2026-10-05",
        started_at: null,
        ended_at: null,
        duration_minutes: 120,
        description: "Design",
        billable: 1,
      });

      token = bossToken;
      await team.rejectMonth(ben, "2026-10", "Beschreibung fehlt");
      expect(outbox.at(-1)).toMatchObject({ to: "ben@x.de" });
      token = benToken;
      expect((await team.myHours("2026-10")).rejection).toMatchObject({
        reason: "Beschreibung fehlt",
        by: "Chefin",
      });

      token = bossToken;
      await team.approveMonth(ben, "2026-10");
      const [row] = (await te.listTimeEntries(0)).rows;
      expect(row?.approved_at).toBeTruthy();
      const [r] = team.summarize(await team.teamReport("2026-10"));
      expect(r).toMatchObject({
        user_name: "Ben",
        role: "member",
        minutes: 120,
        approved_minutes: 120,
        revenue_cents: 20000,
      });
      expect(await team.projectProgress()).toEqual([
        { project_id: p, minutes: 120, approved_minutes: 120, invoiced_minutes: 0 },
      ]);
      const feed = (await listActivity(10)).filter((i) => i.action);
      expect(feed.map((i) => team.describe({ action: i.action!, actor_name: i.actor_name!, subject_name: i.subject_name ?? null, data: i.data! }))).toEqual([
        "Chefin hat Oktober 2026 von Ben freigegeben",
        "Chefin hat Oktober 2026 an Ben zurückgegeben: „Beschreibung fehlt“",
      ]);

      token = benToken;
      expect((await team.myHours("2026-10")).rejection).toBeNull();
      await expect(
        te.updateTimeEntry(id, { duration_minutes: 1 }),
      ).rejects.toMatchObject({ code: "locked" });
    } finally {
      server.stop(true);
    }
  },
);
