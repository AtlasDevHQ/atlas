import type { Audience } from "@/lib/audience";

const AUDIENCE_TAGS = ["WhenSaaS", "WhenSelfHosted"] as const;

/** Any raw audience construct, open or close, block OR inline: the two
 * `<When…>` conditionals AND the `<AudienceLink>` cross-link (#4289). Used as the
 * fail-closed post-condition AFTER code spans are masked out (so a doc sentence
 * that MENTIONS `` `<WhenSaaS>` `` / `` `<AudienceLink>` `` in inline code is not
 * a false positive). `\b` after the name avoids matching a differently-named
 * component like `<WhenSaaSFoo>`. */
const RESIDUAL_AUDIENCE_TAG = /<\/?(?:When(?:SaaS|SelfHosted)|AudienceLink)\b/;

/**
 * Inline `<AudienceLink saas="…" selfHosted="…">text</AudienceLink>` — the
 * cross-link a shared page uses instead of a bare root-absolute markdown link, so
 * it never leaks across the SaaS/self-hosted boundary (#4289). Non-greedy body,
 * so several on one line (e.g. a "See Also" list row) each resolve independently.
 * Attribute order is free and either href may be absent.
 */
const AUDIENCE_LINK = /<AudienceLink\b([^>]*)>([\s\S]*?)<\/AudienceLink>/g;

/** Pull a double-quoted `name="value"` attribute out of an `<AudienceLink>` tag's
 * attribute string, or null when absent. */
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
}

/**
 * Resolve every `<AudienceLink>` in a page's PROCESSED MARKDOWN to `audience`'s
 * mount: the string-surface twin of the `makeAudienceLink` server component.
 * fumadocs' `getText("processed")` preserves custom MDX tags verbatim, so without
 * this the `.mdx` twin / `llms-full.txt` would carry the raw `<AudienceLink>` tag
 * (and BOTH hrefs) — re-leaking the opposite audience's target into the machine
 * surface the HTML conditional closes. The active audience's href becomes an
 * ordinary `[text](href)` markdown link; when this audience has no href the link
 * degrades to plain `text` (matching the component's bare-fragment branch).
 */
export function resolveAudienceLinks(
  markdown: string,
  audience: Audience,
): string {
  return markdown.replace(AUDIENCE_LINK, (_full, attrs: string, text: string) => {
    // Explicit positive match (fail closed): an unexpected audience matches
    // neither branch and drops to plain text — the same both-branches-stripped
    // posture `stripInactiveAudienceBlocks` takes, rather than defaulting to one
    // audience's href on a cross-boundary primitive.
    const href =
      audience === "saas"
        ? attr(attrs, "saas")
        : audience === "self-hosted"
          ? attr(attrs, "selfHosted")
          : null;
    return href ? `[${text}](${href})` : text;
  });
}

/** Mask fenced and inline code spans (their raw tag MENTIONS must be spared) so
 * the residual check only sees real tags. Returns text safe to scan, not to emit. */
