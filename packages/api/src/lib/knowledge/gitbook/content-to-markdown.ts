/**
 * GitBook **markdown → honest CommonMark** converter (#4393, ADR-0030).
 *
 * GitBook's `?format=markdown` output is markdown-native, but carries GitBook's
 * `{% … %}` block extensions (hints, tabs, code-with-title, steppers, embeds,
 * content-refs, OpenAPI blocks, …). This is the pure, golden-fixture-tested
 * heart of the GitBook connector: given one page's GitBook-flavored markdown,
 * produce clean CommonMark plus a **counted** list of every block that degraded.
 *
 * The explicit **block policy** (AC — "unconvertible constructs degrade to
 * counted placeholders, never silent drops"):
 *   - a set of known blocks are converted structurally (hints → labelled
 *     blockquotes; `code` → its inner fence, keeping the title; `tabs`/`tab`,
 *     `stepper`/`step`, `columns`/`column`, `expand` → labelled/unwrapped
 *     sections; `content-ref`/`embed` → plain links);
 *   - every OTHER `{% … %}` block degrades to a VISIBLE placeholder pointing at
 *     the vendor page, COUNTED by block name in
 *     {@link ConversionResult.degradations}. A PAIRED unknown block still renders
 *     its inner prose under the placeholder, so content is never lost; a
 *     STANDALONE unknown block degrades to the placeholder link alone.
 *
 * Purity: no I/O, no vendor calls, deterministic. The only external input beyond
 * the markdown string is the page's canonical URL, used so every placeholder is
 * a live link back to the source page.
 *
 * Scope note: `{% … %}` tokens are transformed everywhere, including inside
 * fenced code blocks. GitBook's own export escapes literal block tags in code
 * samples, so in practice a fence never carries a real `{% … %}` block; a page
 * that documents GitBook's own syntax is the one edge this doesn't round-trip.
 */

/** One kind of degradation and how many times it fired in a single page. */
export interface BlockDegradation {
  /** The GitBook block name (`{% <name> … %}`), e.g. `openapi`, `file`. */
  readonly name: string;
  readonly count: number;
}

export interface ConversionResult {
  readonly markdown: string;
  /**
   * Every GitBook block that could not be structurally converted, counted by
   * name. Empty when the page converted cleanly. The connector logs the
   * aggregate so a page full of unsupported blocks is a visible signal, never a
   * silent shrink — and each one is ALSO a placeholder line in `markdown`.
   */
  readonly degradations: readonly BlockDegradation[];
}

export interface ConvertOptions {
  /** The page's canonical GitBook URL — every degradation placeholder links here. */
  readonly pageUrl: string;
}

/** Hint styles → a blockquote label. Default (unknown style) → "Note". */
const HINT_LABEL: Record<string, string> = {
  info: "Info",
  note: "Note",
  tip: "Tip",
  success: "Success",
  warning: "Warning",
  danger: "Danger",
};

/** A mutable degradation tally threaded through one page's conversion. */
class Degradations {
  private readonly counts = new Map<string, number>();
  bump(name: string): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  list(): BlockDegradation[] {
    return [...this.counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}

interface Ctx {
  readonly degradations: Degradations;
  readonly pageUrl: string;
}

/** A parsed `{% name attrs %}` opening or `{% endname %}` closing tag. */
interface Tag {
  /** Byte offset of the `{%`. */
  readonly start: number;
  /** Byte offset just past the `%}`. */
  readonly end: number;
  /** Lower-cased tag name (without a leading `end`). */
  readonly name: string;
  /** True for a `{% end<name> %}` closer. */
  readonly closing: boolean;
  /** Raw attribute string after the name (opening tags only). */
  readonly attrs: string;
}

const TAG_RE = /\{%\s*([\s\S]*?)\s*%\}/g;

/** Parse one `{% … %}` match body into a {@link Tag}. */
function parseTag(match: RegExpExecArray): Tag {
  const body = match[1].trim();
  const firstSpace = body.search(/\s/);
  const word = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();
  if (word.startsWith("end") && word.length > 3) {
    return { start: match.index, end: TAG_RE.lastIndex, name: word.slice(3), closing: true, attrs: "" };
  }
  return { start: match.index, end: TAG_RE.lastIndex, name: word, closing: false, attrs: rest };
}

/** Every `{% … %}` tag in `input`, in order. */
function scanTags(input: string): Tag[] {
  const tags: Tag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(input)) !== null) {
    if (m[0].length === 0) {
      TAG_RE.lastIndex++; // defensive: never spin on a zero-width match
      continue;
    }
    tags.push(parseTag(m));
  }
  return tags;
}

/** Parse `key="value"` attributes into a map (GitBook always double-quotes). */
function parseAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) out[m[1].toLowerCase()] = m[2];
  return out;
}

/**
 * Convert one page's GitBook-flavored markdown to honest CommonMark. Text
 * outside `{% … %}` blocks passes through unchanged; blocks are transformed or
 * degraded (and counted) per the block policy above.
 */
export function convertGitbookMarkdown(
  markdown: string,
  options: ConvertOptions,
): ConversionResult {
  const degradations = new Degradations();
  const ctx: Ctx = { degradations, pageUrl: options.pageUrl };
  const rendered = renderSegment(markdown, ctx);
  return { markdown: normalizeBlankLines(rendered), degradations: degradations.list() };
}

