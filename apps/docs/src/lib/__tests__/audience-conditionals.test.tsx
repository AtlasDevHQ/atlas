import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { audienceConditionals } from "@/lib/audience-conditionals";
import {
  stripInactiveAudienceBlocks,
  filterTocByAudience,
  tocTitleToText,
  survivingHeadingTitles,
  normalizeHeadingText,
} from "@/lib/audience-markdown";
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
    /residual <When…> tag/,
  );
});

test("markdown strip FAILS CLOSED on an unsupported single-line inline audience tag", () => {
  // The strip only handles block-form; a fully-inline form escapes the block
  // patterns, so the post-condition must throw rather than leak the self-hosted
  // prose into the saas surface.
  const inline =
    "Price is <WhenSaaS>$39</WhenSaaS><WhenSelfHosted>free</WhenSelfHosted>/mo.";
  expect(() => stripInactiveAudienceBlocks(inline, "saas")).toThrow(
    /residual <When…> tag/,
  );
});

test("an inline-code mention of a tag name is NOT treated as a residual tag", () => {
  const mention = [
    "Use `<WhenSaaS>` and `<WhenSelfHosted>` for per-audience prose.",
    "",
    "<WhenSaaS>",
    "  Cloud. `saas-md-token`.",
    "</WhenSaaS>",
  ].join("\n");
  const out = stripInactiveAudienceBlocks(mention, "saas");
  expect(out).toContain("saas-md-token");
  expect(out).toContain("`<WhenSelfHosted>`"); // the mention survives, unstripped
});

// ── audience-aware table of contents (#4282) ─────────────────────────────────
//
// fumadocs compiles `page.data.toc` from ALL headings in the raw MDX — the
// runtime audience conditional is invisible to it — so a heading authored inside
// a `<WhenSelfHosted>` block would appear in the SaaS mount's ToC (and link to an
// anchor that never renders). `filterTocByAudience` drops the inactive branch's
// headings so the ToC matches what the mount actually shows.

const TOC_MD = [
  "# Intro",
  "",
  "Shared intro.",
  "",
  "## Shared Section",
  "",
  "<WhenSelfHosted>",
  "## Org-scoped connections (Self-Hosted)",
  "",
  "Operator config with `atlas.config.ts`.",
  "</WhenSelfHosted>",
  "",
  "## Another Shared Section",
  "",
  "<WhenSaaS>",
  "## Billing (SaaS)",
  "</WhenSaaS>",
].join("\n");

test("tocTitleToText flattens string, array, and element-like title nodes", () => {
  expect(tocTitleToText("Plain")).toBe("Plain");
  // fumadocs' array title node (in-memory React-element form): [<code>atlas
  // init</code>, " with orgs"].
  expect(
    tocTitleToText([
      { props: { children: "atlas init" } },
      " with orgs (Self-Hosted)",
    ]),
  ).toBe("atlas init with orgs (Self-Hosted)");
  expect(tocTitleToText({ children: "el text" })).toBe("el text");
});

test("survivingHeadingTitles omits headings inside the inactive branch", () => {
  const saas = survivingHeadingTitles(TOC_MD, "saas");
  expect(saas.has("Shared Section")).toBe(true);
  expect(saas.has("Another Shared Section")).toBe(true);
  expect(saas.has("Billing (SaaS)")).toBe(true); // active on saas
  expect(saas.has("Org-scoped connections (Self-Hosted)")).toBe(false);

  const selfHosted = survivingHeadingTitles(TOC_MD, "self-hosted");
  expect(selfHosted.has("Org-scoped connections (Self-Hosted)")).toBe(true);
  expect(selfHosted.has("Billing (SaaS)")).toBe(false); // inactive on self-hosted
});

test("filterTocByAudience drops the self-hosted heading from the SaaS ToC", () => {
  const toc = [
    { depth: 1, url: "#intro", title: "Intro" },
    { depth: 2, url: "#shared-section", title: "Shared Section" },
    {
      depth: 2,
      url: "#org-scoped-connections-self-hosted",
      title: "Org-scoped connections (Self-Hosted)",
    },
    { depth: 2, url: "#another-shared-section", title: "Another Shared Section" },
    { depth: 2, url: "#billing-saas", title: "Billing (SaaS)" },
  ];

  const saasToc = filterTocByAudience(toc, TOC_MD, "saas");
  const saasTitles = saasToc.map((t) => t.title);
  expect(saasTitles).toContain("Shared Section");
  expect(saasTitles).toContain("Billing (SaaS)");
  expect(saasTitles).not.toContain("Org-scoped connections (Self-Hosted)");

  const selfHostedToc = filterTocByAudience(toc, TOC_MD, "self-hosted");
  const shTitles = selfHostedToc.map((t) => t.title);
  expect(shTitles).toContain("Org-scoped connections (Self-Hosted)");
  expect(shTitles).not.toContain("Billing (SaaS)");
});

test("filterTocByAudience matches a code-containing heading (backticks normalized)", () => {
  const md = [
    "<WhenSelfHosted>",
    "## `atlas init` with organizations (Self-Hosted)",
    "</WhenSelfHosted>",
    "",
    "## Shared",
  ].join("\n");
  // Mirrors fumadocs' array title node for a heading with inline code.
  const toc = [
    {
      depth: 2,
      url: "#atlas-init-with-organizations-self-hosted",
      title: [{ props: { children: "atlas init" } }, " with organizations (Self-Hosted)"],
    },
    { depth: 2, url: "#shared", title: "Shared" },
  ];
  const saas = filterTocByAudience(toc, md, "saas").map((t) =>
    tocTitleToText(t.title),
  );
  expect(saas).toContain("Shared");
  expect(saas).not.toContain("atlas init with organizations (Self-Hosted)");

  // KEEP side (the path that actually exercises backtick normalization): on the
  // self-hosted mount the code heading SURVIVES, so its backtick'd markdown form
  // (`` ## `atlas init` … ``) must normalize to the SAME string as the ToC's
  // array title node (backticks already gone) for the match to keep it. Without
  // `normalizeHeadingText` stripping the backticks, the two wouldn't compare
  // equal and this entry would be wrongly dropped.
  const selfHosted = filterTocByAudience(toc, md, "self-hosted").map((t) =>
    tocTitleToText(t.title),
  );
  expect(selfHosted).toContain("atlas init with organizations (Self-Hosted)");
});

test("normalizeHeadingText strips inline code, links, and emphasis", () => {
  expect(normalizeHeadingText("`atlas init` with orgs")).toBe(
    "atlas init with orgs",
  );
  expect(normalizeHeadingText("[Config](/reference/config) options")).toBe(
    "Config options",
  );
  expect(normalizeHeadingText("**Bold** and _italic_ heading")).toBe(
    "Bold and italic heading",
  );
});

test("filterTocByAudience over-keeps a duplicate heading (fail-safe: shows, never hides)", () => {
  // Same heading text in a shared section AND a self-hosted section. On the SaaS
  // mount the self-hosted copy is stripped, but the shared copy keeps the title
  // in the surviving set, so BOTH ToC entries survive. The documented fail-safe:
  // a duplicate over-keeps (a possibly-dead anchor), never over-removes (a hidden
  // real heading).
  const md = [
    "## Setup",
    "",
    "<WhenSelfHosted>",
    "## Setup",
    "",
    "Operator-only setup.",
    "</WhenSelfHosted>",
  ].join("\n");
  const toc = [
    { depth: 2, url: "#setup", title: "Setup" },
    { depth: 2, url: "#setup-1", title: "Setup" },
  ];
  expect(filterTocByAudience(toc, md, "saas").length).toBe(2);
});
