import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for #4089.
 *
 * The session cookie is host-only to the API origin (ADR-0024 §5), so a server
 * component on `app.useatlas.dev` can never read it from the incoming request
 * headers and forward it to the cross-origin API — the SSR fetch sees no
 * session and 401s, bouncing logged-in users to /login. Authed workspace data
 * must be fetched from the BROWSER (a `"use client"` component), where the
 * host-only cookie attaches automatically.
 *
 * This guard fails if any `page.tsx` under the (workspace) route group is a
 * server component (no `"use client"` directive) that reads the `cookie`
 * request header — the exact antipattern that caused #4089.
 */

// .../dashboards/__tests__ → up two to the (workspace) route group root.
const WORKSPACE_ROOT = join(import.meta.dir, "..", "..");

function collectPageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectPageFiles(full));
    } else if (entry === "page.tsx") {
      out.push(full);
    }
  }
  return out;
}

describe("no SSR cookie forwarding in (workspace) pages (#4089)", () => {
  test("no server-component page reads the cookie request header", () => {
    const pages = collectPageFiles(WORKSPACE_ROOT);
    // Sanity check: the crawler found pages (so a path/refactor bug can't make
    // this guard silently vacuous).
    expect(pages.length).toBeGreaterThan(0);

    const offenders = pages.filter((file) => {
      const src = readFileSync(file, "utf8");
      const isClient = /^\s*["']use client["']/m.test(src);
      if (isClient) return false;
      // The host-only-cookie-forward smell, two ways a server component can
      // reach the request cookie:
      //   (a) the raw header — `headers().get("cookie")` / `.get('cookie')`
      const readsCookieHeader = /\.get\(\s*["']cookie["']\s*\)/.test(src);
      //   (b) forwarding a `cookie:` field into a server-side `fetch(...)`'s
      //       headers — catches the `next/headers` `cookies()` variant too,
      //       regardless of how the value was obtained.
      const forwardsCookieToFetch =
        /\bfetch\(/.test(src) && /headers:\s*\{[^}]*\bcookie\b[^}]*\}/s.test(src);
      return readsCookieHeader || forwardsCookieToFetch;
    });

    expect(offenders).toEqual([]);
  });
});
