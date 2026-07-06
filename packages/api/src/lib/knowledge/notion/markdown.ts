/**
 * Normalize Notion "enhanced Markdown" (the page-markdown endpoint's output)
 * into the plain Markdown the KB ingest stores (#4378). A PURE function —
 * golden-fixture tested (AC: "Markdown endpoint output normalized to plain
 * markdown (goldens)").
 *
 * Three enhanced constructs are downgraded; everything else passes through
 * untouched (real fenced code, standard headings/lists/links):
 *
 *   1. CALLOUT FENCES — an enhanced ```` ```callout ```` block becomes a
 *      Markdown blockquote, so the note reads as prose, not a code listing.
 *   2. COLUMN TAGS — `<columns>` / `<column>` layout wrappers are dropped and
 *      their contents concatenated top-to-bottom (a linear document has no
 *      columns); a blank line separates what were side-by-side columns.
 *   3. DETAILS / SUMMARY (toggles) — `<details>` wrappers are dropped and the
 *      `<summary>` becomes a bold lead line, so the toggle's hidden body is
 *      always present in the ingested text (an agent can't expand a toggle).
 *
 * Separately, EXPIRING MEDIA URLs are replaced with a link to the vendor page
 * (AC: "expiring media URLs never persist into documents"). Notion serves
 * images/files from short-lived pre-signed S3 URLs; persisting one guarantees a
 * dead link within the hour, so `![alt](signed-url)` and `[text](signed-url)`
 * collapse to a "view in Notion" link at the page's stable URL. Text-first v1:
 * the media itself is not mirrored.
 */

/** Everything the normalizer needs about the page beyond its markdown. */
export interface NotionMarkdownContext {
  /** The page's stable Notion URL — the replacement target for expiring media. */
  readonly pageUrl: string;
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)/;

/**
 * Convert enhanced Markdown to plain Markdown. Line-oriented so a real code
 * fence is never rewritten and the tag/callout transforms never reach inside
 * one.
 */
export function normalizeNotionMarkdown(raw: string, ctx: NotionMarkdownContext): string {
  const withCallouts = convertCalloutFences(raw);
  const withoutLayoutTags = stripLayoutTags(withCallouts);
  const withStableMedia = replaceExpiringMedia(withoutLayoutTags, ctx.pageUrl);
  // Collapse 3+ blank lines the transforms can leave behind into the Markdown
  // paragraph break (exactly one blank line).
  return withStableMedia.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Rewrite ```` ```callout ```` fenced blocks as blockquotes. A non-callout
 * fence (real code) is copied verbatim, including its body — so callout/tag
 * processing never corrupts a code sample that happens to contain `<column>` or
 * a `> ` line.
 */
function convertCalloutFences(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(FENCE);
    if (match === null) {
      out.push(line);
      i++;
      continue;
    }
    const marker = match[2];
    const info = match[3];
    // Find the matching closing fence (same marker char, ≥ same length).
    const closeIdx = findFenceClose(lines, i + 1, marker[0], marker.length);
    const bodyLines = lines.slice(i + 1, closeIdx === -1 ? lines.length : closeIdx);
    if (info.toLowerCase() === "callout") {
      // Blockquote each body line; an empty body line stays a bare `>` so the
      // quote block doesn't break into two.
      for (const body of bodyLines) {
        out.push(body === "" ? ">" : `> ${body}`);
      }
    } else {
      // A real fenced block — emit it unchanged (open, body, close).
      out.push(line, ...bodyLines);
      if (closeIdx !== -1) out.push(lines[closeIdx]);
    }
    i = closeIdx === -1 ? lines.length : closeIdx + 1;
  }
  return out.join("\n");
}

/** Index of the closing fence at/after `from`, or -1 if the block is unterminated. */
function findFenceClose(lines: string[], from: number, char: string, minLen: number): number {
  for (let i = from; i < lines.length; i++) {
    const m = lines[i].match(FENCE);
    if (m !== null && m[2][0] === char && m[2].length >= minLen && m[3] === "") return i;
  }
  return -1;
}

/**
 * Drop Notion's layout tags and flatten their contents. `<columns>`/`<column>`
 * become plain vertical flow; `<details>` is unwrapped and its `<summary>`
 * becomes a bold lead line. Block-level tags (a line that is only the tag) are
 * removed; an inline `<summary>…</summary>` on its own line is converted.
 */
function stripLayoutTags(input: string): string {
  const out: string[] = [];
  // Track code-fence state so a tag INSIDE a real code sample is never stripped.
  let fence: { char: string; len: number } | null = null;
  for (const line of input.split("\n")) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch !== null) {
      const marker = fenceMatch[2];
      if (fence === null) {
        fence = { char: marker[0], len: marker.length };
      } else if (marker[0] === fence.char && marker.length >= fence.len && fenceMatch[3] === "") {
        fence = null;
      }
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }
    const trimmed = line.trim();

    // `<summary>Heading</summary>` → a bold lead line (the toggle's label).
    const summary = trimmed.match(/^<summary>([\s\S]*?)<\/summary>$/i);
    if (summary !== null) {
      const label = summary[1].trim();
      out.push(label === "" ? "" : `**${label}**`);
      continue;
    }

    // Column boundary: a new column starts a new vertical section — one blank
    // line so the previously side-by-side blocks don't run together.
    if (/^<column(\s[^>]*)?>$/i.test(trimmed) || /^<\/column>$/i.test(trimmed)) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }

    // Pure wrapper tags carry no content — drop them.
    if (
      /^<\/?columns(\s[^>]*)?>$/i.test(trimmed) ||
      /^<\/?details(\s[^>]*)?>$/i.test(trimmed)
    ) {
      continue;
    }

    out.push(line);
  }
  return out.join("\n");
}

/** Notion's short-lived file hosts — a URL served from one is expiring media. */
function isExpiringMediaUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // intentionally ignored: a relative or malformed target is not an expiring
    // absolute media URL — the parse failure IS the negative signal.
    return false;
  }
  const host = url.hostname.toLowerCase();
  // AWS pre-signed params are the surest signal, host-agnostic.
  if (url.searchParams.has("X-Amz-Signature") || url.searchParams.has("X-Amz-Expires")) {
    return true;
  }
  return (
    host.endsWith(".amazonaws.com") ||
    host === "file.notion.so" ||
    host.includes("notion-static")
  );
}

/**
 * Replace image/link targets pointing at expiring Notion media with a link to
 * the stable page. Runs over image syntax first (`![alt](url)`) then plain
 * links (`[text](url)`); both regexes are single-pass with disjoint character
 * classes (no nested quantifiers) so they stay linear on untrusted bodies.
 */
function replaceExpiringMedia(input: string, pageUrl: string): string {
  const withImages = input.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (whole, alt: string, url: string) => {
      if (!isExpiringMediaUrl(url)) return whole;
      const label = alt.trim() === "" ? "image" : alt.trim();
      return `[${label} — view in Notion](${pageUrl})`;
    },
  );
  return withImages.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (whole, text: string, url: string) => {
      if (!isExpiringMediaUrl(url)) return whole;
      const label = text.trim() === "" ? "view in Notion" : text.trim();
      return `[${label}](${pageUrl})`;
    },
  );
}
