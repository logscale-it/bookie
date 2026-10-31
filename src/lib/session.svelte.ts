// Cloud mode: the signed-in user and the active company (GET /me), loaded once
// at boot by the root layout and shared by the shell and pages. Local mode:
// `me` stays null and can() allows everything (one user, one file).

import { api, cloud, type Me } from "$lib/cloud";
import type { Area } from "$lib/team";

let _me = $state<Me | null>(null);

export const session = {
  get me(): Me | null {
    return _me;
  },
  /** The active company with the caller's role, or undefined (local mode, none yet). */
  get company() {
    return _me?.companies.find((c) => c.id === _me?.activeCompanyId);
  },
};

/** Reloads /me (after billing, 2FA or company changes) and returns it. */
export async function refreshMe(): Promise<Me> {
  return (_me = await api<Me>("/me"));
}

/** Boot: best effort, a failing server must not block the shell. */
export async function loadSession(): Promise<void> {
  if (cloud()) await refreshMe().catch(() => {});
}

/** Mirrors bookie-server authz can(): admin all, subcontractor nothing, else grants (edit implies view). */
export function can(area: Area, level: "view" | "edit" = "view"): boolean {
  if (!cloud()) return true;
  const role = session.company?.role;
  if (role === "admin") return true;
  if (role !== "member") return false;
  const g = _me?.active?.grants[area];
  return g === "edit" || g === level;
}

/** Name of a company member by user id ("" when unknown, e.g. a removed member). */
export const memberName = (id: number | null | undefined) =>
  _me?.active?.members.find((m) => m.id === id)?.name ?? "";

/** "Anna Berger" -> "AB". */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";
