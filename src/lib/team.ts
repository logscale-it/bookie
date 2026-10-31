// Cloud team management (bookie-server src/api/members.ts). Money goes over
// the wire in cents; the UI works in euros.

import { api } from "$lib/cloud";

export type Role = "admin" | "member" | "subcontractor";

// Must match Area in bookie-server src/types.ts.
export const AREAS = [
  "invoices",
  "incoming_invoices",
  "reports",
  "recurring",
  "team_time",
  "settings",
] as const;
export type Area = (typeof AREAS)[number];
export type Grant = { area: Area; level: "view" | "edit" };

/** Grant presets for invites; the admin can still change grants per member later. */
export const PRESETS: Record<string, { label: string; grants: Grant[] }> = {
  member: { label: "Mitarbeiter (nur eigene Zeiten und Belege)", grants: [] },
  bookkeeper: {
    label: "Buchhaltung",
    grants: (["invoices", "incoming_invoices", "reports", "recurring"] as const).map((area) => ({ area, level: "edit" })),
  },
  advisor: {
    label: "Steuerberater (nur lesen)",
    grants: (["invoices", "incoming_invoices", "reports"] as const).map((area) => ({ area, level: "view" })),
  },
  lead: {
    label: "Teamleitung (Zeiten freigeben)",
    grants: [{ area: "team_time", level: "edit" }, { area: "reports", level: "view" }],
  },
};

export type TeamMember = {
  user_id: number;
  name: string;
  email: string;
  role: Role;
  cost_rate_cents: number | null;
  created_at: string;
  grants: Grant[];
  project_ids: number[];
};

export type Invitation = {
  id: number;
  email: string;
  role: "member" | "subcontractor";
  cost_rate_cents: number | null;
  grants: Grant[];
  expires_at: string;
  accepted_at: string | null;
  status: "pending" | "accepted" | "expired";
};

/** A member's month with unapproved hours (GET /api/time-entries/pending). */
export type PendingRow = {
  user_id: number;
  user_name: string;
  month: string;
  minutes: number;
  entries: number;
};

/** The caller's own hours (GET /api/me/hours). */
export type HoursRow = {
  project_id: number | null;
  project_name: string | null;
  minutes: number;
  approved_minutes: number;
};
/** A month sent back by a team lead; null once approved again. */
export type Rejection = { reason: string; at: string; by: string };
export type MyHours = { projects: HoursRow[]; rejection: Rejection | null };

/** A client project the caller works on as a subcontractor (GET /api/me/assignments). */
export type Assignment = {
  company_id: number;
  company_name: string;
  project_id: number;
  project_name: string;
  linked_company_id: number | null;
  linked_project_id: number | null;
};

/** One person × project in a month (GET /api/reports/team). Money only with the reports grant. */
export type TeamRow = {
  user_id: number;
  user_name: string;
  role: Role | null; // null = no longer a member
  project_id: number | null;
  project_name: string | null;
  minutes: number;
  approved_minutes: number;
  invoiced_minutes: number;
  cost_cents?: number;
  revenue_cents?: number;
};

/** All-time hours of a project (GET /api/projects/progress). */
export type ProjectProgress = {
  project_id: number;
  minutes: number;
  approved_minutes: number;
  invoiced_minutes: number;
};

/** One team action (GET /api/activity). */
export type Activity = {
  id: number;
  action: string;
  actor_id: number;
  actor_name: string;
  subject_user_id: number | null;
  subject_name: string | null;
  data: Record<string, any>;
  created_at: string;
};

