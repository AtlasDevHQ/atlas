import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * security.txt redirect coverage (#4467).
 *
 * RFC 9116 is per-origin: docs.useatlas.dev must answer
 * /.well-known/security.txt itself. The docs origin does it with a Caddy
 * redirect to the canonical www copy — the SSOT at
 * apps/www/public/.well-known/security.txt — rather than a second file
 * that could drift.
 *
 * Two invariants pinned here:
 *   - the Caddyfile actually carries the redirect (a Caddyfile refactor
 *     that drops the line would silently 404 the origin again);
 *   - the redirect target IS the SSOT's own `Canonical` URL, so if the
 *     canonical location ever moves, this test forces the redirect to
 *     move with it.
 *
 * Self-contained: read-only file reads, no network, no git-at-runtime.
 */

// src/lib/__tests__ -> apps/docs -> repo root
const REPO_ROOT = join(import.meta.dir, "../../../../..");
const CADDYFILE = join(REPO_ROOT, "deploy/docs/Caddyfile");
const WWW_SECURITY_TXT = join(
  REPO_ROOT,
  "apps/www/public/.well-known/security.txt",
);

// Same normalization as redirect-coverage.test.ts — indentation-agnostic.
const normalize = (line: string): string => line.trim().replace(/\s+/g, " ");

describe("docs-origin security.txt redirect (#4467)", () => {
  test("the www SSOT copy exists and declares a Canonical URL", () => {
    expect(existsSync(WWW_SECURITY_TXT)).toBe(true);
    const canonical = readCanonical();
    expect(canonical).toMatch(
      /^https:\/\/.+\/\.well-known\/security\.txt$/,
    );
  });

  test("the Caddyfile redirects /.well-known/security.txt to the SSOT's Canonical URL", () => {
    const canonical = readCanonical();
    const lines = readFileSync(CADDYFILE, "utf8").split("\n").map(normalize);
    // 3xx status intentionally unpinned beyond "a redir exists to the
    // canonical URL" — RFC 9116 permits any redirect.
    const hasRedirect = lines.some((line) =>
      /^redir \/\.well-known\/security\.txt (\S+) 30\d$/.test(line) &&
      line.split(" ")[2] === canonical,
    );
    expect(hasRedirect).toBe(true);
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
