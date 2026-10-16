import { base } from "$app/paths";

/** Route pairs across languages (paths are relative to the base path). */
const PAIRS: Record<string, string> = {
  "/": "/de/",
  "/de/": "/",
  "/imprint/": "/de/impressum/",
  "/de/impressum/": "/imprint/",
  "/privacy/": "/de/datenschutz/",
  "/de/datenschutz/": "/privacy/",
};

/**
 * URL of the same page in the other language (with base path prefix),
 * or null if the current page has no counterpart.
 */
export function counterpart(pathname: string): string | null {
  const path = (pathname.slice(base.length) || "/").replace(/\/+$/, "") + "/";
  const target = PAIRS[path];
  return target ? `${base}${target}` : null;
}