/** Euro input ("12,50", 12.5; empty = none) -> whole cents. */
export function toCents(eur: string | number | null): number | null {
  if (eur == null || String(eur).trim() === "") return null;
  const n = Number(String(eur).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw new Error("Ungültiger Betrag");
  return Math.round(n * 100);
}

export const invite = (
  email: string,
  role: "member" | "subcontractor",
  costRateEur: string | number | null = null,
  grants: Grant[] = [],
) =>
  api<{ id: number }>("/api/invitations", "POST", {
    email,
    role,
    cost_rate_cents: role === "subcontractor" ? toCents(costRateEur) : null,
    grants: role === "member" ? grants : [],
  });

export const listInvitations = () => api<Invitation[]>("/api/invitations");

/** Open or expired invites only; accepted ones stay as history. */
export const revokeInvitation = (id: number) =>
  api(`/api/invitations/${id}`, "DELETE");

/** Takes the bare token or the whole invite link (…/invite?token=…). */
export const acceptInvitation = (tokenOrLink: string) =>
  api<{ companyId: number }>("/api/invitations/accept", "POST", {
    token: tokenOrLink.trim().replace(/^.*[?&]token=/, ""),
  });

export const listMembers = () => api<TeamMember[]>("/api/members");

export const setCostRate = (userId: number, eur: string | number | null) =>
  api(`/api/members/${userId}`, "PATCH", { cost_rate_cents: toCents(eur) });

/** member <-> subcontractor; becoming a subcontractor drops all grants. */
export const setRole = (userId: number, role: "member" | "subcontractor") =>
  api(`/api/members/${userId}`, "PATCH", { role });

/** Replaces all grants of a member (not admin, not subcontractor). */
export const setGrants = (userId: number, grants: Grant[]) =>
  api(`/api/members/${userId}/grants`, "PUT", { grants });

/** Hands the admin role to a plain member; the caller stays a member with edit on every area. */
export const makeAdmin = (userId: number) =>
  api(`/api/members/${userId}/admin`, "POST");

export const removeMember = (userId: number) =>
  api(`/api/members/${userId}`, "DELETE");

export const listAssignments = (projectId: number) =>
  api<number[]>(`/api/projects/${projectId}/assignments`);

export const assign = (projectId: number, userId: number) =>
  api(`/api/projects/${projectId}/assignments`, "POST", { user_id: userId });

export const unassign = (projectId: number, userId: number) =>
  api(`/api/projects/${projectId}/assignments/${userId}`, "DELETE");

/** month = "YYYY-MM" */
export const approveMonth = (userId: number, month: string) =>
  api<{ approved: number }>("/api/time-entries/approve", "POST", {
    user_id: userId,
    month,
  });

export const unapproveMonth = (userId: number, month: string) =>
  api<{ unapproved: number }>("/api/time-entries/approve", "DELETE", {
    user_id: userId,
    month,
  });

/** Months with unapproved hours per member (needs team_time edit). */
export const pendingApprovals = () => api<PendingRow[]>("/api/time-entries/pending");

/** Sends an unapproved month back to the member with a reason (mailed to them). */
export const rejectMonth = (userId: number, month: string, reason: string) =>
  api("/api/time-entries/reject", "POST", { user_id: userId, month, reason });

/** Needs team_time or reports view. */
export const teamReport = (month: string) =>
  api<TeamRow[]>(`/api/reports/team?month=${encodeURIComponent(month)}`);

export const projectProgress = () => api<ProjectProgress[]>("/api/projects/progress");

/** Newest first; pass the last id to page back. */
export const activity = (before?: number) =>
  api<Activity[]>(`/api/activity${before ? `?before=${before}` : ""}`);

/** month = "YYYY-MM"; the caller's own hours per project in the active company. */
export const myHours = (month: string) =>
  api<MyHours>(`/api/me/hours?month=${encodeURIComponent(month)}`);

/** Client projects across all companies, with the own project their hours mirror into. */
export const myAssignments = () => api<Assignment[]>("/api/me/assignments");

/** Mirrors the caller's hours on a client project into an own project of the active company. */
export const linkProject = (sourceProjectId: number, projectId: number) =>
  api<{ ok: true; mirrored: number }>("/api/project-links", "PUT", {
    source_project_id: sourceProjectId,
    project_id: projectId,
  });

/** Drops the link; copies already on an invoice stay. */
export const unlinkProject = (sourceProjectId: number) =>
  api(`/api/project-links/${sourceProjectId}`, "DELETE");

export type TeamSummary = {
  user_id: number;
  user_name: string;
  role: Role | null;
  minutes: number;
  approved_minutes: number;
  invoiced_minutes: number;
  cost_cents: number;
  revenue_cents: number;
  projects: TeamRow[];
};

/** Report rows (one per person × project) -> one summary per person, report order kept. */
export function summarize(rows: TeamRow[]): TeamSummary[] {
  const by = new Map<number, TeamSummary>();
  for (const r of rows) {
    const s =
      by.get(r.user_id) ??
      by
        .set(r.user_id, {
          user_id: r.user_id,
          user_name: r.user_name,
          role: r.role,
          minutes: 0,
          approved_minutes: 0,
          invoiced_minutes: 0,
          cost_cents: 0,
          revenue_cents: 0,
          projects: [],
        })
        .get(r.user_id)!;
    s.minutes += r.minutes;
    s.approved_minutes += r.approved_minutes;
    s.invoiced_minutes += r.invoiced_minutes;
    s.cost_cents += r.cost_cents ?? 0;
    s.revenue_cents += r.revenue_cents ?? 0;
    s.projects.push(r);
  }
  return [...by.values()];
}

export const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString("de-DE", { month: "long", year: "numeric" });

const AREA_NAMES: Record<Area, string> = {
  invoices: "Rechnungen",
  incoming_invoices: "Eingangsrechnungen",
  reports: "Berichte",
  recurring: "Wiederkehrend",
  team_time: "Team-Zeiten",
  settings: "Einstellungen",
};
const ROLE_NAMES: Record<Role, string> = { admin: "Admin", member: "Mitglied", subcontractor: "Subunternehmer" };

/** One feed row as a German sentence; projectName resolves assignment rows. */
export function describe(a: Activity, projectName: (id: number) => string = (id) => `#${id}`): string {
  const who = a.actor_name;
  const whom = a.subject_name ?? "jemand";
  const d = a.data;
  switch (a.action) {
    case "invite.create": return `${who} hat ${d.email} als ${ROLE_NAMES[d.role as Role] ?? d.role} eingeladen`;
    case "invite.revoke": return `${who} hat die Einladung an ${d.email} widerrufen`;
    case "invite.accept": return `${who} ist als ${ROLE_NAMES[d.role as Role] ?? d.role} beigetreten`;
    case "member.role": return `${who} hat ${whom} zum ${ROLE_NAMES[d.role as Role] ?? d.role} gemacht`;
    case "member.rate": return `${who} hat den Kostensatz von ${whom} geändert`;
    case "member.remove": return `${who} hat ${whom} entfernt`;
    case "member.grants": {
      const list = (d.grants as Grant[] | undefined) ?? [];
      return `${who} hat die Rechte von ${whom} gesetzt: ${
        list.length ? list.map((g) => `${AREA_NAMES[g.area]}${g.level === "view" ? " (lesen)" : ""}`).join(", ") : "keine"
      }`;
    }
    case "member.admin": return `${who} hat die Admin-Rolle an ${whom} übergeben`;
    case "assign.add": return `${who} hat ${whom} dem Projekt ${projectName(d.project_id)} zugewiesen`;
    case "assign.remove": return `${who} hat ${whom} vom Projekt ${projectName(d.project_id)} abgezogen`;
    case "month.approve": return `${who} hat ${monthLabel(d.month)} von ${whom} freigegeben`;
    case "month.unapprove": return `${who} hat die Freigabe ${monthLabel(d.month)} von ${whom} zurückgenommen`;
    case "month.reject": return `${who} hat ${monthLabel(d.month)} an ${whom} zurückgegeben: „${d.reason}“`;
    default: return `${who}: ${a.action}`;
  }
}
