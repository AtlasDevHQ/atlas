/**
 * Server-side userAgent → "Mac · Safari" labeller.
 *
 * Mirrors the web-side `deriveDeviceName` helper in
 * `packages/web/src/lib/auth/derive-device-name.ts`. The two are kept
 * structurally identical so the same UA renders the same label whether the
 * server records it (trust-device hook) or the browser computes it
 * (passkey enrollment dialog). If you change one, change the other —
 * the `device-label.test.ts` suite includes a parity check.
 *
 * Pure string→string. Does NOT touch `navigator` (no DOM), so it's safe to
 * call from inside a Better Auth database hook on the server.
 */
export function deriveDeviceLabel(ua: string): string {
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
