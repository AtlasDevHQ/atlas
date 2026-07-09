/**
 * Golden tests for the shared support-center HTML → markdown converter
 * (#4396, PRD #4395). The corpus covers every AC-named shape — safe-tag
 * handling, tables/code/links, inline formatting, lists, definition lists —
 * and the degradation policy: images/media/embeds degrade to a VISIBLE
 * placeholder and a COUNTED bucket, and prose is never silently dropped.
 */

import { describe, expect, it } from "bun:test";
import { convertSupportHtmlToMarkdown } from "@atlas/api/lib/knowledge/support/html-to-markdown";

const PAGE_URL = "https://acme.zendesk.com/hc/en-us/articles/123-Getting-Started";

/** Convenience: convert with the shared page URL and return the markdown only. */
function md(html: string): string {
  return convertSupportHtmlToMarkdown(html, { pageUrl: PAGE_URL }).markdown;
}

describe("headings and inline formatting", () => {
  it("renders headings h1–h6", () => {
    expect(md("<h1>One</h1><h2>Two</h2><h3>Three</h3><h6>Six</h6>")).toBe(
      "# One\n\n## Two\n\n### Three\n\n###### Six",
    );
  });

  it("renders bold, italic, code, and strikethrough inline", () => {
    expect(
      md("<p>Hello <strong>world</strong> and <em>you</em> and <code>x=1</code> and <del>gone</del>.</p>"),
    ).toBe("Hello **world** and *you* and `x=1` and ~~gone~~.");
  });

  it("decodes HTML entities exactly once", () => {
    expect(md("<p>Fish &amp; chips &lt;here&gt; &mdash; also a literal &amp;nbsp;</p>")).toBe(
      "Fish & chips <here> — also a literal &nbsp;",
    );
  });

  it("collapses non-breaking spaces and whitespace runs", () => {
    expect(md("<p>a&nbsp;&nbsp;b\n   c</p>")).toBe("a b c");
  });

  it("turns <br> into a hard line break", () => {
    expect(md("<p>line one<br>line two</p>")).toBe("line one\nline two");
  });

  it("renders kbd/samp as inline code and unwraps span/u/sub/sup/mark", () => {
    expect(md("<p>Press <kbd>Ctrl</kbd> in <span>the</span> <u>editor</u><sub>1</sub></p>")).toBe(
      "Press `Ctrl` in the editor1",
    );
  });
});

describe("links", () => {
  it("renders an external anchor", () => {
    expect(md('<p>See <a href="https://example.com/docs">the docs</a>.</p>')).toBe(
      "See [the docs](https://example.com/docs).",
    );
  });

  it("uses the href as the label when the anchor has no text", () => {
    expect(md('<p><a href="https://example.com"></a></p>')).toBe(
      "[https://example.com](https://example.com)",
    );
  });

  it("drops javascript:/data:/vbscript: hrefs but keeps the anchor text", () => {
    expect(md('<p><a href="javascript:alert(1)">click me</a></p>')).toBe("click me");
    expect(md('<p><a href="data:text/html,<script>x()</script>">click me</a></p>')).toBe("click me");
    expect(md('<p><a href="vbscript:MsgBox(1)">click me</a></p>')).toBe("click me");
    // Control chars / whitespace inside the scheme must not defeat the check.
    expect(md('<p><a href="java\nscript:alert(1)">click me</a></p>')).toBe("click me");
    expect(md('<p><a href=" DATA:text/html,x">click me</a></p>')).toBe("click me");
  });

  it("passes every href through the cross-link rewriting hook", () => {
    const { markdown } = convertSupportHtmlToMarkdown(
      '<p><a href="/hc/en-us/articles/456">related</a></p>',
      {
        pageUrl: PAGE_URL,
        rewriteLink: (href) => new URL(href, "https://acme.zendesk.com").toString(),
      },
    );
    expect(markdown).toBe("[related](https://acme.zendesk.com/hc/en-us/articles/456)");
  });
});

describe("lists", () => {
  it("renders nested unordered lists with two-space indents", () => {
    expect(md("<ul><li>One<ul><li>Sub</li></ul></li><li>Two</li></ul>")).toBe(
      "- One\n  - Sub\n- Two",
    );
  });

  it("renders ordered lists", () => {
    expect(md("<ol><li>First</li><li>Second</li></ol>")).toBe("1. First\n2. Second");
  });

  it("renders a definition list with bold terms", () => {
    expect(md("<dl><dt>API key</dt><dd>Your secret token</dd></dl>")).toBe(
      "**API key**\n: Your secret token",
    );
  });
});

describe("tables", () => {
  it("renders a table with a header row", () => {
    expect(
      md(
        "<table><thead><tr><th>Name</th><th>Value</th></tr></thead>" +
          "<tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>",
      ),
    ).toBe("| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |");
  });

  it("emits an empty header for a headerless table and pads ragged rows", () => {
    expect(md("<table><tr><td>a</td><td>1</td></tr><tr><td>b</td></tr></table>")).toBe(
      "|  |  |\n| --- | --- |\n| a | 1 |\n| b |  |",
    );
  });

  it("escapes backslashes and pipes in cells so they cannot split columns", () => {
    expect(md("<table><tr><td>a\\|b</td></tr></table>")).toBe(
      "|  |\n| --- |\n| a\\\\\\|b |",
    );
  });
});

