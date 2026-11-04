// Cloud mode: signed in to a bookie-server, the ported db modules (companies,
// customers, projects, time entries) call its REST API instead of the local
// SQLite file, and every other local query refuses (see getDb), so local and
// cloud ids never mix.
//
// url and email live in localStorage, the session token in the OS keyring
// (loadCloudToken() fills `token` before the first cloud() call).

import { invoke } from "@tauri-apps/api/core";
import type { Area } from "$lib/team";
import { net } from "$lib/net.svelte";
import { toasts } from "$lib/ui/toasts.svelte";

const KEY = "bookie.cloud";

export type CloudSession = { url: string; token: string; email: string };

let token: string | null = null;
/** Boot could not read the keyring: signed out although url/email are saved. */
export let keyringError = false;

/** url/email of the last session (prefills the login form), even without a token. */
export function savedAccount(): { url: string; email: string } | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

export function cloud(): CloudSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    // s.token: a session from before the keyring move (loadCloudToken moves it), or tests.
    const t = token ?? s?.token;
    return s && t ? { url: s.url, email: s.email, token: t } : null;
  } catch {
    return null; // no localStorage (tests) = local mode
  }
}

// Keyring unavailable (e.g. no Secret Service on Linux): the token stays in
// memory only, so the session lasts until the app closes.
async function storeToken(t: string | null): Promise<boolean> {
  token = t;
  try {
    await invoke("set_cloud_token", { token: t });
    return true;
  } catch (e) {
    console.warn("[cloud] keyring", e);
    return false;
  }
}

/** Boot: loads the session token from the OS keyring; moves a legacy localStorage token there. */
export async function loadCloudToken(): Promise<void> {
  let s: { url: string; email: string; token?: string } | null;
  try {
    s = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return;
  }
  if (!s) return;
  if (s.token) {
    // Strip it from localStorage only once the keyring holds it.
    if (await storeToken(s.token))
      localStorage.setItem(KEY, JSON.stringify({ url: s.url, email: s.email }));
    return;
  }
  try {
    token = await invoke<string | null>("get_cloud_token");
  } catch (e) {
    keyringError = true;
    console.warn("[cloud] keyring", e);
  }
}

function signOut() {
  localStorage.removeItem(KEY);
  void storeToken(null);
}

export class CloudError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = status === 402
      ? "Kein aktives bookie Cloud Abo für dieses Unternehmen"
      : status === 403
        ? "Keine Berechtigung für diesen Bereich"
        : code === "conflict"
          ? "Wurde zwischenzeitlich von jemand anderem geändert"
          : `Server: ${status} ${code}`,
  ) {
    super(message);
  }
}

// Optimistic concurrency: the updated_at of each row as last loaded, keyed by
// its item path (/api/customers/5, /api/company). A PATCH to that path echoes
// it as expected_updated_at; the server answers 409 conflict when someone else
// wrote since. Keeps pages unaware of it.
// ponytail: last load wins; a list refetched elsewhere while a form is open refreshes the stamp.
const seen = new Map<string, string>();

function remember(path: string, method: string, data: any) {
  path = path.split("?")[0];
  const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : null;
  if (rows) {
    for (const r of rows) if (r?.updated_at && r.id != null) seen.set(`${path}/${r.id}`, r.updated_at);
  } else if (data?.updated_at) {
    seen.set(method === "POST" && data.id != null ? `${path}/${data.id}` : path, data.updated_at);
  }
}

