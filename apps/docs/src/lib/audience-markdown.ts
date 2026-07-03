import type { Audience } from "@/lib/audience";

const AUDIENCE_TAGS = ["WhenSaaS", "WhenSelfHosted"] as const;

/** Any raw audience tag, open or close, block OR inline. Used as the fail-closed
 * post-condition AFTER code spans are masked out (so a doc sentence that MENTIONS
 * `` `<WhenSaaS>` `` in inline code is not a false positive). `\b` after the name
 * avoids matching a differently-named component like `<WhenSaaSFoo>`. */
const RESIDUAL_AUDIENCE_TAG = /<\/?When(?:SaaS|SelfHosted)\b/;

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
  out = out.replace(/\n{3,}/g, "\n\n");

  // Fail closed: after masking code-span mentions, NO raw audience tag may
  // survive. This catches both a malformed/unclosed BLOCK and the unsupported
  // single-line INLINE form (`<WhenSelfHosted>x</WhenSelfHosted>` on one line) —
  // the strip only handles block-form, so an inline usage must fail the
  // build/page rather than silently leak the other audience's prose.
  if (RESIDUAL_AUDIENCE_TAG.test(maskCodeSpans(out))) {
    throw new Error(
      `[docs] audience strip left a residual <When…> tag while resolving "${audience}" — a branch was not removed. Audience conditionals must be BLOCK-form (opening/closing tags each on their own line); inline usage is unsupported. Also check for malformed/unclosed tags.`,
    );
  }
  return out;
}
