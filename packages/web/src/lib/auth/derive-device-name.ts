/**
 * Best-effort device label derived from a userAgent string.
 *
 * Shared by the passkey enrollment dialog and the trusted-browser list — both
 * surfaces want the same "Mac · Safari" / "iPhone · Safari" labels so users
 * can pattern-match across them. A renamed passkey and a trust grant created
 * from the same browser look the same, which keeps the security page coherent.
 *
 * Pure string→string. The browser-aware default lives in `getDefaultDeviceName`
 * to keep this importable from non-DOM environments (server rendering, tests).
 */
export function deriveDeviceName(ua: string): string {
  const lower = ua.toLowerCase();

  let device = "This device";
  if (lower.includes("iphone")) device = "iPhone";
  else if (lower.includes("ipad")) device = "iPad";
  else if (lower.includes("android")) device = "Android";
  else if (lower.includes("mac os") || lower.includes("macintosh")) device = "Mac";
  else if (lower.includes("windows")) device = "Windows PC";
  else if (lower.includes("linux") || lower.includes("cros")) device = "Linux";

  let browser: string | null = null;
  if (lower.includes("edg/")) browser = "Edge";
  else if (lower.includes("chrome/") && !lower.includes("chromium")) browser = "Chrome";
  else if (lower.includes("firefox/")) browser = "Firefox";
  else if (lower.includes("safari/") && !lower.includes("chrome/")) browser = "Safari";

  return browser ? `${device} · ${browser}` : device;
}

/**
 * Browser-side wrapper that reads `navigator.userAgent`. Falls back to the
 * generic label in environments without a navigator (SSR, tests).
 */
export function getDefaultDeviceName(): string {
  if (typeof navigator === "undefined") return "This device";
  return deriveDeviceName(navigator.userAgent);
}
