/**
 * Unit tests for lenient OKF ingest parsing (#4207).
 *
 * The headline behaviors: plain markdown ingests fine, missing `type`/`title`
 * are stamped, malformed frontmatter is rejected (not stamped over), reserved
 * basenames are skipped, and the intra-bundle link graph is extracted + resolved.
 */

import { describe, expect, it } from "bun:test";
import {
  parseLenientBundle,
  splitLenientFrontmatter,
  resolveLinkTarget,
  extractLinks,
  DEFAULT_OKF_TYPE,
} from "@atlas/api/lib/knowledge/parse-lenient";
import type { InteropFile } from "@atlas/api/lib/semantic/okf";

function doc(path: string, content: string): InteropFile {
  return { path, content };
}

describe("parseLenientBundle — leniency", () => {
  it("ingests a plain markdown file with no frontmatter, stamping type + title from heading", () => {
    const { docs, errors } = parseLenientBundle([doc("notes/policy.md", "# Refund policy\n\nText")]);
    expect(errors).toHaveLength(0);
    expect(docs).toHaveLength(1);
    expect(docs[0].type).toBe(DEFAULT_OKF_TYPE);
    expect(docs[0].title).toBe("Refund policy");
    expect(docs[0].body).toBe("# Refund policy\n\nText");
  });

  it("falls back to the filename stem for the title when there is no heading", () => {
    const { docs } = parseLenientBundle([doc("a/eu_replica.md", "just body, no heading")]);
    expect(docs[0].title).toBe("eu_replica");
  });

  it("stamps type but keeps a present title when frontmatter omits type", () => {
    const { docs } = parseLenientBundle([
      doc("x.md", "---\ntitle: Kept\ntags: [a, b]\n---\n# H\n"),
    ]);
    expect(docs[0].type).toBe(DEFAULT_OKF_TYPE);
    expect(docs[0].title).toBe("Kept");
    expect(docs[0].tags).toEqual(["a", "b"]);
  });

  it("mirrors OKF frontmatter fields verbatim, normalizing timestamp to ISO", () => {
    const { docs } = parseLenientBundle([
      doc(
        "d.md",
        "---\ntype: Runbook\ntitle: T\ndescription: D\nresource: https://x\ntimestamp: '2026-05-28T22:49:59+00:00'\n---\nbody",
      ),
    ]);
    expect(docs[0]).toMatchObject({
      type: "Runbook",
      title: "T",
      description: "D",
      resource: "https://x",
      timestamp: "2026-05-28T22:49:59.000Z",
    });
  });

  it("normalizes an unparseable timestamp to null rather than failing the doc", () => {
    const { docs, errors } = parseLenientBundle([
      doc("d.md", "---\ntype: X\ntimestamp: not-a-date\n---\nbody"),
    ]);
    expect(errors).toHaveLength(0);
    expect(docs[0].timestamp).toBeNull();
  });
});

describe("parseLenientBundle — rejection + skipping", () => {
  it("rejects malformed frontmatter with a per-file error, never stamped over", () => {
    const { docs, errors } = parseLenientBundle([
      doc("good.md", "# ok"),
      doc("bad.md", "---\ntype: [unclosed\n---\nbody"),
    ]);
    expect(docs.map((d) => d.path)).toEqual(["good.md"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("bad.md");
    expect(errors[0].reason).toContain("YAML parse error");
  });

  it("rejects an unterminated frontmatter block", () => {
    const { errors } = parseLenientBundle([doc("x.md", "---\ntype: X\nno close")]);
    expect(errors[0].reason).toContain("unterminated");
  });

  it("skips reserved basenames (index.md / log.md) and non-markdown files", () => {
    const { docs } = parseLenientBundle([
      doc("index.md", "# nav"),
      doc("sub/log.md", "# history"),
      doc("image.png", "binary"),
      doc("real.md", "# real"),
    ]);
    expect(docs.map((d) => d.path)).toEqual(["real.md"]);
  });

  it("treats an empty frontmatter block as no-fields (not malformed)", () => {
    const { docs, errors } = parseLenientBundle([doc("x.md", "---\n---\n# Body")]);
    expect(errors).toHaveLength(0);
    expect(docs[0].type).toBe(DEFAULT_OKF_TYPE);
    expect(docs[0].title).toBe("Body");
  });
});

describe("splitLenientFrontmatter", () => {
  it("treats a fileless-of-frontmatter doc as pure body", () => {
    const r = splitLenientFrontmatter("no frontmatter here");
    expect(r).toEqual({ ok: true, frontmatter: {}, body: "no frontmatter here" });
  });
  it("rejects a non-mapping frontmatter", () => {
    const r = splitLenientFrontmatter("---\n- just\n- a\n- list\n---\nbody");
    expect(r.ok).toBe(false);
  });
});

describe("resolveLinkTarget", () => {
  it("resolves a relative link against the source directory", () => {
    expect(resolveLinkTarget("runbooks/eu.md", "../glossary/term.md")).toBe("glossary/term.md");
    expect(resolveLinkTarget("runbooks/eu.md", "sibling.md")).toBe("runbooks/sibling.md");
  });
  it("strips fragments and queries", () => {
    expect(resolveLinkTarget("a/b.md", "c.md#section")).toBe("a/c.md");
  });
  it("returns null for external, anchor, and root-escaping links", () => {
    expect(resolveLinkTarget("a/b.md", "https://example.com")).toBeNull();
    expect(resolveLinkTarget("a/b.md", "mailto:x@y.z")).toBeNull();
    expect(resolveLinkTarget("a/b.md", "#local")).toBeNull();
    expect(resolveLinkTarget("a/b.md", "../../escape.md")).toBeNull();
  });
});

describe("extractLinks", () => {
  it("extracts intra-bundle links (dropping external), keeping distinct anchors as distinct edges", () => {
    const body =
      "See [EU replica](../runbooks/eu.md) and [the API](https://ext) and [again](../runbooks/eu.md).";
    const links = extractLinks("glossary/term.md", body);
    expect(links).toEqual([
      { targetPath: "runbooks/eu.md", anchorText: "EU replica" },
      { targetPath: "runbooks/eu.md", anchorText: "again" },
    ]);
  });

  it("de-duplicates identical links (same target AND anchor)", () => {
    const links = extractLinks("a.md", "[x](b.md) and again [x](b.md)");
    expect(links).toEqual([{ targetPath: "b.md", anchorText: "x" }]);
  });

  it("captures a null anchor for an empty link text", () => {
    const links = extractLinks("a.md", "[](b.md)");
    expect(links).toEqual([{ targetPath: "b.md", anchorText: null }]);
  });

  it("is wired through parseLenientBundle", () => {
    const { docs } = parseLenientBundle([
      doc("root.md", "# Root\n\n[child](sub/child.md)"),
    ]);
    expect(docs[0].links).toEqual([{ targetPath: "sub/child.md", anchorText: "child" }]);
  });
});
