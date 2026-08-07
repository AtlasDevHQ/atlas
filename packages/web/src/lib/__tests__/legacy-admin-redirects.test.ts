import { describe, it, expect, afterEach } from "bun:test";

/**
 * Legacy admin-URL redirects in `next.config.ts` (#5066).
 *
 * `/admin/brain-facts` was retired when the Company Atlas became its own nav
 * group; the page now lives at `/admin/brain/facts`. Bookmarks, the docs
 * portal, and the brain soak runbook all name the old URL, so it has to
 * redirect rather than 404.
 *
 * ## What this pins that a "does the entry exist" test would not
 *
 * `redirects()` already hosted a conditional block: it read
 * `ATLAS_SECURITY_TXT_URL` and `return []`-ed early when unset. An
 * unconditional redirect appended AFTER that early return is dead on every
 * self-hosted deploy and on every developer's box — and green in any test that
 * happens to set the var first. So the load-bearing assertion here is the one
 * with the var **deleted**: that is the configuration nearly all deployments
 * run, and the only one where the ordering bug is observable.
 *
 * `redirects()` reads process.env at call time, so the var is mutated inside
 * the test body and restored after — no top-level env mutation.
 */

import nextConfig from "../../../next.config";

const LEGACY_BRAIN_REDIRECT = {
  source: "/admin/brain-facts",
  destination: "/admin/brain/facts",
  permanent: true,
};

const prev = process.env.ATLAS_SECURITY_TXT_URL;

afterEach(() => {
  if (prev === undefined) delete process.env.ATLAS_SECURITY_TXT_URL;
  else process.env.ATLAS_SECURITY_TXT_URL = prev;
});

describe("next.config redirects() — retired /admin/brain-facts (#5066)", () => {
  it("redirects the legacy URL when ATLAS_SECURITY_TXT_URL is UNSET", async () => {
    // The self-hosted default, and the arm that fails if the entry is ever
    // moved below the security.txt early return.
    delete process.env.ATLAS_SECURITY_TXT_URL;
    expect(await nextConfig.redirects?.()).toContainEqual(LEGACY_BRAIN_REDIRECT);
  });

  it("redirects the legacy URL when ATLAS_SECURITY_TXT_URL is BLANK", async () => {
    // `.trim()` makes a whitespace-only var falsy, which takes the same early
    // return as unset — a second way to lose the entry.
    process.env.ATLAS_SECURITY_TXT_URL = "   ";
    expect(await nextConfig.redirects?.()).toContainEqual(LEGACY_BRAIN_REDIRECT);
  });

  it("redirects the legacy URL when ATLAS_SECURITY_TXT_URL is SET", async () => {
    process.env.ATLAS_SECURITY_TXT_URL = "https://www.useatlas.dev/.well-known/security.txt";
    expect(await nextConfig.redirects?.()).toContainEqual(LEGACY_BRAIN_REDIRECT);
  });

  it("is permanent — the old URL is retired, not parked", async () => {
    // A 307 would keep every bookmark and doc link resolving through a hop
    // forever. Pinned separately from the shape above so a flip to
    // `permanent: false` names itself in the failure.
    delete process.env.ATLAS_SECURITY_TXT_URL;
    const entry = (await nextConfig.redirects?.())?.find(
      (r) => r.source === "/admin/brain-facts",
    );
    expect(entry?.permanent).toBe(true);
  });

  it("does not redirect the surviving /admin/brain/facts route onto itself", async () => {
    // A `source` typed as the NEW path would loop. Nothing should match it.
    delete process.env.ATLAS_SECURITY_TXT_URL;
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects.some((r) => r.source === "/admin/brain/facts")).toBe(false);
  });

  it("pins the WHOLE redirect set, so a stray entry can't land unnoticed", async () => {
    // `security-txt-redirect.test.ts` used to assert the full array with
    // `toEqual([...])`; loosening it to per-source presence (so this file's
    // entry could join) gave up the only assertion on the total set. This
    // restores it in the one place that now owns the config as a whole.
    // Redirects are global URL behaviour — an accidental entry is not the kind
    // of change that should be able to arrive without a test naming it.
    //
    // ORDER is pinned deliberately, not incidentally: Next evaluates redirects
    // top-down and first match wins, so for any future pair whose `source`
    // patterns can overlap, order IS the behaviour. Today's two cannot overlap,
    // which makes this arm stricter than strictly necessary — the cheaper
    // reading (membership only) would stop describing the mechanism the moment
    // a wildcard source lands.
    delete process.env.ATLAS_SECURITY_TXT_URL;
    expect(((await nextConfig.redirects?.()) ?? []).map((r) => r.source)).toEqual([
      "/admin/brain-facts",
    ]);

    process.env.ATLAS_SECURITY_TXT_URL = "https://www.useatlas.dev/.well-known/security.txt";
    expect(((await nextConfig.redirects?.()) ?? []).map((r) => r.source)).toEqual([
      "/admin/brain-facts",
      "/.well-known/security.txt",
    ]);
  });
});
