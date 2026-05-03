import SUBPROCESSORS from "../../../../data/sub-processors.json";

export const dynamic = "force-static";

const FEED_URL = "https://www.useatlas.dev/sub-processors/feed.xml";
const HTML_URL = "https://www.useatlas.dev/dpa#annex-i-subprocessors";

interface SubProcessor {
  name: string;
  purpose: string;
  region: string;
  /** Display string from the source JSON — `YYYY-MM` or `YYYY-MM-DD`. */
  since: string;
  /** ISO date — must be a full `YYYY-MM-DD`. Drives Atom <updated>. */
  changed_at: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Atom requires RFC 3339 timestamps. Source JSON carries either `YYYY-MM-DD`
// (preferred) or the historical `YYYY-MM` shorthand from the pre-extraction
// inline literal — pad the latter to the 1st of the month so feed readers
// don't reject the document.
function toRfc3339(date: string): string {
  const padded = /^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date;
  return `${padded}T00:00:00Z`;
}

// Tag URI per RFC 4151. The `name` segment may contain characters that
// need percent-encoding for URI-safety (spaces, `&`, non-ASCII). Wrap
// with encodeURIComponent so vendor names like "AT&T" or "Google Cloud"
// produce a valid id, then let escapeXml at the call site take care of
// any remaining XML-reserved chars in the surrounding element body.
function tagUri(entry: SubProcessor): string {
  const datePart = toRfc3339(entry.changed_at).slice(0, 10);
  return `tag:useatlas.dev,${datePart}:sub-processors/${encodeURIComponent(entry.name)}`;
}

function feedUpdated(entries: readonly SubProcessor[]): string {
  const max = entries
    .map((e) => toRfc3339(e.changed_at))
    .sort()
    .at(-1);
  // `entries` is the static sub-processor list; it is non-empty by construction.
  // The `?? toRfc3339(...)` fallback exists only to keep the return type a string
  // for the empty-array edge case TS can't rule out from a JSON import.
  return max ?? toRfc3339(new Date().toISOString().slice(0, 10));
}

function renderEntry(entry: SubProcessor): string {
  const updated = toRfc3339(entry.changed_at);
  const published = toRfc3339(entry.since);
  const summary = `${entry.purpose} · Region: ${entry.region}`;
  return `  <entry>
    <id>${escapeXml(tagUri(entry))}</id>
    <title>${escapeXml(`${entry.name} — ${entry.purpose}`)}</title>
    <updated>${updated}</updated>
    <published>${published}</published>
    <link rel="alternate" type="text/html" href="${HTML_URL}"/>
    <author><name>Atlas DevHQ</name></author>
    <summary>${escapeXml(summary)}</summary>
  </entry>`;
}

function renderFeed(entries: readonly SubProcessor[]): string {
  const updated = feedUpdated(entries);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${FEED_URL}</id>
  <title>Atlas — Sub-processor changes</title>
  <subtitle>Annex I sub-processor additions, replacements, and removals. Source of truth: https://www.useatlas.dev/dpa#annex-i-subprocessors</subtitle>
  <link rel="self" type="application/atom+xml" href="${FEED_URL}"/>
  <link rel="alternate" type="text/html" href="${HTML_URL}"/>
  <updated>${updated}</updated>
  <author><name>Atlas DevHQ</name><email>legal@useatlas.dev</email></author>
${entries.map(renderEntry).join("\n")}
</feed>
`;
}

export function GET(): Response {
  return new Response(renderFeed(SUBPROCESSORS as SubProcessor[]), {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
