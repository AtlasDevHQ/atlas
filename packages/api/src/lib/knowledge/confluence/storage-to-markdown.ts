/**
 * Confluence **storage-format XHTML → Markdown** converter (#4377, PRD #4375).
 *
 * Confluence Cloud has no official markdown output — the REST v2 body-format
 * `storage` returns Atlassian's XHTML-with-macros dialect (`<ac:…>` /
 * `<ri:…>` namespaced elements). This is the pure, golden-fixture-tested heart
 * of the Confluence connector: given one page's storage XHTML, produce clean
 * markdown plus a **counted** list of every macro/image that degraded.
 *
 * The explicit **macro policy** (PRD AC — "unconvertible macros degrade to
 * counted placeholders, never silent drops"):
 *   - a set of known macros are converted structurally (code fences, admonition
 *     blockquotes, expand, task lists, status/emoji inline, no-format);
 *   - every OTHER macro degrades to a VISIBLE placeholder pointing at the
 *     vendor page, COUNTED by macro name in {@link ConversionResult.degradations}.
 *     In BLOCK position the inner prose (`ac:rich-text-body` /
 *     `ac:plain-text-body`) is still rendered under the placeholder, so block
 *     content is never lost; an unknown macro in INLINE position degrades to
 *     the placeholder link alone (its inner body is not rendered);
 *   - attachments/images are text-first v1: not mirrored, replaced by a link to
 *     the vendor page and counted under the synthetic `#image` / `#attachment`
 *     buckets.
 *
 * Purity: no I/O, no vendor calls, deterministic. The only external input
 * beyond the storage string is the page's canonical URL, used so every
 * placeholder is a live link back to the source page.
 */

import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { isTag, isText, isCDATA } from "domhandler";
import { decodeHTML } from "entities";

/** One kind of degradation and how many times it fired in a single page. */
export interface MacroDegradation {
  /** The `ac:name` of the macro, or a synthetic `#image` / `#attachment` bucket. */
  readonly name: string;
  readonly count: number;
}

export interface ConversionResult {
  readonly markdown: string;
  /**
   * Every macro/image that could not be structurally converted, counted by
   * name. Empty when the page converted cleanly. The connector logs the
   * aggregate so a page full of unsupported macros is a visible signal, never a
   * silent shrink — and each one is ALSO a placeholder line in `markdown`.
   */
  readonly degradations: readonly MacroDegradation[];
}

export interface ConvertOptions {
  /** The page's canonical Confluence URL — every degradation placeholder links here. */
  readonly pageUrl: string;
}

/**
 * Macros converted structurally. Everything else becomes a counted
 * placeholder. Kept small and explicit — a macro earns a place here only when
 * it has a faithful markdown shape. Position matters: `status` is converted
 * only INLINE (`renderMacroInline`); in block position it has no structural
 * branch in `renderMacroBlock` and degrades like any unknown macro. The
 * block-shaped members used inline fall back to their plain text.
 */
const CONVERTED_MACROS = new Set([
  "code",
  "noformat",
  "info",
  "note",
  "warning",
  "tip",
  "panel",
  "expand",
  "status",
]);

/** Admonition macros → a labelled blockquote. */
const ADMONITION_LABEL: Record<string, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  tip: "Tip",
  panel: "Panel",
};

