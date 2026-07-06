/**
 * Golden tests for the Confluence storage-XHTML → markdown converter (#4377).
 * The corpus covers every AC-named shape — headings, formatting, lists, tables,
 * code, admonition macros, links, media, task lists — and the macro policy:
 * unconvertible macros degrade to a VISIBLE placeholder and a COUNTED
 * degradation, and never silently drop prose.
 */

import { describe, expect, it } from "bun:test";
import { convertStorageToMarkdown } from "@atlas/api/lib/knowledge/confluence/storage-to-markdown";

const PAGE_URL = "https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Runbook";

/** Convenience: convert with the shared page URL and return the markdown only. */
function md(storage: string): string {
  return convertStorageToMarkdown(storage, { pageUrl: PAGE_URL }).markdown;
}

describe("headings and inline formatting", () => {
  it("renders headings h1–h6", () => {
    expect(md("<h1>One</h1><h2>Two</h2><h3>Three</h3>")).toBe("# One\n\n## Two\n\n### Three");
  });

  it("renders bold, italic, code, and strikethrough inline", () => {
    expect(md("<p>Hello <strong>world</strong> and <em>you</em> and <code>x=1</code> and <del>gone</del>.</p>")).toBe(
      "Hello **world** and *you* and `x=1` and ~~gone~~.",
    );
  });

  it("decodes HTML entities in prose", () => {
    expect(md("<p>Fish &amp; chips &lt;here&gt;</p>")).toBe("Fish & chips <here>");
  });

  it("collapses non-breaking spaces to normal spaces", () => {
    expect(md("<p>a&nbsp;&nbsp;b</p>")).toBe("a b");
  });

  it("turns <br/> into a hard line break", () => {
    expect(md("<p>line one<br/>line two</p>")).toBe("line one\nline two");
  });
});

describe("links", () => {
  it("renders an external anchor", () => {
    expect(md('<p>See <a href="https://example.com/docs">the docs</a>.</p>')).toBe(
      "See [the docs](https://example.com/docs).",
    );
  });

  it("renders a cross-page ac:link pointing at the vendor page (URL unresolvable)", () => {
    expect(
      md('<p><ac:link><ri:page ri:content-title="Other Page"/><ac:link-body>see this</ac:link-body></ac:link></p>'),
    ).toBe(`[see this](${PAGE_URL})`);
  });

  it("uses the page title when a cross-page link has no body", () => {
    expect(md('<p><ac:link><ri:page ri:content-title="Deploy Guide"/></ac:link></p>')).toBe(
      `[Deploy Guide](${PAGE_URL})`,
    );
  });
});

describe("lists", () => {
  it("renders nested unordered lists with two-space indents", () => {
    expect(md("<ul><li>One<ul><li>Sub</li></ul></li><li>Two</li></ul>")).toBe("- One\n  - Sub\n- Two");
  });

  it("renders ordered lists", () => {
    expect(md("<ol><li>First</li><li>Second</li></ol>")).toBe("1. First\n2. Second");
  });

  it("renders a Confluence task list as a markdown checklist", () => {
    expect(
      md(
        "<ac:task-list>" +
          "<ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Done thing</ac:task-body></ac:task>" +
          "<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>Todo thing</ac:task-body></ac:task>" +
          "</ac:task-list>",
      ),
    ).toBe("- [x] Done thing\n- [ ] Todo thing");
  });
});

describe("tables", () => {
  it("renders a header + body table", () => {
    expect(
      md("<table><tbody><tr><th>Name</th><th>Role</th></tr><tr><td>Ada</td><td>Eng</td></tr></tbody></table>"),
    ).toBe("| Name | Role |\n| --- | --- |\n| Ada | Eng |");
  });

  it("synthesizes an empty header when the first row has no <th>", () => {
    expect(md("<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>")).toBe(
      "|  |  |\n| --- | --- |\n| a | b |",
    );
  });

  it("escapes pipes and flattens newlines inside a cell", () => {
    expect(md("<table><tbody><tr><th>H</th></tr><tr><td>a|b<br/>c</td></tr></tbody></table>")).toBe(
      "| H |\n| --- |\n| a\\|b<br>c |",
    );
  });

  it("escapes a backslash before the pipe so source text can't inject a column", () => {
    // Source cell text is `a\|b` (backslash then pipe). Escaping only the pipe
    // yields `a\\|b` — an escaped backslash + a LIVE pipe that GFM reads as a
    // column separator (js/incomplete-sanitization). Escaping the backslash
    // first makes both inert: `a\\\|b`.
    expect(md("<table><tbody><tr><th>H</th></tr><tr><td>a\\|b</td></tr></tbody></table>")).toBe(
      "| H |\n| --- |\n| a\\\\\\|b |",
    );
  });
});

