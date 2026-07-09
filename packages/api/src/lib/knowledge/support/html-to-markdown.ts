/**
 * Shared **support-center HTML → Markdown** converter (#4396, PRD #4395).
 *
 * Every viable support/help-center platform (Zendesk Guide, Intercom Articles,
 * Help Scout, Freshdesk, Front, Zoho Desk, ServiceNow, Salesforce Knowledge)
 * returns article bodies as plain HTML — unlike Confluence's storage-XHTML
 * dialect — so the tier gets ONE converter, built with the anchor slice
 * (Zendesk) and consumed by every subsequent vendor. A support connector must
 * never fork its own HTML→markdown pass; vendor-specific shaping belongs in
 * the vendor's `documents.ts` (titles, paths, provenance), not here.
 *
 * The explicit **degradation policy** (PRD AC — "unconvertible constructs
 * degrade to counted placeholders, never silent drops"):
 *   - a set of known-safe tags are converted structurally (headings,
 *     paragraphs, lists, tables, code fences, blockquotes, links, inline
 *     formatting, definition lists);
 *   - images/media/embeds are text-first v1: not mirrored, replaced by a
 *     VISIBLE placeholder linking back to the vendor article, COUNTED under
 *     synthetic buckets (`#image`, `#iframe`, `#video`, …) in
 *     {@link HtmlConversionResult.degradations};
 *   - non-content machinery (`script`, `style`, `noscript`, `template`,
 *     comments) is removed outright — it carries no prose, so removal is safe
 *     handling, not a degradation;
 *   - every OTHER element renders its children, so prose is never dropped.
 *
 * Purity: no I/O, no vendor calls, deterministic. The only external inputs
 * beyond the HTML string are the article's canonical URL (every placeholder is
 * a live link back to the source) and the optional **cross-link rewriting
 * hook** — vendors use it to absolutize relative hrefs (e.g. Zendesk `/hc/…`
 * paths) against their article host.
 */

import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { isTag, isText } from "domhandler";

/** One kind of degradation and how many times it fired in a single article. */
export interface HtmlDegradation {
  /** A synthetic bucket: `#image`, `#iframe`, `#video`, `#audio`, `#embed`, `#svg`. */
  readonly name: string;
  readonly count: number;
}

export interface HtmlConversionResult {
  readonly markdown: string;
  /**
   * Every image/media/embed that could not be structurally converted, counted
   * by bucket. Empty when the article converted cleanly. The connector logs
   * the aggregate so a media-heavy article is a visible signal, never a silent
   * shrink — and each one is ALSO a placeholder line in `markdown`.
   */
  readonly degradations: readonly HtmlDegradation[];
}

export interface HtmlConvertOptions {
  /** The article's canonical vendor URL — every degradation placeholder links here. */
  readonly pageUrl: string;
  /**
   * Cross-link rewriting hook: every RENDERED `<a href>` is passed through it
   * before rendering (empty and unsafe-scheme hrefs — `javascript:`, `data:`,
   * `vbscript:` — are dropped first and never reach it). Vendors absolutize
   * relative article links here (e.g. resolve `/hc/en-us/articles/123`
   * against the brand host). Default: identity.
   */
  readonly rewriteLink?: (href: string) => string;
}