/** A mutable degradation tally threaded through one page's conversion. */
class Degradations {
  private readonly counts = new Map<string, number>();
  bump(name: string): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  list(): MacroDegradation[] {
    return [...this.counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}

/** Convert one page's Confluence storage XHTML to markdown. */
export function convertStorageToMarkdown(
  storage: string,
  options: ConvertOptions,
): ConversionResult {
  const degradations = new Degradations();
  // xmlMode so `ac:`/`ri:` namespaced tags parse as elements (not unknown HTML)
  // and CDATA bodies (code) are preserved verbatim. decodeEntities is OFF: the
  // XML tokenizer only knows the five XML entities, but storage prose is full
  // of NAMED HTML entities (`&nbsp;`, `&mdash;`, …). We decode ONCE at render
  // time via `decodeHTML` on text/attributes so those resolve and there is no
  // double-decode of a literal `&amp;nbsp;`; CDATA payloads are never decoded.
  const doc = parseDocument(storage, { xmlMode: true, decodeEntities: false });
  const ctx: Ctx = { degradations, pageUrl: options.pageUrl };
  const markdown = renderBlocks(doc.children, ctx);
  return {
    markdown: normalizeBlankLines(markdown),
    degradations: degradations.list(),
  };
}

interface Ctx {
  readonly degradations: Degradations;
  readonly pageUrl: string;
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function isElement(node: ChildNode): node is Element {
  return isTag(node);
}

/** Element by tag name among a node's children (namespaced names included). */
function childByName(el: Element, name: string): Element | undefined {
  for (const child of el.children) {
    if (isElement(child) && child.name === name) return child;
  }
  return undefined;
}

function childrenByName(el: Element, name: string): Element[] {
  return el.children.filter((c): c is Element => isElement(c) && c.name === name);
}

/** `<ac:parameter ac:name="X">value</ac:parameter>` → value, or undefined. */
function macroParam(el: Element, paramName: string): string | undefined {
  for (const param of childrenByName(el, "ac:parameter")) {
    if (param.attribs["ac:name"] === paramName) return textOf(param).trim();
  }
  return undefined;
}

/** A used attribute value, HTML-entity decoded (e.g. `&amp;` in a query string). */
function attr(el: Element, name: string): string | undefined {
  const raw = el.attribs[name];
  return raw === undefined ? undefined : decodeHTML(raw);
}

/**
 * Concatenated text of a node subtree. Text nodes are HTML-entity decoded
 * (parse ran with `decodeEntities: false`); CDATA payloads are returned
 * VERBATIM (code must not be entity-mangled).
 */
function textOf(node: ChildNode | Element): string {
  if (isText(node)) return decodeHTML(node.data);
  if (isCDATA(node)) {
    // A CDATA node wraps text children carrying the verbatim payload — no decode.
    return node.children.map((c) => (isText(c) ? c.data : "")).join("");
  }
  if (isElement(node)) {
    return node.children.map((c) => textOf(c)).join("");
  }
  return "";
}

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
    const text = collapseInlineWhitespace(decodeHTML(node.data));
    return text.trim() === "" ? "" : text.trim();
  }
  if (!isElement(node)) return "";

  const name = node.name;
  if (name in HEADINGS) {
    return `${"#".repeat(HEADINGS[name])} ${renderInline(node.children, ctx).trim()}`;
  }
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
      return fence("", textOf(node).replace(/\n$/, ""));
    case "hr":
      return "---";
    case "ac:structured-macro":
      return renderMacroBlock(node, ctx);
    case "ac:image":
      // A standalone (block-level) image — still counted + linked, never dropped.
      return renderImage(node, ctx);
    case "ac:link":
      return renderAcLink(node, ctx);
    case "ac:layout":
    case "ac:layout-section":
    case "ac:layout-cell":
    case "ac:adf-extension":
    case "ac:rich-text-body":
    case "ac:confluence-content":
      // Structural wrappers — recurse into their block children.
      return renderBlocks(node.children, ctx);
    case "ac:task-list":
      return renderTaskList(node, ctx);
    default:
      // Unknown block element: render its children so prose is never dropped.
      return renderBlocks(node.children, ctx);
  }
}

/** A Confluence structured macro in block position. */
function renderMacroBlock(el: Element, ctx: Ctx): string {
  const macroName = el.attribs["ac:name"] ?? "unknown";

  if (macroName === "code" || macroName === "noformat") {
    const language = macroName === "code" ? macroParam(el, "language") ?? "" : "";
    const body = childByName(el, "ac:plain-text-body");
    return fence(language, body ? textOf(body).replace(/\n$/, "") : "");
  }

  if (macroName in ADMONITION_LABEL) {
    const richBody = childByName(el, "ac:rich-text-body");
    const inner = richBody ? renderBlocks(richBody.children, ctx) : "";
    const title = macroParam(el, "title");
    const label = title ? `${ADMONITION_LABEL[macroName]}: ${title}` : ADMONITION_LABEL[macroName];
    return blockquote(inner === "" ? `**${label}**` : `**${label}**\n\n${inner}`);
  }

  if (macroName === "expand") {
    const richBody = childByName(el, "ac:rich-text-body");
    const inner = richBody ? renderBlocks(richBody.children, ctx) : "";
    const title = macroParam(el, "title") ?? "Details";
    return inner === "" ? `**${title}**` : `**${title}**\n\n${inner}`;
  }

  // Not structurally convertible → counted, visible placeholder, prose kept.
  return degradeMacro(el, macroName, ctx);
}

/**
 * Degrade an unconvertible macro to a visible placeholder that links to the
 * vendor page — while still rendering any inner prose so content is never lost.
 */
function degradeMacro(el: Element, macroName: string, ctx: Ctx): string {
  ctx.degradations.bump(macroName);
  const placeholder = `> ⚠️ Unsupported Confluence macro \`${macroName}\` — [view on the original page](${ctx.pageUrl})`;
  const richBody = childByName(el, "ac:rich-text-body");
  if (richBody) {
    const inner = renderBlocks(richBody.children, ctx);
    return inner === "" ? placeholder : `${placeholder}\n\n${inner}`;
  }
  const plainBody = childByName(el, "ac:plain-text-body");
  if (plainBody) {
    return `${placeholder}\n\n${fence("", textOf(plainBody).replace(/\n$/, ""))}`;
  }
  return placeholder;
}

