/**
 * Pure builder for the dashboard share dialog's Embed-tab iframe snippet (#4564),
 * factored out of the client component so the attribute-escaping invariant is
 * unit-testable without rendering the dialog (mirrors share-expiry.ts).
 */

/**
 * Build the iframe snippet that embeds a shared dashboard. It points at the
 * share token's framable `/embed` route — SAME snapshot, SAME revocation/expiry
 * as the standalone shared page — so revoking the link kills the embed too.
 * The URL is `&quot;`-escaped so a token can never break out of the `src="…"`
 * double-quoted attribute.
 *
 * Borderlessness is expressed once via `style="border:0"` — the legacy
 * `frameborder` presentational attribute is obsolete in the HTML spec and
 * redundant with it, so the snippet omits it rather than emit dead markup.
 */
export function buildEmbedSnippet(shareUrl: string): string {
  const src = `${shareUrl.replace(/"/g, "&quot;")}/embed`;
  return `<iframe src="${src}" width="100%" height="600" style="border:0;border-radius:8px" title="Atlas dashboard"></iframe>`;
}
