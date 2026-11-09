import { afterAll, expect, test } from "bun:test";
import * as team from "$lib/team";
import { setLocale } from "$lib/i18n";

const saved = {
  localStorage: (globalThis as any).localStorage,
  fetch: globalThis.fetch,
};
afterAll(() => Object.assign(globalThis, saved));
const calls: { path: string; method: string; body?: any }[] = [];
(globalThis as any).localStorage = {
  getItem: () => JSON.stringify({ url: "http://s", token: "t", email: "e" }),
  removeItem: () => {},
};
globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({
    path: url.slice("http://s".length),
    method: init.method ?? "GET",
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as any;

test("toCents parses German and plain euro input", () => {
  expect(team.toCents("55,50")).toBe(5550);
  expect(team.toCents(12.345)).toBe(1235);
  expect(team.toCents(" ")).toBeNull();
  expect(team.toCents(null)).toBeNull();
  expect(() => team.toCents("abc")).toThrow();
  expect(() => team.toCents("-1")).toThrow();
});

test("wrappers send the server's request shapes", async () => {
  await team.invite("a@b.de", "subcontractor", "50");
  await team.invite("c@b.de", "member", "50", team.PRESETS.advisor.grants);
  await team.acceptInvitation("http://x/invite?token=abc");
  await team.setCostRate(7, "60,25");
  await team.setCostRate(7, "");
  await team.setRole(7, "subcontractor");
  await team.setGrants(7, [{ area: "invoices", level: "edit" }]);
  await team.removeMember(7);
  await team.assign(3, 7);
  await team.unassign(3, 7);
  await team.approveMonth(7, "2026-09");
  await team.unapproveMonth(7, "2026-09");
  await team.teamReport("2026-09");
  await team.listInvitations();
  await team.revokeInvitation(4);
  await team.myHours("2026-09");
  await team.myAssignments();
  await team.linkProject(3, 9);
  await team.unlinkProject(3);
  await team.makeAdmin(7);
  await team.pendingApprovals();
  await team.rejectMonth(7, "2026-09", "Projekt fehlt");
  await team.projectProgress();
  expect(calls).toEqual([
    {
      path: "/api/invitations",
      method: "POST",
      body: { email: "a@b.de", role: "subcontractor", cost_rate_cents: 5000, grants: [] },
    },
    {
      path: "/api/invitations",
      method: "POST",
      body: {
        email: "c@b.de",
        role: "member",
        cost_rate_cents: null,
        grants: [
          { area: "invoices", level: "view" },
          { area: "incoming_invoices", level: "view" },
          { area: "reports", level: "view" },
        ],
      },
    },
    { path: "/api/invitations/accept", method: "POST", body: { token: "abc" } },
    {
      path: "/api/members/7",
      method: "PATCH",
      body: { cost_rate_cents: 6025 },
    },
    {
      path: "/api/members/7",
      method: "PATCH",
      body: { cost_rate_cents: null },
    },
    {
      path: "/api/members/7",
      method: "PATCH",
      body: { role: "subcontractor" },
    },
    {
      path: "/api/members/7/grants",
      method: "PUT",
      body: { grants: [{ area: "invoices", level: "edit" }] },
    },
    { path: "/api/members/7", method: "DELETE", body: undefined },
    {
      path: "/api/projects/3/assignments",
      method: "POST",
      body: { user_id: 7 },
    },
    {
      path: "/api/projects/3/assignments/7",
      method: "DELETE",
      body: undefined,
    },
    {
      path: "/api/time-entries/approve",
      method: "POST",
      body: { user_id: 7, month: "2026-09" },
    },
    {
      path: "/api/time-entries/approve",
      method: "DELETE",
      body: { user_id: 7, month: "2026-09" },
    },
    {
      path: "/api/reports/team?month=2026-09",
      method: "GET",
      body: undefined,
    },
    { path: "/api/invitations", method: "GET", body: undefined },
    { path: "/api/invitations/4", method: "DELETE", body: undefined },
    { path: "/api/me/hours?month=2026-09", method: "GET", body: undefined },
    { path: "/api/me/assignments", method: "GET", body: undefined },
    {
      path: "/api/project-links",
      method: "PUT",
      body: { source_project_id: 3, project_id: 9 },
    },
    { path: "/api/project-links/3", method: "DELETE", body: undefined },
    { path: "/api/members/7/admin", method: "POST", body: undefined },
    { path: "/api/time-entries/pending", method: "GET", body: undefined },
    {
      path: "/api/time-entries/reject",
      method: "POST",
      body: { user_id: 7, month: "2026-09", reason: "Projekt fehlt" },
    },
    { path: "/api/projects/progress", method: "GET", body: undefined },
  ]);
});

test("summarize folds project rows into one total per person", () => {
  const row = (user_id: number, project_id: number, minutes: number) => ({
    user_id,
    user_name: `U${user_id}`,
    role: "member" as const,
    project_id,
    project_name: `P${project_id}`,
    minutes,
    approved_minutes: minutes / 2,
    invoiced_minutes: 0,
    cost_cents: minutes * 10,
    revenue_cents: minutes * 20,
  });
  const out = team.summarize([row(1, 1, 60), row(1, 2, 30), row(2, 1, 120)]);
  expect(
    out.map((s) => [
      s.user_id,
      s.minutes,
      s.approved_minutes,
      s.cost_cents,
      s.revenue_cents,
      s.projects.length,
    ]),
  ).toEqual([
    [1, 90, 45, 900, 1800, 2],
    [2, 120, 60, 1200, 2400, 1],
  ]);
});

test("describe turns feed rows into German sentences", () => {
  const a = (action: string, data: Record<string, any> = {}): team.Activity => ({
    id: 1, action, actor_id: 1, actor_name: "Anna", subject_user_id: 2, subject_name: "Ben", data, created_at: "",
  });
  expect(team.describe(a("month.approve", { month: "2026-03" }))).toBe("Anna hat März 2026 von Ben freigegeben");
  expect(team.describe(a("month.reject", { month: "2026-03", reason: "Projekt fehlt" }))).toBe(
    "Anna hat März 2026 an Ben zurückgegeben: „Projekt fehlt“",
  );
  expect(team.describe(a("member.grants", { grants: [{ area: "reports", level: "view" }] }))).toBe(
    "Anna hat die Rechte von Ben gesetzt: Berichte (lesen)",
  );
  expect(team.describe(a("assign.add", { project_id: 3 }), () => "Website")).toBe(
    "Anna hat Ben dem Projekt Website zugewiesen",
  );
  expect(team.describe(a("invite.create", { email: "x@y.de", role: "subcontractor" }))).toBe(
    "Anna hat x@y.de als Subunternehmer eingeladen",
  );
  expect(team.describe(a("something.new"))).toBe("Anna: something.new");
  expect(team.describe(a("month.reject", { month: "2026-03", reason: "kostet $& mehr" }))).toBe(
    "Anna hat März 2026 an Ben zurückgegeben: „kostet $& mehr“",
  );
  setLocale("en");
  try {
    expect(team.describe(a("month.approve", { month: "2026-03" }))).toBe("Anna approved March 2026 of Ben");
  } finally {
    setLocale("de");
  }
});