function renderList(listEl: Element, ctx: Ctx, depth: number): string {
  const ordered = listEl.name === "ol";
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let index = 1;
  for (const li of childrenByName(listEl, "li")) {
    const marker = ordered ? `${index}.` : "-";
    // Split the <li> into inline lead content and any nested lists.
    const nested: Element[] = [];
    const leadNodes: ChildNode[] = [];
    for (const child of li.children) {
      if (isElement(child) && (child.name === "ul" || child.name === "ol")) {
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

function renderTaskList(listEl: Element, ctx: Ctx): string {
  const lines: string[] = [];
  for (const task of childrenByName(listEl, "ac:task")) {
    const status = childByName(task, "ac:task-status");
    const done = status ? textOf(status).trim() === "complete" : false;
    const body = childByName(task, "ac:task-body");
    const text = body ? renderInline(body.children, ctx).trim() : "";
    lines.push(`- [${done ? "x" : " "}] ${text}`);
  }
  return lines.join("\n");
}

function renderTable(tableEl: Element, ctx: Ctx): string {
  // Confluence wraps rows in <tbody> (and sometimes <thead>); gather every <tr>.
  const rows: Element[] = [];
  const collectRows = (el: Element) => {
    for (const child of el.children) {
      if (!isElement(child)) continue;
      if (child.name === "tr") rows.push(child);
      else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") {
        collectRows(child);
      }
    }
  };
  collectRows(tableEl);
  if (rows.length === 0) return "";

  const renderRow = (tr: Element): string[] =>
    tr.children
      .filter((c): c is Element => isElement(c) && (c.name === "td" || c.name === "th"))
      .map((cell) => cellText(cell, ctx));

  const firstIsHeader = rows[0].children.some((c) => isElement(c) && c.name === "th");
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
    // Escape backslashes FIRST: text nodes are emitted raw (see renderInlineNode),
    // so a source `\` reaches here unescaped. Escaping only `|` lets `a\|b` become
    // `a\\|b` — a literal backslash + a LIVE pipe that splits/injects a table column.
    // GFM undoes `\\`→`\` and `\|`→`|` before inline/code-span parsing, so escaping
    // both (backslash before pipe) is the structurally-correct, composable transform.
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
  if (isText(node)) return collapseInlineWhitespace(decodeHTML(node.data));
  if (isCDATA(node)) return textOf(node);
  if (!isElement(node)) return "";

  const inner = () => renderInline(node.children, ctx);
  switch (node.name) {
    case "strong":
    case "b":
      return wrapNonEmpty(inner(), "**");
    case "em":
    case "i":
      return wrapNonEmpty(inner(), "*");
    case "code":
      return wrapNonEmpty(textOf(node), "`");
    case "s":
    case "del":
    case "strike":
      return wrapNonEmpty(inner(), "~~");
    case "br":
      return "\n";
    case "sub":
    case "sup":
    case "span":
    case "u":
      return inner();
    case "a": {
      const href = attr(node, "href") ?? "";
      const text = inner().trim();
      return href === "" ? text : `[${text || href}](${href})`;
    }
    case "ac:link":
      return renderAcLink(node, ctx);
    case "ac:image":
      return renderImage(node, ctx);
    case "ac:emoticon":
      return attr(node, "ac:emoji-fallback") ?? "";
    case "time":
      return attr(node, "datetime") ?? inner();
    case "ac:structured-macro":
      return renderMacroInline(node, ctx);
    default:
      return inner();
  }
}

/** A structured macro appearing inline (`status`, or an unknown inline macro). */
function renderMacroInline(el: Element, ctx: Ctx): string {
  const macroName = el.attribs["ac:name"] ?? "unknown";
  if (macroName === "status") {
    const title = macroParam(el, "title");
    return title ? `\`${title}\`` : "";
  }
  if (!CONVERTED_MACROS.has(macroName)) {
    ctx.degradations.bump(macroName);
    return `[unsupported macro: ${macroName}](${ctx.pageUrl})`;
  }
  // A normally-block macro used inline: fall back to its plain text.
  return textOf(el).trim();
}

/** `<ac:link>` — cross-page/user/attachment links Atlas can't resolve to a URL. */
function renderAcLink(el: Element, ctx: Ctx): string {
  const bodyEl =
    childByName(el, "ac:link-body") ?? childByName(el, "ac:plain-text-link-body");
  const bodyText = bodyEl ? renderInline(bodyEl.children, ctx).trim() : "";

  const page = childByName(el, "ri:page");
  if (page) {
    const title = attr(page, "ri:content-title") ?? "";
    const label = bodyText || title;
    return label === "" ? "" : `[${label}](${ctx.pageUrl})`;
  }
  const attachment = childByName(el, "ri:attachment");
  if (attachment) {
    const filename = attr(attachment, "ri:filename") ?? "attachment";
    ctx.degradations.bump("#attachment");
    return `[${bodyText || filename} (attachment — view on the original page)](${ctx.pageUrl})`;
  }
  const user = childByName(el, "ri:user");
  if (user) return bodyText || "@user";
  return bodyText;
}

/** `<ac:image>` — text-first v1: not mirrored, linked back to the vendor page. */
function renderImage(el: Element, ctx: Ctx): string {
  ctx.degradations.bump("#image");
  const attachment = childByName(el, "ri:attachment");
  const url = childByName(el, "ri:url");
  const label =
    (attachment ? attr(attachment, "ri:filename") : undefined) ??
    (url ? attr(url, "ri:value") : undefined) ??
    attr(el, "ac:alt") ??
    "image";
  return `[Image: ${label} — view on the original page](${ctx.pageUrl})`;
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

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

/** Collapse 3+ newlines to a paragraph break and trim trailing whitespace. */
function normalizeBlankLines(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}