function maskCodeSpans(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "") // fenced blocks first
    .replace(/`[^`\n]*`/g, ""); // then inline-code spans
}

/** The `<Tag>…</Tag>` block (open+close on their own lines, prose between). */
function blockOf(tag: string): RegExp {
  return new RegExp(
    `^[ \\t]*<${tag}(?:\\s[^>]*)?>[ \\t]*\\n[\\s\\S]*?^[ \\t]*</${tag}>[ \\t]*$\\n?`,
    "gm",
  );
}

/** The bare open/close `<Tag>` / `</Tag>` lines, for unwrapping (keep prose). */
function tagsOf(tag: string): RegExp {
  return new RegExp(`^[ \\t]*</?${tag}(?:\\s[^>]*)?>[ \\t]*$\\n?`, "gm");
}

/**
 * Resolve `<WhenSaaS>` / `<WhenSelfHosted>` blocks in a page's PROCESSED
 * MARKDOWN for a given mount (PRD #4257, slice #4260).
 *
 * fumadocs' `getText("processed")` preserves custom MDX component tags verbatim
 * (a `<Callout>` shows up as literal `<Callout>` too), so a shared page's
 * markdown twin / `llms-full.txt` would otherwise carry BOTH audience branches —
 * leaking the self-hosted branch into the SaaS-root machine surface, the same
 * class of leak the HTML conditionals close. This applies the audience decision
 * to those text surfaces: the inactive branch is removed entirely and the active
 * branch is unwrapped (tags dropped, prose kept).
 *
 * Fails CLOSED. Line endings are normalized first (CRLF would otherwise defeat
 * the line-anchored patterns), tag attributes/whitespace are tolerated, and an
 * unexpected audience value strips BOTH branches (mirroring the explicit
 * positive-match in `audienceConditionals`). As a post-condition it THROWS if
 * any raw audience tag survives (after masking inline-code mentions) — an
 * unresolved branch, whether a malformed/unclosed block, an unsupported
 * single-line inline form, or a future MDX-emit change, must fail the build/page
 * rather than silently leak the other audience. Both callers compose fail-closed:
 * `llms-full.txt` catches per page and emits a visible placeholder; `llms.mdx`
 * lets the throw fail that page's static generation.
 *
 * Pure string logic — no `.source/server`, no React — so it is unit-testable.
 */
export function stripInactiveAudienceBlocks(
  markdown: string,
  audience: Audience,
): string {
  const normalized = markdown.replace(/\r\n/g, "\n");

  // Resolve the active tag by EXPLICIT positive match (fail closed): an
  // unexpected audience keeps neither branch.
  const active =
    audience === "saas"
      ? "WhenSaaS"
      : audience === "self-hosted"
        ? "WhenSelfHosted"
        : null;

  let out = normalized;
  // Remove every INACTIVE branch's block: with a known audience that is the one
  // opposite branch; with an unknown audience it is both.
  for (const tag of AUDIENCE_TAGS) {
    if (tag !== active) out = out.replace(blockOf(tag), "");
  }
  // Unwrap the ACTIVE branch's tags, keeping its prose (nothing if none active).
  if (active) out = out.replace(tagsOf(active), "");
  // Resolve inline `<AudienceLink>` cross-links to this mount's href (or plain
  // text), the string twin of the `makeAudienceLink` server component (#4289).
  // With an unknown audience `resolveAudienceLinks` matches neither branch and
  // keeps no href, mirroring the fail-closed both-branches-stripped behaviour above.
  out = resolveAudienceLinks(out, audience);
  out = out.replace(/\n{3,}/g, "\n\n");

  // Fail closed: after masking code-span mentions, NO raw audience construct may
  // survive. This catches a malformed/unclosed `<When…>` BLOCK, the unsupported
  // single-line INLINE `<When…>` form (`<WhenSelfHosted>x</WhenSelfHosted>` on one
  // line — the strip only handles block-form), and a malformed `<AudienceLink>`
  // the inline resolver could not close — any must fail the build/page rather
  // than silently leak the other audience's prose or link target.
  if (RESIDUAL_AUDIENCE_TAG.test(maskCodeSpans(out))) {
    throw new Error(
      `[docs] audience strip left a residual <When…> / <AudienceLink> tag while resolving "${audience}" — a branch or cross-link was not resolved. <When…> conditionals must be BLOCK-form (opening/closing tags each on their own line); <AudienceLink> must be a single well-formed element. Also check for malformed/unclosed tags.`,
    );
  }
  return out;
}

/**
 * Normalize a markdown heading's inline formatting to the plain text that
 * fumadocs' table-of-contents `title` carries — strip inline code backticks,
 * bold/italic markers, and `[text](url)` link syntax (keeping the link text),
 * then collapse whitespace. So `` ## `atlas init` with orgs `` and the ToC
 * title node `[<code>atlas init</code>, " with orgs"]` both reduce to
 * `atlas init with orgs` and compare equal.
 */
export function normalizeHeadingText(raw: string): string {
  return raw
    .replace(/`+/g, "") // inline-code backticks
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/[*_]{1,3}/g, "") // bold / italic markers
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The normalized heading titles that SURVIVE the audience strip — i.e. the
 * headings that actually render on `audience`'s mount. A heading authored inside
 * an inactive `<WhenSaaS>` / `<WhenSelfHosted>` block is removed by
 * `stripInactiveAudienceBlocks`, so it is absent from this set.
 *
 * Used to audience-filter fumadocs' `page.data.toc`, which is compiled from ALL
 * headings in the raw MDX (the runtime audience conditional is invisible to it),
 * so without filtering a self-hosted section's heading would appear in the SaaS
 * mount's table of contents — and link to an anchor that no longer renders.
 */
export function survivingHeadingTitles(
  markdown: string,
  audience: Audience,
): Set<string> {
  const scoped = stripInactiveAudienceBlocks(markdown, audience);
  const titles = new Set<string>();
  // ATX headings only (fumadocs emits ATX in processed markdown). Skip fenced
  // code blocks so a `# comment` inside ```bash isn't mistaken for a heading.
  const withoutFences = scoped.replace(/```[\s\S]*?```/g, "");
  for (const m of withoutFences.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    titles.add(normalizeHeadingText(m[1]));
  }
  return titles;
}

/** A fumadocs ToC item's `title` is a ReactNode; flatten it to plain text
 * structurally (no React import) — handles a string, a number, an array of
 * children, and an element-like `{ props: { children } }`. This is the in-memory
 * React-element form fumadocs stores in `toc[].title` (what a SERVER component
 * sees), e.g. for a heading with inline code the array
 * `[{ props: { children: "atlas init" } }, " with orgs"]`. It does NOT parse the
 * flight-serialized tuple form (`["$","code",…]`) — those are consumed by React's
 * flight reader, never by this build-time code. */
export function tocTitleToText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(tocTitleToText).join("");
  if (typeof node === "object") {
    const obj = node as { props?: { children?: unknown }; children?: unknown };
    if (obj.props && typeof obj.props === "object" && "children" in obj.props)
      return tocTitleToText(obj.props.children);
    if ("children" in obj) return tocTitleToText(obj.children);
  }
  return "";
}

/**
 * Filter fumadocs' `page.data.toc` down to the headings that render on
 * `audience`'s mount, so a `<WhenSelfHosted>`-wrapped section's heading never
 * appears in the SaaS mount's table of contents (nor links to a dead anchor).
 *
 * Generic over the ToC item shape (only reads `title`), so it needs no fumadocs
 * type import and stays unit-testable. Assumes heading texts are unique on a
 * page (github-slugger disambiguates the anchors, but the ToC title is what we
 * match on); a duplicate would over-keep, never over-remove — fail-safe toward
 * showing a heading, not hiding a real one.
 */
export function filterTocByAudience<T extends { readonly title: unknown }>(
  toc: readonly T[],
  markdown: string,
  audience: Audience,
): T[] {
  const surviving = survivingHeadingTitles(markdown, audience);
  return toc.filter((item) =>
    surviving.has(normalizeHeadingText(tocTitleToText(item.title))),
  );
}