describe("code macros", () => {
  it("renders a code macro with its language, verbatim (CDATA preserved)", () => {
    expect(
      md(
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter>' +
          "<ac:plain-text-body><![CDATA[const x = a < b && c > d;]]></ac:plain-text-body></ac:structured-macro>",
      ),
    ).toBe("```typescript\nconst x = a < b && c > d;\n```");
  });

  it("renders a noformat macro as a plain fence", () => {
    expect(
      md('<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[raw text]]></ac:plain-text-body></ac:structured-macro>'),
    ).toBe("```\nraw text\n```");
  });
});

describe("admonition macros", () => {
  it("renders info/note/warning/tip as labelled blockquotes", () => {
    expect(
      md('<ac:structured-macro ac:name="note"><ac:rich-text-body><p>Heads up.</p></ac:rich-text-body></ac:structured-macro>'),
    ).toBe("> **Note**\n>\n> Heads up.");
    expect(
      md('<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Careful.</p></ac:rich-text-body></ac:structured-macro>'),
    ).toBe("> **Warning**\n>\n> Careful.");
  });

  it("includes the panel/admonition title when present", () => {
    expect(
      md(
        '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Before you start</ac:parameter>' +
          "<ac:rich-text-body><p>Read this.</p></ac:rich-text-body></ac:structured-macro>",
      ),
    ).toBe("> **Info: Before you start**\n>\n> Read this.");
  });

  it("renders an expand macro as a titled section", () => {
    expect(
      md(
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More detail</ac:parameter>' +
          "<ac:rich-text-body><p>The details.</p></ac:rich-text-body></ac:structured-macro>",
      ),
    ).toBe("**More detail**\n\nThe details.");
  });
});

describe("macro policy — counted degradations, never silent drops", () => {
  it("degrades an unknown macro to a visible placeholder and counts it", () => {
    const result = convertStorageToMarkdown(
      '<p>Intro.</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro>',
      { pageUrl: PAGE_URL },
    );
    expect(result.markdown).toBe(
      `Intro.\n\n> ⚠️ Unsupported Confluence macro \`jira\` — [view on the original page](${PAGE_URL})`,
    );
    expect(result.degradations).toEqual([{ name: "jira", count: 1 }]);
  });

  it("keeps the inner prose of an unknown macro while flagging it", () => {
    const result = convertStorageToMarkdown(
      '<ac:structured-macro ac:name="mystery"><ac:rich-text-body><p>Real content.</p></ac:rich-text-body></ac:structured-macro>',
      { pageUrl: PAGE_URL },
    );
    expect(result.markdown).toContain("Real content.");
    expect(result.markdown).toContain("Unsupported Confluence macro `mystery`");
    expect(result.degradations).toEqual([{ name: "mystery", count: 1 }]);
  });

  it("counts repeated degradations and images/attachments in dedicated buckets", () => {
    const result = convertStorageToMarkdown(
      '<p><ac:image><ri:attachment ri:filename="a.png"/></ac:image></p>' +
        '<p><ac:image><ri:attachment ri:filename="b.png"/></ac:image></p>' +
        '<ac:structured-macro ac:name="jira"/><ac:structured-macro ac:name="jira"/>',
      { pageUrl: PAGE_URL },
    );
    expect(result.degradations).toEqual([
      { name: "#image", count: 2 },
      { name: "jira", count: 2 },
    ]);
  });

  it("replaces an image with a link back to the vendor page (text-first v1)", () => {
    expect(md('<p>Diagram: <ac:image><ri:attachment ri:filename="diagram.png"/></ac:image></p>')).toBe(
      `Diagram: [Image: diagram.png — view on the original page](${PAGE_URL})`,
    );
  });

  it("links an attachment ac:link back to the vendor page and counts it under #attachment", () => {
    const result = convertStorageToMarkdown(
      '<p>See <ac:link><ri:attachment ri:filename="spec.pdf"/><ac:link-body>the spec</ac:link-body></ac:link></p>',
      { pageUrl: PAGE_URL },
    );
    expect(result.markdown).toBe(`See [the spec (attachment — view on the original page)](${PAGE_URL})`);
    expect(result.degradations).toEqual([{ name: "#attachment", count: 1 }]);
  });

  it("renders a status macro inline as code", () => {
    expect(md('<p>State: <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro></p>')).toBe(
      "State: `DONE`",
    );
  });

  it("converts a clean page with zero degradations", () => {
    const result = convertStorageToMarkdown("<h1>Clean</h1><p>Nothing weird here.</p>", { pageUrl: PAGE_URL });
    expect(result.markdown).toBe("# Clean\n\nNothing weird here.");
    expect(result.degradations).toEqual([]);
  });
});

describe("whitespace and structure", () => {
  it("drops inter-element whitespace and normalizes blank lines", () => {
    expect(md("<h1>Title</h1>\n\n\n<p>Body.</p>")).toBe("# Title\n\nBody.");
  });

  it("recurses through Confluence layout wrappers", () => {
    expect(
      md(
        "<ac:layout><ac:layout-section><ac:layout-cell><p>In a column.</p></ac:layout-cell></ac:layout-section></ac:layout>",
      ),
    ).toBe("In a column.");
  });
});
