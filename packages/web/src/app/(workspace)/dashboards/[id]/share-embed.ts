/**
 * Pure builder for the dashboard share dialog's Embed-tab iframe snippet (#4564),
 * factored out of the client component so the attribute-escaping invariant is
 * unit-testable without rendering the dialog (mirrors share-expiry.ts).
 */

/** The forced-theme choices the Embed tab can bake into the snippet. `undefined`
 *  (the default) emits no `?theme=` param so the embed follows the visitor's own
 *  system preference. */
export type EmbedThemeParam = "light" | "dark";

/**
 * Build the iframe snippet that embeds a shared dashboard. It points at the
 * share token's framable `/embed` route — SAME snapshot, SAME revocation/expiry
 * as the standalone shared page — so revoking the link kills the embed too.
 * The URL is `&quot;`-escaped so a token can never break out of the `src="…"`
 * double-quoted attribute.
 *
 * `theme` forces the embed's light/dark appearance via `?theme=`; omitting it
 * (the default) lets the visitor's system preference drive the frame.
 */
export function buildEmbedSnippet(shareUrl: string, theme?: EmbedThemeParam): string {
  const base = `${shareUrl.replace(/"/g, "&quot;")}/embed`;
  const src = theme ? `${base}?theme=${theme}` : base;
  return `<iframe src="${src}" width="100%" height="600" frameborder="0" style="border:0;border-radius:8px" title="Atlas dashboard"></iframe>`;
}
