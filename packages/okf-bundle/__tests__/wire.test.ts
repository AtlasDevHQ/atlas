import { describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";

import {
  InvalidPagePathError,
  mdBasename,
  normalizeFrontmatterTags,
  OKF_FRONTMATTER_FIELDS,
  renderOkfDocument,
  RESERVED_BASENAMES,
  splitFrontmatterBlock,
  splitUstarPath,
  topLevelHeading,
} from "../src/index";

/** The api's binding shape (`semantic/okf/md-utils.ts`) — js-yaml injected. */
const split = (content: string) => splitFrontmatterBlock(content, (raw) => yaml.load(raw));

describe("wire: splitFrontmatterBlock (mechanics only — policy stays in each parser)", () => {
  test("no opener → none (the lenient parser's pure-markdown case)", () => {
    expect(split("# Just markdown\n\nprose")).toEqual({ kind: "none" });
  });

  test("a parsed mapping comes back with the body, opener stripped", () => {
    const result = split('---\ntitle: "Hi"\ntype: Document\n---\n\nBody here.\n');
    expect(result).toEqual({
      kind: "ok",
      data: { title: "Hi", type: "Document" },
      // One newline after the close is the block's own; the body keeps the rest.
      body: "Body here.\n",
    });
  });

  test("an empty block is ok with data null, not malformed", () => {
    expect(split("---\n---\nBody")).toEqual({ kind: "ok", data: null, body: "Body" });
  });

  test("unterminated / unparseable / non-mapping blocks are errors, never silent", () => {
    expect(split("---\ntitle: x\n")).toEqual({
      kind: "error",
      reason: "unterminated frontmatter block",
    });
    expect(split("---\n[a, b\n---\nBody").kind).toBe("error");
    expect(split("---\n- just\n- a list\n---\nBody")).toEqual({
      kind: "error",
      reason: "frontmatter is not a YAML mapping",
    });
  });

  test("CRLF line endings split identically to LF", () => {
    expect(split("---\r\ntitle: x\r\n---\r\nBody")).toEqual({
      kind: "ok",
      data: { title: "x" },
      body: "Body",
    });
  });

  test("a non-plain-object parse result (Date, Map) is an error, never a lying ok", () => {
    // js-yaml parses a lone scalar timestamp into a Date — `typeof "object"`,
    // but not the mapping the ok variant's Record type promises.
    expect(split("---\n2020-01-01\n---\nBody")).toEqual({
      kind: "error",
      reason: "frontmatter is not a YAML mapping",
    });
    // An injected non-js-yaml parser returning a Map must be refused too.
    const viaMap = splitFrontmatterBlock("---\nx: y\n---\nBody", () => new Map([["x", "y"]]));
    expect(viaMap).toEqual({ kind: "error", reason: "frontmatter is not a YAML mapping" });
  });

  test("the injected parser's throw is converted, not propagated", () => {
    const result = splitFrontmatterBlock("---\nx: y\n---\nBody", () => {
      throw new Error("boom");
    });
    expect(result).toEqual({ kind: "error", reason: "frontmatter YAML parse error: boom" });
  });
});

describe("wire: constants and leaf helpers", () => {
  test("reserved basenames are the two the ingest parsers silently skip", () => {
    expect([...RESERVED_BASENAMES].toSorted()).toEqual(["index.md", "log.md"]);
  });

  test("mdBasename handles nested and bare paths", () => {
    expect(mdBasename("a/b/c.md")).toBe("c.md");
    expect(mdBasename("c.md")).toBe("c.md");
  });

  test("topLevelHeading extracts only real `# ` headings", () => {
    expect(topLevelHeading("# Title")).toBe("Title");
    expect(topLevelHeading("#\tTabbed")).toBe("Tabbed");
    expect(topLevelHeading("## Sub")).toBeNull();
    expect(topLevelHeading("#NoSpace")).toBeNull();
    expect(topLevelHeading("# ")).toBeNull();
  });

  test("OKF_FRONTMATTER_FIELDS enumerates the whole wire field set", () => {
    expect([...OKF_FRONTMATTER_FIELDS].toSorted()).toEqual(
      ["description", "resource", "tags", "timestamp", "title", "type"],
    );
  });

  test("normalizeFrontmatterTags drops non-strings, trims, drops empties, keeps order", () => {
    // The shared generate↔ingest narrower (pageTags on the build side,
    // tagsField on the ingest side both delegate here).
    expect(normalizeFrontmatterTags([1, "ok", null, "  x  ", "", true, "y"])).toEqual([
      "ok",
      "x",
      "y",
    ]);
    expect(normalizeFrontmatterTags("not-an-array")).toEqual([]);
    expect(normalizeFrontmatterTags(undefined)).toEqual([]);
  });

  test("rendered documents stay inside the wire frontmatter field set", () => {
    const doc = renderOkfDocument(
      { title: "T", description: "D" },
      ["one"],
      "Body prose.",
    );
    const result = split(doc);
    if (result.kind !== "ok" || result.data === null) {
      throw new Error(`expected an ok mapping split, got ${result.kind}`);
    }
    const fieldSet: readonly string[] = OKF_FRONTMATTER_FIELDS;
    for (const key of Object.keys(result.data)) {
      expect(fieldSet).toContain(key);
    }
    expect(result.data.type).toBe("Document");
  });

  test("renders optional resource + timestamp in wire field order", () => {
    const doc = renderOkfDocument(
      {
        title: "Runbook",
        resource: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
        timestamp: "2026-07-01T00:00:00.000Z",
      },
      ["confluence"],
      "Body prose.",
    );
    const result = split(doc);
    if (result.kind !== "ok" || result.data === null) {
      throw new Error(`expected an ok mapping split, got ${result.kind}`);
    }
    expect(result.data.resource).toBe("https://acme.atlassian.net/wiki/spaces/ENG/pages/123");
    expect(result.data.timestamp).toBe("2026-07-01T00:00:00.000Z");
    // resource precedes tags; timestamp follows them — the wire field order.
    expect(doc.indexOf("resource:")).toBeLessThan(doc.indexOf("tags:"));
    expect(doc.indexOf("tags:")).toBeLessThan(doc.indexOf("timestamp:"));
    const fieldSet: readonly string[] = OKF_FRONTMATTER_FIELDS;
    for (const key of Object.keys(result.data)) expect(fieldSet).toContain(key);
  });

  test("renders an extension block after the wire fields as a nested string mapping", () => {
    // The connector provenance path (`atlas:` blocks) — extension keys are
    // spec-legal unknown frontmatter, outside the wire field set.
    const doc = renderOkfDocument(
      { title: "T", timestamp: "2026-07-01T00:00:00.000Z" },
      [],
      "Body prose.",
      {
        key: "atlas",
        fields: { connector: "notion", page_id: "11111111-2222-3333-4444-555555555555" },
      },
    );
    const result = split(doc);
    if (result.kind !== "ok" || result.data === null) {
      throw new Error(`expected an ok mapping split, got ${result.kind}`);
    }
    expect(result.data.atlas).toEqual({
      connector: "notion",
      page_id: "11111111-2222-3333-4444-555555555555",
    });
    // Extension follows every wire field; values are JSON-encoded scalars, so
    // a colon/quote in a field value can't break the YAML.
    expect(doc.indexOf("timestamp:")).toBeLessThan(doc.indexOf("atlas:"));
    expect(doc).toContain('connector: "notion"');
    // No extension / empty fields render nothing extra.
    expect(renderOkfDocument({ title: "T" }, [], "b")).not.toContain("atlas:");
    expect(renderOkfDocument({ title: "T" }, [], "b", { key: "atlas", fields: {} })).not.toContain(
      "atlas:",
    );
  });
});

describe("splitUstarPath", () => {
  test("short paths stay in name", () => {
    expect(splitUstarPath("docs/a.md")).toEqual({ name: "docs/a.md", prefix: "" });
  });

  test("long paths split at a slash boundary", () => {
    const dir = "d".repeat(90);
    const split = splitUstarPath(`${dir}/${"f".repeat(60)}.md`);
    expect(split.prefix).toBe(dir);
    expect(split.name).toBe(`${"f".repeat(60)}.md`);
  });

  test("an unsplittable path throws typed instead of truncating", () => {
    expect(() => splitUstarPath("x".repeat(160))).toThrow(InvalidPagePathError);
    expect(() => splitUstarPath("x".repeat(160))).toThrow(/ustar/);
  });
});
