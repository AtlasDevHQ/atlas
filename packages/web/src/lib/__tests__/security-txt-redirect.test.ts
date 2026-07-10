import { describe, it, expect, afterEach } from "bun:test";

/**
 * App-origin security.txt redirect (#4467) — the next.config.ts half of the
 * seam. The docs-side test (apps/docs/src/lib/__tests__/
 * security-txt-redirect.test.ts) pins deploy/web/Dockerfile's
 * ATLAS_SECURITY_TXT_URL ARG default; this one pins that next.config.ts
 * still reads the var and maps /.well-known/security.txt onto it. Without
 * it, renaming the env read or the source path leaves the Dockerfile test
 * green while app.useatlas.dev silently 404s security.txt again.
 *
 * `redirects()` reads process.env at call time, so the var is set/restored
 * inside the test body — no top-level env mutation.
 */

import nextConfig from "../../../next.config";

const TARGET = "https://www.useatlas.dev/.well-known/security.txt";
const prev = process.env.ATLAS_SECURITY_TXT_URL;

afterEach(() => {
  if (prev === undefined) delete process.env.ATLAS_SECURITY_TXT_URL;
  else process.env.ATLAS_SECURITY_TXT_URL = prev;
});

describe("next.config redirects() — security.txt (#4467)", () => {
  it("adds a temporary redirect for /.well-known/security.txt when ATLAS_SECURITY_TXT_URL is set", async () => {
    process.env.ATLAS_SECURITY_TXT_URL = TARGET;
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toEqual([
      {
        source: "/.well-known/security.txt",
        destination: TARGET,
        permanent: false,
      },
    ]);
  });

  it("adds no route when the var is unset or blank (self-hosted default)", async () => {
    delete process.env.ATLAS_SECURITY_TXT_URL;
    expect(await nextConfig.redirects?.()).toEqual([]);

    process.env.ATLAS_SECURITY_TXT_URL = "   ";
    expect(await nextConfig.redirects?.()).toEqual([]);
  });
});
