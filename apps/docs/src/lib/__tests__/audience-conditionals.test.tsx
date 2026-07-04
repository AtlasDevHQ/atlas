import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import {
  audienceConditionals,
  makeAudienceLink,
} from "@/lib/audience-conditionals";
import {
  stripInactiveAudienceBlocks,
  resolveAudienceLinks,
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

// ── <AudienceLink> cross-link component (#4289) ──────────────────────────────
//
// A shared page mounts into BOTH sections, so a single hard-coded root-absolute
// link leaks across the SaaS/self-hosted boundary. `<AudienceLink>` links only
// within the current mount's audience and renders plain text otherwise, so the
// emitted HTML on each mount can never point into the other audience's surface.

// A stand-in for the mount's `createRelativeLink` result: a plain anchor.
const StubLink = (props: ComponentProps<"a">) => <a {...props} />;

test("AudienceLink on the SaaS mount links its saas href and drops a self-hosted-only href", () => {
  const AudienceLink = makeAudienceLink("saas", StubLink);
  // saas href present → a real link on the saas mount.
  expect(
    renderToStaticMarkup(
      <AudienceLink saas="/guides/admin-console">Admin Console</AudienceLink>,
    ),
  ).toBe('<a href="/guides/admin-console">Admin Console</a>');
  // Only a self-hosted href → the saas mount renders PLAIN TEXT (no anchor, no
  // `/self-hosted` href), so a SaaS reader is never sent into the self-hosted
  // section.
  const selfHostedOnly = renderToStaticMarkup(
    <AudienceLink selfHosted="/self-hosted/deployment/authentication">
      Authentication
    </AudienceLink>,
  );
  expect(selfHostedOnly).toBe("Authentication");
  expect(selfHostedOnly).not.toContain("/self-hosted");
});

test("AudienceLink on the self-hosted mount links its selfHosted href and drops a saas-only href", () => {
  const AudienceLink = makeAudienceLink("self-hosted", StubLink);
  expect(
    renderToStaticMarkup(
      <AudienceLink selfHosted="/self-hosted/deployment/authentication">
        Authentication
      </AudienceLink>,
    ),
  ).toBe('<a href="/self-hosted/deployment/authentication">Authentication</a>');
  // Only a saas href → plain text on the self-hosted mount (no leak into a
  // saas-only page).
  const saasOnly = renderToStaticMarkup(
    <AudienceLink saas="/guides/admin-console">Admin Console</AudienceLink>,
  );
  expect(saasOnly).toBe("Admin Console");
  expect(saasOnly).not.toContain("/guides/admin-console");
});

// ── <AudienceLink> markdown resolution (twin + llms-full.txt) ─────────────────
//
// The string-surface twin of the component: `getText("processed")` preserves the
// raw `<AudienceLink>` tag (and BOTH hrefs) verbatim, so the `.mdx`/`.txt`
// surfaces must resolve it to this audience's href — or the opposite audience's
// target would leak into the machine surface.

test("resolveAudienceLinks emits this mount's href and plain text for the other", () => {
  const md =
    'See <AudienceLink saas="/guides/x" selfHosted="/self-hosted/y">the guide</AudienceLink>.';
  expect(resolveAudienceLinks(md, "saas")).toBe("See [the guide](/guides/x).");
  expect(resolveAudienceLinks(md, "self-hosted")).toBe(
    "See [the guide](/self-hosted/y).",
  );

  // A saas-only link degrades to plain text on the self-hosted surface (matching
  // the component's bare-fragment branch) — no href leaks.
  const saasOnly = 'A <AudienceLink saas="/guides/x">link</AudienceLink> here.';
  expect(resolveAudienceLinks(saasOnly, "self-hosted")).toBe("A link here.");
  expect(resolveAudienceLinks(saasOnly, "self-hosted")).not.toContain("/guides/x");
});

test("resolveAudienceLinks resolves several links on one line independently", () => {
  // e.g. a "See Also" table row / list line with multiple cross-links.
  const md =
    '| <AudienceLink saas="/a">A</AudienceLink> | <AudienceLink selfHosted="/self-hosted/b">B</AudienceLink> |';
  expect(resolveAudienceLinks(md, "saas")).toBe("| [A](/a) | B |");
  expect(resolveAudienceLinks(md, "self-hosted")).toBe("| A | [B](/self-hosted/b) |");
});

test("resolveAudienceLinks is order-independent in the attribute list", () => {
  // The JSDoc claims attribute order is free; author them reversed to prove it.
  const md =
    'x <AudienceLink selfHosted="/self-hosted/y" saas="/guides/x">t</AudienceLink> z';
  expect(resolveAudienceLinks(md, "saas")).toBe("x [t](/guides/x) z");
  expect(resolveAudienceLinks(md, "self-hosted")).toBe("x [t](/self-hosted/y) z");
});

test("resolveAudienceLinks FAILS CLOSED on an unexpected audience — neither href leaks", () => {
  // `Audience` is a closed 2-member union, so this is only reachable via an
  // unchecked cast — but the whole module is defensive on exactly that. An
  // unexpected value must match NEITHER branch and drop to plain text (parity
  // with stripInactiveAudienceBlocks), NOT fall through to the self-hosted href.
  const md =
    'See <AudienceLink saas="/guides/x" selfHosted="/self-hosted/y">the guide</AudienceLink>.';
  const bogus = resolveAudienceLinks(md, "enterprise" as unknown as Audience);
  expect(bogus).toBe("See the guide.");
  expect(bogus).not.toContain("/self-hosted/y");
  expect(bogus).not.toContain("/guides/x");
});

test("makeAudienceLink FAILS CLOSED on an unexpected audience — renders plain text", () => {
  const AudienceLink = makeAudienceLink(
    "enterprise" as unknown as Audience,
    StubLink,
  );
  const html = renderToStaticMarkup(
    <AudienceLink saas="/guides/x" selfHosted="/self-hosted/y">
      the guide
    </AudienceLink>,
  );
  expect(html).toBe("the guide");
  expect(html).not.toContain("href");
});

test("resolveAudienceLinks degrades an unquoted/malformed href to plain text (fail-safe, no leak)", () => {
  // `attr` only reads a double-quoted value (the codemod always emits one). An
  // unquoted authoring typo yields no href → plain text; it never leaks a target
  // and never throws (the element is well-formed, so no residual tag survives).
  const md = "A <AudienceLink saas=/guides/x>link</AudienceLink> here.";
  expect(resolveAudienceLinks(md, "saas")).toBe("A link here.");
});

test("stripInactiveAudienceBlocks also resolves AudienceLinks to the mount audience", () => {
  const md = [
    "<WhenSaaS>",
    "  Hosted note.",
    "</WhenSaaS>",
    "",
    'Docs: <AudienceLink saas="/guides/x" selfHosted="/self-hosted/y">here</AudienceLink>.',
  ].join("\n");
  const saas = stripInactiveAudienceBlocks(md, "saas");
  expect(saas).toContain("[here](/guides/x)");
  expect(saas).not.toContain("/self-hosted/y");
  const selfHosted = stripInactiveAudienceBlocks(md, "self-hosted");
  expect(selfHosted).toContain("[here](/self-hosted/y)");
  expect(selfHosted).not.toContain("/guides/x");
});

test("markdown strip FAILS CLOSED on a malformed/unclosed AudienceLink", () => {
  // An unclosed cross-link would otherwise pass its raw tag (and both hrefs) into
  // the machine surface — fail the page instead.
  const malformed = 'Text <AudienceLink saas="/guides/x">no closing tag here.';
  expect(() => stripInactiveAudienceBlocks(malformed, "saas")).toThrow(
    /residual <When…> \/ <AudienceLink> tag/,
  );
});

test("an inline-code mention of AudienceLink is NOT treated as a residual tag", () => {
  const mention = "Authors use `<AudienceLink>` for shared-page cross-links.";
  expect(stripInactiveAudienceBlocks(mention, "saas")).toContain(
    "`<AudienceLink>`",
  );
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
    /residual <When…> \/ <AudienceLink> tag/,
  );
});

test("markdown strip FAILS CLOSED on an unsupported single-line inline audience tag", () => {
  // The strip only handles block-form; a fully-inline form escapes the block
  // patterns, so the post-condition must throw rather than leak the self-hosted
  // prose into the saas surface.
  const inline =
    "Price is <WhenSaaS>$39</WhenSaaS><WhenSelfHosted>free</WhenSelfHosted>/mo.";
  expect(() => stripInactiveAudienceBlocks(inline, "saas")).toThrow(
    /residual <When…> \/ <AudienceLink> tag/,
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
