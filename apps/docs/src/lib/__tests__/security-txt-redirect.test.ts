import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * security.txt redirect coverage (#4467).
 *
 * RFC 9116 is per-origin: docs.useatlas.dev and app.useatlas.dev must answer
 * /.well-known/security.txt themselves. Both do it by redirecting to the
 * canonical www copy — the SSOT at apps/www/public/.well-known/security.txt —
 * rather than serving a second file that could drift.
 *
 * Invariants pinned here:
 *   - the docs-origin Caddyfile actually carries the redirect (a Caddyfile
 *     refactor that drops the line would silently 404 the origin again);
 *   - the app-origin build default (the ATLAS_SECURITY_TXT_URL ARG in
 *     deploy/web/Dockerfile, read by packages/web/next.config.ts redirects())
 *     is present — an ARG "cleanup" would silently drop the app origin's
 *     security.txt with every other gate green;
 *   - both redirect targets ARE the SSOT's own `Canonical` URL, so if the
 *     canonical location ever moves, this test forces the redirects to move
 *     with it. (The API origin pins the same invariant in
 *     packages/api/src/api/__tests__/well-known.test.ts.)
 *
 * Self-contained: read-only file reads, no network, no git-at-runtime.
 */

// src/lib/__tests__ -> apps/docs -> repo root
const REPO_ROOT = join(import.meta.dir, "../../../../..");
const CADDYFILE = join(REPO_ROOT, "deploy/docs/Caddyfile");
const WEB_DOCKERFILE = join(REPO_ROOT, "deploy/web/Dockerfile");
const WWW_SECURITY_TXT = join(
  REPO_ROOT,
  "apps/www/public/.well-known/security.txt",
);

// Same normalization as redirect-coverage.test.ts — indentation-agnostic.
const normalize = (line: string): string => line.trim().replace(/\s+/g, " ");

describe("per-origin security.txt redirects (#4467)", () => {
  test("the www SSOT copy exists and declares a Canonical URL", () => {
    expect(existsSync(WWW_SECURITY_TXT)).toBe(true);
    const canonical = readCanonical();
    expect(canonical).toMatch(
      /^https:\/\/.+\/\.well-known\/security\.txt$/,
    );
  });

  test("docs origin: the Caddyfile redirects /.well-known/security.txt to the SSOT's Canonical URL", () => {
    const canonical = readCanonical();
    const lines = readFileSync(CADDYFILE, "utf8").split("\n").map(normalize);
    // Numeric 30x form required — Caddy's keyword (`temporary`/`permanent`)
    // and implicit-302 forms are also valid redirects but won't match; the
    // Caddyfile should keep the explicit numeric status.
    const targets = lines
      .map((line) =>
        /^redir \/\.well-known\/security\.txt (\S+) 30\d$/.exec(line),
      )
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]);
    expect(targets).toContain(canonical);
  });

  test("app origin: the web Dockerfile defaults ATLAS_SECURITY_TXT_URL to the SSOT's Canonical URL", () => {
    const canonical = readCanonical();
    const lines = readFileSync(WEB_DOCKERFILE, "utf8")
      .split("\n")
      .map(normalize);
    expect(lines).toContain(`ARG ATLAS_SECURITY_TXT_URL=${canonical}`);
  });
});

function readCanonical(): string {
  const body = readFileSync(WWW_SECURITY_TXT, "utf8");
  const match = body.match(/^Canonical:\s*(\S+)\s*$/m);
  if (!match) {
    throw new Error(
      `No Canonical field in ${WWW_SECURITY_TXT} — the redirect target cannot be derived`,
    );
  }
  return match[1];
}
