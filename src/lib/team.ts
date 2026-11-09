// Cloud team management (bookie-server src/api/members.ts). Money goes over
// the wire in cents; the UI works in euros.

import { api } from "$lib/cloud";
import { getLocaleFormatting, t, tp } from "$lib/i18n";

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

/** Grant presets for invites (label = i18n key); the admin can still change grants per member later. */
export const PRESETS: Record<string, { label: string; grants: Grant[] }> = {
  member: { label: "teamSettings.presetMember", grants: [] },
  bookkeeper: {
    label: "teamSettings.presetBookkeeper",
    grants: (["invoices", "incoming_invoices", "reports", "recurring"] as const).map((area) => ({ area, level: "edit" })),
  },
  advisor: {
    label: "teamSettings.presetAdvisor",
    grants: (["invoices", "incoming_invoices", "reports"] as const).map((area) => ({ area, level: "view" })),
  },
  lead: {
    label: "teamSettings.presetLead",
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
  /** Set when the member handed this month in and nobody approved or returned it since. */
  submitted_at: string | null;
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
export type MyHours = { projects: HoursRow[]; rejection: Rejection | null; submitted_at: string | null };

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

/** One team action (`action`/`data` of GET /api/feed rows, see describe()). */
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
  if (!Number.isFinite(n) || n < 0) throw new Error(t("teamSettings.invalidAmount"));
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

/** The caller hands their own month in for approval. */
export const submitMonth = (month: string) => api("/api/time-entries/submit", "POST", { month });

/** Months with unapproved hours per member (needs team_time edit). */
export const pendingApprovals = () => api<PendingRow[]>("/api/time-entries/pending");

/** Sends an unapproved month back to the member with a reason (mailed to them). */
export const rejectMonth = (userId: number, month: string, reason: string) =>
  api("/api/time-entries/reject", "POST", { user_id: userId, month, reason });

/** Needs team_time or reports view. */
export const teamReport = (month: string) =>
  api<TeamRow[]>(`/api/reports/team?month=${encodeURIComponent(month)}`);

export const projectProgress = () => api<ProjectProgress[]>("/api/projects/progress");

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

/** A vacation request (bookie-server src/api/leave.ts). Never for subcontractors. */
export type LeaveRequest = {
  id: number;
  user_id: number;
  user_name: string;
  start_date: string;
  end_date: string;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
  created_at: string;
};

/** Admin: the whole team's requests; everyone else: their own. */
export const listLeave = () => api<LeaveRequest[]>("/api/leave");

export const requestLeave = (start_date: string, end_date: string, note: string) =>
  api<{ id: number }>("/api/leave", "POST", { start_date, end_date, note });

/** Own request, any status; to change a period delete it and request anew. */
export const deleteLeave = (id: number) => api(`/api/leave/${id}`, "DELETE");

/** Admin only; rejecting needs a reason (mailed to the person). */
export const decideLeave = (id: number, approve: boolean, reason = "") =>
  api<{ ok: true; status: LeaveRequest["status"] }>(`/api/leave/${id}/decision`, "POST", { approve, reason });

/** Mon–Fri between two YYYY-MM-DD days, both included. ponytail: ignores public holidays; add a per-country list when someone books leave over one. */
export function workdays(start: string, end: string): number {
  let n = 0;
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1))
    if (d.getUTCDay() % 6) n++;
  return n;
}

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
  new Date(`${month}-01T00:00:00`).toLocaleDateString(getLocaleFormatting(), { month: "long", year: "numeric" });

/** "2026-12-21" -> "21.12.2026" (de) */
export const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(getLocaleFormatting(), { day: "2-digit", month: "2-digit", year: "numeric" });

const ROLE_KEYS: Record<Role, string> = { admin: "shell.roleAdmin", member: "shell.roleMember", subcontractor: "shell.roleSubcontractor" };
const roleName = (r: unknown) => (ROLE_KEYS[r as Role] ? t(ROLE_KEYS[r as Role]) : String(r));

// ponytail: tp() replaces each placeholder once; every key here uses each at most once.
const FEED_KEYS: Record<string, string> = {
  "invite.create": "inviteCreate", "invite.revoke": "inviteRevoke", "invite.accept": "inviteAccept",
  "member.role": "memberRole", "member.rate": "memberRate", "member.remove": "memberRemove",
  "member.grants": "memberGrants", "member.admin": "memberAdmin",
  "assign.add": "assignAdd", "assign.remove": "assignRemove",
  "month.approve": "monthApprove", "month.unapprove": "monthUnapprove", "month.submit": "monthSubmit",
  "month.withdraw": "monthWithdraw", "month.reject": "monthReject",
  "leave.request": "leaveRequest", "leave.approve": "leaveApprove", "leave.reject": "leaveReject",
};

/** One feed row as a sentence in the current locale; projectName resolves assignment rows. */
export function describe(
  a: Pick<Activity, "action" | "actor_name" | "subject_name" | "data">,
  projectName: (id: number) => string = (id) => `#${id}`): string {
  const d = a.data;
  const key = a.action === "leave.delete" ? (d.status === "approved" ? "leaveDeleteApproved" : "leaveDelete") : FEED_KEYS[a.action];
  if (!key) return `${a.actor_name}: ${a.action}`;
  const grants = (d.grants as Grant[] | undefined) ?? [];
  return tp(`feed.${key}`, {
    who: a.actor_name,
    whom: a.subject_name ?? t("feed.someone"),
    email: String(d.email ?? ""),
    role: roleName(d.role),
    project: d.project_id == null ? "" : projectName(d.project_id),
    month: d.month ? monthLabel(d.month) : "",
    start: d.start_date ? dayLabel(d.start_date) : "",
    end: d.end_date ? dayLabel(d.end_date) : "",
    reason: String(d.reason ?? ""),
    list: grants.length
      ? grants.map((g) => `${t(`feed.areas.${g.area}`)}${g.level === "view" ? t("feed.readOnly") : ""}`).join(", ")
      : t("feed.none"),
  });
}