/**
 * Render a run of markdown, transforming top-level `{% … %}` blocks. Recurses
 * into each block's inner content so nested blocks (a hint inside a tab, …) are
 * handled uniformly.
 */
function renderSegment(input: string, ctx: Ctx): string {
  const tags = scanTags(input);
  if (tags.length === 0) return input;

  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < tags.length) {
    const tag = tags[i];
    if (tag.start < cursor) {
      // A tag already consumed inside a previous block's span — skip it.
      i++;
      continue;
    }
    out += input.slice(cursor, tag.start);

    if (tag.closing) {
      // A stray closer with no matching opener — drop the tag, keep going.
      cursor = tag.end;
      i++;
      continue;
    }

    const closerIdx = findMatchingCloser(tags, i);
    if (closerIdx === -1) {
      // Standalone block (embed/file/include/…) — no `{% end… %}`.
      out += renderStandalone(tag, ctx);
      cursor = tag.end;
      i++;
      continue;
    }

    const closer = tags[closerIdx];
    const inner = input.slice(tag.end, closer.start);
    out += renderPairedBlock(tag, inner, ctx);
    cursor = closer.end;
    // Advance past the closer; the `tag.start < cursor` guard skips any tags the
    // block span already covered (handled by recursion into `inner`).
    i = closerIdx + 1;
  }
  out += input.slice(cursor);
  return out;
}

/**
 * Index in `tags` of the `{% end<name> %}` that closes the opener at `openIdx`,
 * balancing nested same-name openers, or -1 when there is none (a standalone
 * block).
 */
function findMatchingCloser(tags: Tag[], openIdx: number): number {
  const name = tags[openIdx].name;
  let depth = 0;
  for (let j = openIdx + 1; j < tags.length; j++) {
    const t = tags[j];
    if (t.name !== name) continue;
    if (t.closing) {
      if (depth === 0) return j;
      depth--;
    } else {
      depth++;
    }
  }
  return -1;
}

/** Transform (or degrade) a paired `{% name %}…{% endname %}` block. */
function renderPairedBlock(tag: Tag, inner: string, ctx: Ctx): string {
  const rendered = () => renderSegment(inner, ctx).trim();
  const attrs = parseAttrs(tag.attrs);

  switch (tag.name) {
    case "hint": {
      const label = HINT_LABEL[(attrs.style ?? "").toLowerCase()] ?? "Note";
      const body = rendered();
      return blockquote(body === "" ? `**${label}**` : `**${label}**\n\n${body}`);
    }
    case "code": {
      // Inner is already a fenced code block; keep it verbatim, prefix a title.
      const body = inner.trim();
      const title = attrs.title;
      return title ? `**${title}**\n\n${body}` : body;
    }
    case "tabs":
      return rendered();
    case "tab": {
      const title = attrs.title ?? "Tab";
      const body = rendered();
      return body === "" ? `**${title}**` : `**${title}**\n\n${body}`;
    }
    case "stepper":
      return rendered();
    case "step": {
      const title = attrs.title;
      const body = rendered();
      if (title) return body === "" ? `**${title}**` : `**${title}**\n\n${body}`;
      return body;
    }
    case "columns":
    case "column":
      // Layout-only wrappers — unwrap, keep the prose.
      return rendered();
    case "expand": {
      const title = attrs.title ?? "Details";
      const body = rendered();
      return body === "" ? `**${title}**` : `**${title}**\n\n${body}`;
    }
    case "content-ref": {
      const url = attrs.url ?? "";
      const label = rendered() || url;
      return url === "" ? label : `[${label}](${url})`;
    }
    default:
      // Not structurally convertible → counted, visible placeholder, prose kept.
      return degradePaired(tag.name, rendered(), ctx);
  }
}

/** Transform (or degrade) a standalone `{% name … %}` block (no closer). */
function renderStandalone(tag: Tag, ctx: Ctx): string {
  const attrs = parseAttrs(tag.attrs);
  switch (tag.name) {
    case "embed": {
      const url = attrs.url ?? "";
      return url === "" ? "" : `[${url}](${url})`;
    }
    case "content-ref": {
      // A `{% content-ref url="…" /%}` self-closing variant.
      const url = attrs.url ?? "";
      return url === "" ? "" : `[${url}](${url})`;
    }
    default:
      return degradeStandalone(tag.name, ctx);
  }
}

/** A paired unknown block: placeholder + the inner prose (never dropped). */
function degradePaired(name: string, inner: string, ctx: Ctx): string {
  ctx.degradations.bump(name);
  const placeholder = `> ⚠️ Unsupported GitBook block \`${name}\` — [view on the original page](${ctx.pageUrl})`;
  return inner === "" ? placeholder : `${placeholder}\n\n${inner}`;
}

/** A standalone unknown block: placeholder link alone. */
function degradeStandalone(name: string, ctx: Ctx): string {
  ctx.degradations.bump(name);
  return `> ⚠️ Unsupported GitBook block \`${name}\` — [view on the original page](${ctx.pageUrl})`;
}

function blockquote(content: string): string {
  return content
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** Collapse 3+ newlines to a paragraph break and trim edges. */
function normalizeBlankLines(markdown: string): string {
  return markdown.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
