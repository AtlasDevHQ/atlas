import type { Audience } from "@/lib/audience";

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
 * Pure string logic — no `.source/server`, no React — so it is unit-testable.
 */
export function stripInactiveAudienceBlocks(
  markdown: string,
  audience: Audience,
): string {
  const active = audience === "saas" ? "WhenSaaS" : "WhenSelfHosted";
  const inactive = audience === "saas" ? "WhenSelfHosted" : "WhenSaaS";

  // Match only BLOCK component tags — a tag alone on its own line (as MDX block
  // JSX renders in processed markdown). Anchoring to line boundaries (`gm`, with
  // `$` before the newline) leaves INLINE mentions untouched, e.g. a doc
  // sentence that writes `` `<WhenSaaS>` `` to explain the component — those
  // carry no audience content and must survive.
  const inactiveBlock = new RegExp(
    `^[ \\t]*<${inactive}>[ \\t]*\\n[\\s\\S]*?^[ \\t]*</${inactive}>[ \\t]*$\\n?`,
    "gm",
  );
  const activeTags = new RegExp(`^[ \\t]*</?${active}>[ \\t]*$\\n?`, "gm");

  return markdown
    .replace(inactiveBlock, "")
    .replace(activeTags, "")
    .replace(/\n{3,}/g, "\n\n");
}
