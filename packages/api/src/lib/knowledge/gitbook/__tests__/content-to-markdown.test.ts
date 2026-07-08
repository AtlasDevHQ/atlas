/**
 * Golden-fixture tests for the GitBook markdown converter (#4393). Pure — no
 * I/O. Covers the structural block conversions (hints, code-with-title, tabs,
 * stepper, content-ref, embed) and the honest-degradation policy (unknown
 * paired blocks keep their inner prose under a counted placeholder; unknown
 * standalone blocks degrade to the placeholder alone).
 */

import { describe, expect, it } from "bun:test";
import { convertGitbookMarkdown } from "@atlas/api/lib/knowledge/gitbook/content-to-markdown";

const PAGE_URL = "https://acme.gitbook.io/docs/guides/setup";

function convert(md: string) {
  return convertGitbookMarkdown(md, { pageUrl: PAGE_URL });
}

describe("convertGitbookMarkdown — passthrough", () => {
  it("leaves plain markdown untouched", () => {
    const { markdown, degradations } = convert("# Title\n\nSome **bold** prose.\n");
    expect(markdown).toBe("# Title\n\nSome **bold** prose.");
    expect(degradations).toEqual([]);
  });

  it("keeps a fenced code block verbatim", () => {
    const md = "```js\nconsole.log(1)\n```";
    expect(convert(md).markdown).toBe(md);
  });
});

describe("convertGitbookMarkdown — structural blocks", () => {
  it("converts a hint to a labelled blockquote", () => {
    const { markdown, degradations } = convert('{% hint style="warning" %}\nBe careful here.\n{% endhint %}');
    expect(markdown).toBe("> **Warning**\n>\n> Be careful here.");
    expect(degradations).toEqual([]);
  });

  it("defaults an unknown hint style to Note", () => {
    expect(convert('{% hint style="mystery" %}\ntext\n{% endhint %}').markdown).toBe("> **Note**\n>\n> text");
  });

  it("keeps a code block's fence and prefixes its title", () => {
    const md = '{% code title="example.js" %}\n```js\nconst x = 1;\n```\n{% endcode %}';
    const { markdown } = convert(md);
    expect(markdown).toBe("**example.js**\n\n```js\nconst x = 1;\n```");
  });

  it("renders tabs as labelled sections", () => {
    const md =
      '{% tabs %}\n{% tab title="npm" %}\nnpm install\n{% endtab %}\n{% tab title="bun" %}\nbun add\n{% endtab %}\n{% endtabs %}';
    const { markdown } = convert(md);
    expect(markdown).toContain("**npm**\n\nnpm install");
    expect(markdown).toContain("**bun**\n\nbun add");
  });

  it("unwraps a stepper and labels its steps", () => {
    const md =
      '{% stepper %}\n{% step %}\n### First\ndo a thing\n{% endstep %}\n{% endstepper %}';
    const { markdown } = convert(md);
    expect(markdown).toContain("### First");
    expect(markdown).toContain("do a thing");
  });

  it("converts a content-ref to a link", () => {
    const md = '{% content-ref url="https://acme.gitbook.io/docs/other" %}\nSee this\n{% endcontent-ref %}';
    expect(convert(md).markdown).toBe("[See this](https://acme.gitbook.io/docs/other)");
  });

  it("converts a standalone embed to a link", () => {
    const md = '{% embed url="https://youtu.be/abc" %}';
    expect(convert(md).markdown).toBe("[https://youtu.be/abc](https://youtu.be/abc)");
  });
});

describe("convertGitbookMarkdown — degradation policy", () => {
  it("degrades an unknown paired block to a counted placeholder, keeping inner prose", () => {
    const md = '{% openapi src="./spec.yaml" %}\nGET /users\n{% endopenapi %}';
    const { markdown, degradations } = convert(md);
    expect(markdown).toContain("⚠️ Unsupported GitBook block `openapi`");
    expect(markdown).toContain(PAGE_URL);
    expect(markdown).toContain("GET /users"); // inner prose never dropped
    expect(degradations).toEqual([{ name: "openapi", count: 1 }]);
  });

  it("degrades an unknown standalone block to the placeholder alone and counts it", () => {
    const md = '{% file src="./report.pdf" %}';
    const { markdown, degradations } = convert(md);
    expect(markdown).toContain("⚠️ Unsupported GitBook block `file`");
    expect(degradations).toEqual([{ name: "file", count: 1 }]);
  });

  it("counts repeated degradations of the same block", () => {
    const md = '{% file src="a" %}\n\n{% file src="b" %}';
    expect(convert(md).degradations).toEqual([{ name: "file", count: 2 }]);
  });

  it("handles a known block nested inside another without degrading either", () => {
    const md =
      '{% tabs %}\n{% tab title="Note" %}\n{% hint style="info" %}\nnested hint\n{% endhint %}\n{% endtab %}\n{% endtabs %}';
    const { markdown, degradations } = convert(md);
    expect(markdown).toContain("**Note**");
    expect(markdown).toContain("> **Info**");
    expect(markdown).toContain("nested hint");
    expect(degradations).toEqual([]);
  });

  it("degrades an unknown block nested in a known block, keeping the surrounding structure", () => {
    const md = '{% tabs %}\n{% tab title="API" %}\n{% swagger %}\nspec\n{% endswagger %}\n{% endtab %}\n{% endtabs %}';
    const { markdown, degradations } = convert(md);
    expect(markdown).toContain("**API**");
    expect(markdown).toContain("⚠️ Unsupported GitBook block `swagger`");
    expect(degradations).toEqual([{ name: "swagger", count: 1 }]);
  });
});