describe("code blocks", () => {
  it("renders <pre> as a fence", () => {
    expect(md("<pre>const x = 1;\nconst y = 2;</pre>")).toBe(
      "```\nconst x = 1;\nconst y = 2;\n```",
    );
  });

  it("sniffs the language from <pre><code class=\"language-…\">", () => {
    expect(md('<pre><code class="language-python">print("hi")</code></pre>')).toBe(
      '```python\nprint("hi")\n```',
    );
  });

  it("does not entity-mangle code content", () => {
    expect(md("<pre>if (a &lt; b &amp;&amp; c) {}</pre>")).toBe(
      "```\nif (a < b && c) {}\n```",
    );
  });
});

describe("blockquotes, rules, details", () => {
  it("renders a blockquote", () => {
    expect(md("<blockquote><p>Wise words</p></blockquote>")).toBe("> Wise words");
  });

  it("renders <hr> as a thematic break", () => {
    expect(md("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });

  it("renders details/summary as a bold label plus its body", () => {
    expect(md("<details><summary>More info</summary><p>Hidden text</p></details>")).toBe(
      "**More info**\n\nHidden text",
    );
  });
});

describe("degradation policy — counted placeholders, never silent drops", () => {
  it("degrades an image to a counted placeholder linking to the article", () => {
    const { markdown, degradations } = convertSupportHtmlToMarkdown(
      '<p>Step one:</p><img src="https://cdn.example.com/shots/step1.png" alt="Step one screenshot">',
      { pageUrl: PAGE_URL },
    );
    expect(markdown).toBe(
      `Step one:\n\n[Image: Step one screenshot — view on the original page](${PAGE_URL})`,
    );
    expect(degradations).toEqual([{ name: "#image", count: 1 }]);
  });

  it("labels an alt-less image by its src basename", () => {
    const { markdown } = convertSupportHtmlToMarkdown(
      '<img src="https://cdn.example.com/a/diagram.png?w=100">',
      { pageUrl: PAGE_URL },
    );
    expect(markdown).toBe(`[Image: diagram.png — view on the original page](${PAGE_URL})`);
  });

  it("counts each media kind under its own bucket", () => {
    const { degradations } = convertSupportHtmlToMarkdown(
      '<img src="a.png"><img src="b.png"><iframe src="https://youtube.com/embed/x"></iframe>' +
        "<video src='v.mp4'></video><svg><circle/></svg>",
      { pageUrl: PAGE_URL },
    );
    expect(degradations).toEqual([
      { name: "#iframe", count: 1 },
      { name: "#image", count: 2 },
      { name: "#svg", count: 1 },
      { name: "#video", count: 1 },
    ]);
  });

  it("degrades an inline image inside a paragraph without dropping the prose", () => {
    const { markdown, degradations } = convertSupportHtmlToMarkdown(
      '<p>Click <img src="icon.png" alt="the gear icon"> to open settings.</p>',
      { pageUrl: PAGE_URL },
    );
    expect(markdown).toBe(
      `Click [Image: the gear icon — view on the original page](${PAGE_URL}) to open settings.`,
    );
    expect(degradations).toEqual([{ name: "#image", count: 1 }]);
  });
});

describe("safe-tag handling", () => {
  it("removes script/style/noscript bodies entirely (not prose, not counted)", () => {
    const { markdown, degradations } = convertSupportHtmlToMarkdown(
      "<p>before</p><script>alert(1)</script><style>p{color:red}</style><noscript>enable js</noscript><p>after</p>",
      { pageUrl: PAGE_URL },
    );
    expect(markdown).toBe("before\n\nafter");
    expect(degradations).toEqual([]);
  });

  it("renders the children of unknown wrappers so prose is never dropped", () => {
    expect(md('<section><article><custom-widget><p>Real prose</p></custom-widget></article></section>')).toBe(
      "Real prose",
    );
  });

  it("survives malformed real-world HTML (unclosed tags)", () => {
    expect(md("<p>one<p>two<div>three")).toBe("one\n\ntwo\n\nthree");
  });
});

describe("whole-article golden fixture", () => {
  it("converts a representative help-center article", () => {
    const html = `
      <h1>Getting started</h1>
      <p>Welcome! This guide covers <strong>setup</strong> and <em>first steps</em>.</p>
      <h2>Install</h2>
      <ol><li>Download the CLI</li><li>Run <code>init</code></li></ol>
      <pre><code class="language-bash">atlas init --profile</code></pre>
      <table><thead><tr><th>Flag</th><th>Meaning</th></tr></thead>
        <tbody><tr><td><code>--profile</code></td><td>Profile the DB</td></tr></tbody></table>
      <img src="https://cdn.example.com/setup.png" alt="Setup wizard">
      <p>Questions? See <a href="/hc/en-us/articles/456">the FAQ</a>.</p>
    `;
    const { markdown, degradations } = convertSupportHtmlToMarkdown(html, {
      pageUrl: PAGE_URL,
      rewriteLink: (href) => new URL(href, "https://acme.zendesk.com").toString(),
    });
    expect(markdown).toBe(
      [
        "# Getting started",
        "",
        "Welcome! This guide covers **setup** and *first steps*.",
        "",
        "## Install",
        "",
        "1. Download the CLI",
        "2. Run `init`",
        "",
        "```bash",
        "atlas init --profile",
        "```",
        "",
        "| Flag | Meaning |",
        "| --- | --- |",
        "| `--profile` | Profile the DB |",
        "",
        `[Image: Setup wizard — view on the original page](${PAGE_URL})`,
        "",
        "Questions? See [the FAQ](https://acme.zendesk.com/hc/en-us/articles/456).",
      ].join("\n"),
    );
    expect(degradations).toEqual([{ name: "#image", count: 1 }]);
  });
});