async function request<T>(
  url: string,
  path: string,
  method: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  // Session / company switch: stamps of the previous company must not leak into the next.
  // The local import rewrites company_settings: stamps loaded before it are stale.
  if (method !== "GET" && (!path.startsWith("/api/") || path === "/api/import")) seen.clear();
  const expected = method === "PATCH" ? seen.get(path) : undefined;
  if (expected && body && typeof body === "object" && !(body instanceof Blob))
    body = { ...body, expected_updated_at: expected };
  // A Blob/File goes as the raw body with its own type (e.g. a receipt), anything else as JSON.
  const raw = body instanceof Blob;
  let res: Response;
  try {
    res = await fetch(url + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": raw ? (body as Blob).type : "application/json" }),
      },
      body: body === undefined ? undefined : raw ? (body as Blob) : JSON.stringify(body),
    });
  } catch (e) {
    // Network failure (offline, server down, DNS): the shell shows one global bar.
    console.warn("[cloud]", e);
    net.offline = true;
    throw new CloudError(0, "offline", "Keine Verbindung zum bookie Server");
  }
  net.offline = false;
  const data = await res.json().catch(() => null);
  // Only "unauthorized" means the session is gone; a 401 invalid_credentials
  // (wrong current password on change / 2FA disable) must not sign out.
  if (res.status === 401 && token && data?.error === "unauthorized") {
    signOut();
    throw new CloudError(
      401,
      "session_expired",
      "Sitzung abgelaufen, bitte neu anmelden",
    );
  }
  if (res.status === 409 && data?.error === "conflict") {
    const err = new CloudError(409, "conflict");
    toasts.error(err.message, 0, {
      label: "Neu laden",
      run: () => location.reload(),
    });
    throw err;
  }
  if (!res.ok) throw new CloudError(res.status, data?.error ?? res.statusText);
  remember(path, method, data);
  return data as T;
}

export function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const c = cloud();
  if (!c) throw new Error("Nicht mit bookie Cloud angemeldet");
  return request<T>(c.url, path, method, body, c.token);
}

/** REST resource of bookie-server (`/api/<name>`) in the shape the db modules return. */
export function resource<T>(name: string) {
  return {
    list: () => api<T[]>(`/api/${name}`),
    page: (limit: number, offset: number) =>
      api<{ rows: T[]; totalCount: number }>(
        `/api/${name}?limit=${limit}&offset=${offset}`,
      ),
    get: (id: number) =>
      api<T>(`/api/${name}/${id}`).catch((e) =>
        e instanceof CloudError && e.status === 404
          ? undefined
          : Promise.reject(e),
      ),
    create: async (data: object) =>
      (await api<{ id: number }>(`/api/${name}`, "POST", data)).id,
    update: async (id: number, data: object) =>
      void (await api(`/api/${name}/${id}`, "PATCH", data)),
    remove: async (id: number) =>
      void (await api(`/api/${name}/${id}`, "DELETE")),
  };
}

/** Unauthenticated call (register, password reset mail). */
export const publicApi = <T>(url: string, path: string, body: unknown) =>
  request<T>(url.replace(/\/+$/, ""), path, "POST", body);

/** The server takes a 6-digit TOTP as `code`, anything else as `recoveryCode`. */
export const secondFactor = (code: string) =>
  /^\d{6}$/.test(code.trim()) ? { code: code.trim() } : { recoveryCode: code };

/** Returns "mfa" when the account has 2FA and no code was given. */
export async function login(
  url: string,
  email: string,
  password: string,
  code?: string,
): Promise<"mfa" | void> {
  url = url.replace(/\/+$/, "");
  let r = await request<{ token?: string; mfaToken?: string }>(
    url,
    "/auth/login",
    "POST",
    { email, password },
  );
  if (r.mfaToken) {
    if (!code) return "mfa";
    r = await request(url, "/auth/login/totp", "POST", {
      mfaToken: r.mfaToken,
      ...secondFactor(code),
    });
  }
  await storeToken(r.token!);
  localStorage.setItem(KEY, JSON.stringify({ url, email }));
}

export async function logout(): Promise<void> {
  await api("/auth/logout", "POST", {}).catch(() => {}); // local sign-out even if the server is gone
  signOut();
}

export type Me = {
  user: { id: number; email: string; name: string; totpEnabled: boolean };
  activeCompanyId: number | null;
  /** The active company as the shell needs it; null without one. */
  active: {
    grants: Partial<Record<Area, "view" | "edit">>;
    logo: string | null;
    seats: number;
    /** Every member's name for labels; empty for subcontractors. */
    members: { id: number; name: string; role: "admin" | "member" | "subcontractor" }[];
  } | null;
  companies: {
    id: number;
    name: string;
    role: "admin" | "member" | "subcontractor";
    paid: boolean;
  }[];
};
