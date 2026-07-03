import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { audienceConditionals } from "@/lib/audience-conditionals";
import { stripInactiveAudienceBlocks } from "@/lib/audience-markdown";
import type { Audience } from "@/lib/audience";

/**
 * The security-relevant tests (PRD #4257, slice #4260's driving invariant).
 *
 * `audienceConditionals(audience)` returns SERVER components resolved for one
 * mount. The inactive branch is `RenderNothing`, which never renders its
 * children — so the opposite audience's content is ABSENT from the emitted HTML,
 * not hidden. (The authoritative proof is the static-export grep in the PR; a
 * client conditional would pass a render-string test yet still leak its children
 * into the RSC flight payload. These tests pin the server-component logic.)
 */

const SAAS_TOKEN = "SAAS_BRANCH_ONLY_TOKEN";
const SELF_HOSTED_TOKEN = "SELF_HOSTED_BRANCH_ONLY_TOKEN";

function renderBothBranches(audience: Audience): string {
  const { WhenSaaS, WhenSelfHosted } = audienceConditionals(audience);
  return renderToStaticMarkup(
    <>
      <WhenSaaS>
        <span>{SAAS_TOKEN}</span>
      </WhenSaaS>
      <WhenSelfHosted>
        <span>{SELF_HOSTED_TOKEN}</span>
      </WhenSelfHosted>
    </>,
  );
}

test("SaaS mount emits ONLY the saas branch — self-hosted branch is absent from the HTML", () => {
  const html = renderBothBranches("saas");
  expect(html).toContain(SAAS_TOKEN);
  // Core invariant: not hidden, ABSENT. If this ever renders the self-hosted
  // branch, a SaaS reader could receive self-hosted-only content.
  expect(html).not.toContain(SELF_HOSTED_TOKEN);
});

test("self-hosted mount emits ONLY the self-hosted branch — saas branch is absent", () => {
  const html = renderBothBranches("self-hosted");
  expect(html).toContain(SELF_HOSTED_TOKEN);
  expect(html).not.toContain(SAAS_TOKEN);
});

test("the inactive conditional renders literally nothing (no wrapper element)", () => {
  const { WhenSelfHosted } = audienceConditionals("saas");
  const html = renderToStaticMarkup(
    <WhenSelfHosted>
      <p>{SELF_HOSTED_TOKEN}</p>
    </WhenSelfHosted>,
  );
  expect(html).toBe("");
});

// Structural anti-regression guard. `renderToStaticMarkup` emits no RSC flight
// payload, so it CANNOT distinguish the secure server component from an insecure
// client conditional (which would leak its children into the payload). The one
// thing keeping the branch out of the payload is that audience-conditionals.tsx
// is a server module resolved from the arg, not `"use client"` context — pin
// exactly that, so a future context-based "simplification" fails CI, not just
// the manual static-export grep.
test("audience-conditionals.tsx stays a server module resolved from its argument (no client context)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../audience-conditionals.tsx", import.meta.url)),
    "utf8",
  );
  // No "use client" directive — the load-bearing signal; a client module would
  // re-open the flight-payload leak. (Checked as the literal directive string,
  // not prose — the JSDoc deliberately NAMES the client anti-pattern.)
  expect(src).not.toContain('"use client"');
  // No hook imported (context/state) — checked on import statements, so the
  // JSDoc's `useAudience()` mention is not a false positive.
  expect(src).not.toMatch(/^\s*import\b[^\n]*\b(useContext|useAudience|useState)\b/m);
  // The factory is a pure function of its argument: the same audience always
  // yields the same active/inactive pairing, independent of any surrounding
  // provider (there is no provider to read).
  const a = audienceConditionals("saas");
  const b = audienceConditionals("saas");
  expect(a.WhenSaaS).toBe(b.WhenSaaS);
  expect(a.WhenSelfHosted).toBe(b.WhenSelfHosted);
  expect(audienceConditionals("self-hosted").WhenSaaS).not.toBe(a.WhenSaaS);
});

// ── markdown text surfaces (twin + llms-full.txt) ────────────────────────────

// Note the INLINE mention of the tag names in the intro — a real doc sentence
// that explains the components. The strip must NOT treat that as a block, or a
// non-greedy match would span from the inline `<WhenSelfHosted>` mention through
// the real block and swallow the active branch's content (a real regression we
// hit against the static export).
const MD = [
  "Intro prose mentioning `<WhenSaaS>` / `<WhenSelfHosted>` inline.",
  "",
  "<WhenSaaS>",
  "  Cloud note. Token: `saas-md-token`.",
  "</WhenSaaS>",
  "",
  "<WhenSelfHosted>",
  "  Self-hosted note. Token: `self-hosted-md-token`.",
  "</WhenSelfHosted>",
  "",
  "Outro prose.",
].join("\n");

const BLOCK_TAG_LINE = /^[ \t]*<\/?When(SaaS|SelfHosted)>[ \t]*$/m;

test("markdown strip keeps the saas branch and removes the self-hosted branch", () => {
  const out = stripInactiveAudienceBlocks(MD, "saas");
  expect(out).toContain("saas-md-token");
  expect(out).not.toContain("self-hosted-md-token");
  // Both surrounding prose lines survive (the active branch wasn't swallowed).
  expect(out).toContain("Intro prose");
  expect(out).toContain("Outro prose.");
  // No standalone block tag lines remain (active unwrapped, inactive removed);
  // the inline mention in the intro is preserved.
  expect(out).not.toMatch(BLOCK_TAG_LINE);
  expect(out).toContain("`<WhenSaaS>`");
});

test("markdown strip keeps the self-hosted branch and removes the saas branch", () => {
  const out = stripInactiveAudienceBlocks(MD, "self-hosted");
  expect(out).toContain("self-hosted-md-token");
  expect(out).not.toContain("saas-md-token");
  expect(out).toContain("Intro prose");
  expect(out).toContain("Outro prose.");
  expect(out).not.toMatch(BLOCK_TAG_LINE);
});

test("markdown strip is robust to CRLF line endings (no leak)", () => {
  const crlf = MD.replace(/\n/g, "\r\n");
  const out = stripInactiveAudienceBlocks(crlf, "saas");
  expect(out).toContain("saas-md-token");
  expect(out).not.toContain("self-hosted-md-token");
  expect(out).not.toMatch(BLOCK_TAG_LINE);
});

test("markdown strip tolerates tag attributes / trailing whitespace (no leak)", () => {
  const withAttrs = [
    "<WhenSaaS >",
    "  Cloud. `saas-md-token`.",
    "</WhenSaaS>",
    "",
    '<WhenSelfHosted className="x">',
    "  Self-hosted. `self-hosted-md-token`.",
    "</WhenSelfHosted>",
  ].join("\n");
  const out = stripInactiveAudienceBlocks(withAttrs, "saas");
  expect(out).toContain("saas-md-token");
  expect(out).not.toContain("self-hosted-md-token");
  expect(out).not.toMatch(BLOCK_TAG_LINE);
});

test("markdown strip FAILS CLOSED on a malformed/unclosed inactive block", () => {
  const unclosed = [
    "Intro.",
    "<WhenSelfHosted>",
    "  Self-hosted secret `self-hosted-md-token` with no closing tag.",
  ].join("\n");
  // A silent pass would leak the self-hosted tail into the saas surface; assert
  // it throws instead.
  expect(() => stripInactiveAudienceBlocks(unclosed, "saas")).toThrow(
    /residual <When…> block tag/,
  );
});
