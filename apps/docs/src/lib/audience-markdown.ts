import type { Audience } from "@/lib/audience";

/** Match only BLOCK component tags — a tag alone on its own line (as MDX block
 * JSX renders in processed markdown), tolerant of attributes and trailing
 * whitespace. Line-anchored (`m`, `$` before the newline) so an INLINE mention
 * like a doc sentence writing `` `<WhenSaaS>` `` is spared — those carry no
 * audience content. */
const RESIDUAL_BLOCK_TAG = /^[ \t]*<\/?When(?:SaaS|SelfHosted)(?:\s[^>]*)?>[ \t]*$/m;

const AUDIENCE_TAGS = ["WhenSaaS", "WhenSelfHosted"] as const;

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
 * any block-form audience tag survives — an unresolved branch (malformed /
 * unclosed tag, or a future MDX-emit change) must fail the build/page rather
 * than silently leak the other audience. Both callers compose fail-closed:
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

  if (RESIDUAL_BLOCK_TAG.test(out)) {
    throw new Error(
      `[docs] audience strip left a residual <When…> block tag while resolving "${audience}" — a branch was not removed (check for malformed/unclosed tags or attributes)`,
    );
  }
  return out;
}
