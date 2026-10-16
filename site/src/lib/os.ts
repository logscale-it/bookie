export type Os = "macos" | "windows" | "linux";

/** Best-effort OS detection for the download section. */
export function detectOs(): Os | null {
  if (typeof navigator === "undefined") return null;
  const platform = navigator.platform ?? "";
  const userAgent = navigator.userAgent ?? "";
  if (/Mac/i.test(platform) || /Mac/i.test(userAgent)) return "macos";
  if (/Win/i.test(platform) || /Windows/i.test(userAgent)) return "windows";
  if (/Linux/i.test(platform) || /Linux/i.test(userAgent)) return "linux";
  return null;
}