/** A mutable degradation tally threaded through one article's conversion. */
class Degradations {
  private readonly counts = new Map<string, number>();
  bump(name: string): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  list(): HtmlDegradation[] {
    return [...this.counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}

/** Convert one article's HTML body to markdown. */
export function convertSupportHtmlToMarkdown(
  html: string,
  options: HtmlConvertOptions,
): HtmlConversionResult {
  const degradations = new Degradations();
  // HTML mode (not xmlMode): help-center bodies are real-world HTML — named
  // entities, unclosed tags, case-insensitive names. htmlparser2 decodes
  // entities during tokenization here, so text/attribute reads are already
  // plain text (no second decode anywhere — a literal `&amp;nbsp;` in the
  // source stays `&nbsp;` as prose).
  const doc = parseDocument(html);
  const ctx: Ctx = {
    degradations,
    pageUrl: options.pageUrl,
    rewriteLink: options.rewriteLink ?? ((href) => href),
  };
  const markdown = renderBlocks(doc.children, ctx);
  return {
    markdown: normalizeBlankLines(markdown),
    degradations: degradations.list(),
  };
}

interface Ctx {
  readonly degradations: Degradations;
  readonly pageUrl: string;
  readonly rewriteLink: (href: string) => string;
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function isElement(node: ChildNode): node is Element {
  return isTag(node);
}

/** Concatenated text of a node subtree (entities already decoded at parse). */
function textOf(node: ChildNode): string {
  if (isText(node)) return node.data;
  if (isElement(node)) return node.children.map((c) => textOf(c)).join("");
  return "";
}

/**
 * Non-content machinery removed outright — no prose lives here, so removal is
 * the SAFE handling (rendering a `<script>` body as prose would be worse than
 * dropping it), and it is deliberately not counted as a degradation.
 */
const REMOVED_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "base"]);

/** Media/embed tags degraded to a counted placeholder (text-first v1). */
const MEDIA_BUCKETS: Record<string, string> = {
  img: "#image",
  picture: "#image",
  svg: "#svg",
  iframe: "#iframe",
  video: "#video",
  audio: "#audio",
  embed: "#embed",
  object: "#embed",
  canvas: "#embed",
};

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Render a sequence of nodes as block-level markdown, blank-line separated. */
function renderBlocks(nodes: readonly ChildNode[], ctx: Ctx): string {
  const blocks: string[] = [];
  for (const node of nodes) {
    const block = renderBlock(node, ctx);
    if (block.trim() !== "") blocks.push(block.trimEnd());
  }
  return blocks.join("\n\n");
}

function renderBlock(node: ChildNode, ctx: Ctx): string {
  if (isText(node)) {
    const text = collapseInlineWhitespace(node.data);
    return text.trim() === "" ? "" : text.trim();
  }
  if (!isElement(node)) return "";

  const name = node.name.toLowerCase();
  if (REMOVED_TAGS.has(name)) return "";
  if (name in HEADINGS) {
    return `${"#".repeat(HEADINGS[name])} ${renderInline(node.children, ctx).trim()}`;
  }
  if (name in MEDIA_BUCKETS) return degradeMedia(node, name, ctx);
  switch (name) {
    case "p":
    case "div":
      return renderInline(node.children, ctx).trim();
    case "ul":
    case "ol":
      return renderList(node, ctx, 0);
    case "table":
      return renderTable(node, ctx);
    case "blockquote":
      return blockquote(renderBlocks(node.children, ctx));
    case "pre":
      return renderPre(node);
    case "hr":
      return "---";
    case "dl":
      return renderDefinitionList(node, ctx);
    case "figure":
      return renderBlocks(node.children, ctx);
    case "details":
      return renderDetails(node, ctx);
    default:
      // Unknown/structural block element (section, article, main, aside, …):
      // render its children so prose is never dropped.
      return renderBlocks(node.children, ctx);
  }
}

/** `<pre>` → a fenced block; language sniffed from `class="language-x"`. */
function renderPre(el: Element): string {
  let language = languageFromClass(el.attribs.class);
  if (language === "") {
    const code = el.children.find((c): c is Element => isElement(c) && c.name.toLowerCase() === "code");
    if (code) language = languageFromClass(code.attribs.class);
  }
  return fence(language, textOf(el).replace(/\n$/, ""));
}

/** Extract a fence language from a `language-x` / `lang-x` class token. */
function languageFromClass(cls: string | undefined): string {
  if (!cls) return "";
  const match = /(?:^|\s)(?:language|lang)-([\w#+-]+)/.exec(cls);
  return match ? match[1] : "";
}

/** `<dl>` — terms bold, definitions indented under them. */
function renderDefinitionList(el: Element, ctx: Ctx): string {
  const lines: string[] = [];
  for (const child of el.children) {
    if (!isElement(child)) continue;
    const name = child.name.toLowerCase();
    if (name === "dt") {
      const term = renderInline(child.children, ctx).trim();
      if (term !== "") lines.push(`**${term}**`);
    } else if (name === "dd") {
      const def = renderInline(child.children, ctx).trim();
      if (def !== "") lines.push(`: ${def}`);
    }
  }
  return lines.join("\n");
}

/** `<details>`/`<summary>` — bold summary line, body rendered under it. */
function renderDetails(el: Element, ctx: Ctx): string {
  const summaryEl = el.children.find(
    (c): c is Element => isElement(c) && c.name.toLowerCase() === "summary",
  );
  const rest = el.children.filter((c) => c !== summaryEl);
  const summary = summaryEl ? renderInline(summaryEl.children, ctx).trim() : "";
  const inner = renderBlocks(rest, ctx);
  if (summary === "") return inner;
  return inner === "" ? `**${summary}**` : `**${summary}**\n\n${inner}`;
}

/**
 * Degrade a media/embed element to a visible placeholder that links back to
 * the vendor article — counted, never a silent drop (text-first v1: no media
 * mirroring, same posture as the Confluence/Notion connectors).
 */
function degradeMedia(el: Element, name: string, ctx: Ctx): string {
  const bucket = MEDIA_BUCKETS[name];
  ctx.degradations.bump(bucket);
  const label = mediaLabel(el, name);
  return `[${label} — view on the original page](${ctx.pageUrl})`;
}

/** A human label for a degraded media element (alt/title/src basename). */
function mediaLabel(el: Element, name: string): string {
  const kind =
    name === "img" || name === "picture" ? "Image"
    : name === "svg" ? "Image"
    : name === "video" ? "Video"
    : name === "audio" ? "Audio"
    : name === "iframe" ? "Embedded content"
    : "Embedded content";
  const alt = el.attribs.alt?.trim();
  const title = el.attribs.title?.trim();
  const detail = alt || title || srcBasename(el.attribs.src);
  return detail ? `${kind}: ${detail}` : kind;
}

/** The final path segment of a `src` URL, sans query — or empty. */
function srcBasename(src: string | undefined): string {
  if (!src) return "";
  const path = src.split(/[?#]/, 1)[0];
  const segment = path.split("/").filter((s) => s !== "").at(-1) ?? "";
  // A bare host (no path) is noise, not a filename.
  return segment.includes(".") ? segment : "";
}

function renderList(listEl: Element, ctx: Ctx, depth: number): string {
  const ordered = listEl.name.toLowerCase() === "ol";
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let index = 1;
  for (const li of listEl.children) {
    if (!isElement(li) || li.name.toLowerCase() !== "li") continue;
    const marker = ordered ? `${index}.` : "-";
    // Split the <li> into inline lead content and any nested lists.
    const nested: Element[] = [];
    const leadNodes: ChildNode[] = [];
    for (const child of li.children) {
      if (isElement(child) && (child.name.toLowerCase() === "ul" || child.name.toLowerCase() === "ol")) {
        nested.push(child);
      } else {
        leadNodes.push(child);
      }
    }
    const lead = renderInline(leadNodes, ctx).trim() || " ";
    lines.push(`${indent}${marker} ${lead}`);
    for (const sub of nested) lines.push(renderList(sub, ctx, depth + 1));
    index++;
  }
  return lines.join("\n");
}

function renderTable(tableEl: Element, ctx: Ctx): string {
  // Help centers wrap rows in <tbody> (and sometimes <thead>); gather every <tr>.
  const rows: Element[] = [];
  const collectRows = (el: Element) => {
    for (const child of el.children) {
      if (!isElement(child)) continue;
      const name = child.name.toLowerCase();
      if (name === "tr") rows.push(child);
      else if (name === "thead" || name === "tbody" || name === "tfoot") {
        collectRows(child);
      }
    }
  };
  collectRows(tableEl);
  if (rows.length === 0) return "";

  const renderRow = (tr: Element): string[] =>
    tr.children
      .filter((c): c is Element => {
        if (!isElement(c)) return false;
        const name = c.name.toLowerCase();
        return name === "td" || name === "th";
      })
      .map((cell) => cellText(cell, ctx));

  const firstIsHeader = rows[0].children.some(
    (c) => isElement(c) && c.name.toLowerCase() === "th",
  );
  const bodyRows = firstIsHeader ? rows.slice(1) : rows;
  const headerCells = firstIsHeader ? renderRow(rows[0]) : [];
  const columnCount = Math.max(
    headerCells.length,
    ...bodyRows.map((r) => renderRow(r).length),
    1,
  );

  const pad = (cells: string[]) => {
    const out = [...cells];
    while (out.length < columnCount) out.push("");
    return out;
  };
  const header = firstIsHeader ? pad(headerCells) : new Array<string>(columnCount).fill("");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${new Array<string>(columnCount).fill("---").join(" | ")} |`,
  ];
  for (const row of bodyRows) lines.push(`| ${pad(renderRow(row)).join(" | ")} |`);
  return lines.join("\n");
}

/** A table cell: inline markdown with pipes escaped and newlines flattened. */
function cellText(cell: Element, ctx: Ctx): string {
  return renderInline(cell.children, ctx)
    .replace(/\r?\n+/g, "<br>")
    // Escape backslashes FIRST: text nodes are emitted raw, so a source `\`
    // reaches here unescaped. Escaping only `|` would let `a\|b` become
    // `a\\|b` — a literal backslash + a LIVE pipe that splits/injects a table
    // column. GFM undoes `\\`→`\` and `\|`→`|` before inline/code-span
    // parsing, so escaping both (backslash before pipe) is the composable
    // transform. (Same reasoning as the Confluence converter.)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function renderInline(nodes: readonly ChildNode[], ctx: Ctx): string {
  let out = "";
  for (const node of nodes) out += renderInlineNode(node, ctx);
  return out;
}

function renderInlineNode(node: ChildNode, ctx: Ctx): string {
  if (isText(node)) return collapseInlineWhitespace(node.data);
  if (!isElement(node)) return "";

  const name = node.name.toLowerCase();
  if (REMOVED_TAGS.has(name)) return "";
  if (name in MEDIA_BUCKETS) return degradeMedia(node, name, ctx);

  const inner = () => renderInline(node.children, ctx);
  switch (name) {
    case "strong":
    case "b":
      return wrapNonEmpty(inner(), "**");
    case "em":
    case "i":
      return wrapNonEmpty(inner(), "*");
    case "code":
    case "kbd":
    case "samp":
      return wrapNonEmpty(textOf(node), "`");
    case "s":
    case "del":
    case "strike":
      return wrapNonEmpty(inner(), "~~");
    case "br":
      return "\n";
    case "a": {
      const href = node.attribs.href?.trim() ?? "";
      const text = inner().trim();
      if (href === "" || hasUnsafeLinkScheme(href)) return text;
      return `[${text || href}](${ctx.rewriteLink(href)})`;
    }
    default:
      // span/u/sub/sup/small/mark/abbr/time/font and anything unknown: render
      // children so prose is never dropped.
      return inner();
  }
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/**
 * True for hrefs whose scheme executes or smuggles content when the mirrored
 * markdown is later rendered in a web surface — `javascript:`, `data:`, and
 * `vbscript:` links are dropped (their anchor TEXT is kept, so no prose is
 * lost). Control characters and whitespace are stripped before the check
 * because HTML parsers ignore them inside a scheme (`java\nscript:` is live
 * in a browser), so a naive prefix test would be bypassable.
 */
function hasUnsafeLinkScheme(href: string): boolean {
  // oxlint-disable-next-line no-control-regex -- stripping control chars from an untrusted href IS the point (browsers ignore them inside a scheme)
  const normalized = href.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("vbscript:")
  );
}

function wrapNonEmpty(inner: string, delim: string): string {
  const trimmed = inner.trim();
  return trimmed === "" ? "" : `${delim}${trimmed}${delim}`;
}

function fence(language: string, body: string): string {
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

function blockquote(content: string): string {
  return content
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** Collapse runs of inline whitespace (incl. NBSP) to single spaces. */
function collapseInlineWhitespace(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ");
}

/** Collapse 3+ newlines to a paragraph break and trim the result. */
function normalizeBlankLines(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}
