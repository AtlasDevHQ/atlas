import { describe, expect, test } from "bun:test";

import {
  ArchivePathCollisionError,
  buildFumadocsOkfBundle,
  collectFumadocsPages,
  deriveArchivePath,
  IngestCapExceededError,
  InvalidPagePathError,
  isContentlessBody,
  mergeCollectResults,
  packOkfBundle,
  PageLoadError,
  ProcessedTextUnavailableError,
  splitUstarPath,
  type FumadocsOkfPage,
} from "../src/index";
import { acmeSource, page, sourceOf } from "./fixture";

describe("deriveArchivePath", () => {
  test("plain page maps 1:1 with .md extension", () => {
    expect(deriveArchivePath("guides/setup.mdx")).toEqual({
      path: "guides/setup.md",
      renamedFromReserved: false,
    });
  });

  test("section landing folds onto the section slug (reserved-basename trap)", () => {
    expect(deriveArchivePath("plugins/index.mdx").path).toBe("plugins.md");
    expect(deriveArchivePath("plugins/datasources/index.mdx").path).toBe(
      "plugins/datasources.md",
    );
  });

  test("root landing becomes overview.md", () => {
    expect(deriveArchivePath("index.mdx").path).toBe("overview.md");
    expect(deriveArchivePath("INDEX.mdx").path).toBe("overview.md");
  });

  test("a page literally named log gets -doc so ingest can never silently drop it", () => {
    const derived = deriveArchivePath("ops/log.mdx");
    expect(derived.path).toBe("ops/log-doc.md");
    expect(derived.renamedFromReserved).toBe(true);
  });

  test("an index that survives folding still moves off the reserved basename", () => {
    // `a/index/index.mdx` folds to `a/index.md` — reserved, so renamed.
    const derived = deriveArchivePath("a/index/index.mdx");
    expect(derived.path).toBe("a/index-doc.md");
    expect(derived.renamedFromReserved).toBe(true);
  });

  test("deterministic: same input, same output, no ordering dependence", () => {
    expect(deriveArchivePath("guides/setup.mdx")).toEqual(deriveArchivePath("guides/setup.mdx"));
  });

  test("rejects traversal, absolute, and non-page paths", () => {
    expect(() => deriveArchivePath("../escape.mdx")).toThrow(InvalidPagePathError);
    expect(() => deriveArchivePath("/abs/page.mdx")).toThrow(InvalidPagePathError);
    expect(() => deriveArchivePath("image.png")).toThrow(InvalidPagePathError);
    expect(() => deriveArchivePath("")).toThrow(InvalidPagePathError);
  });
});

describe("collectFumadocsPages", () => {
  test("collects the Acme fixture with built-in skips and reserved renames", async () => {
    const result = await collectFumadocsPages(acmeSource(), { prefix: "acme" });

    expect(result.docs.map((d) => d.path).toSorted()).toEqual([
      "acme/faq.md",
      "acme/guides.md", // guides/index.mdx folded
      "acme/guides/dashboards.md",
      "acme/ops/log-doc.md", // reserved basename renamed
      "acme/overview.md", // root index.mdx
      "acme/quickstart.md",
    ]);
    expect(result.skipped.apiReference).toBe(1);
    expect(result.skipped.contentless).toBe(1);
    expect(result.renamedReserved).toEqual([
      { from: "ops/log.mdx", to: "acme/ops/log-doc.md" },
    ]);
  });

  test("frontmatter carries title/description/tags; body is byte-faithful", async () => {
    const result = await collectFumadocsPages(acmeSource(), {
      prefix: "acme",
      tags: ["acme-docs"],
    });
    const quickstart = result.docs.find((d) => d.path === "acme/quickstart.md");
    expect(quickstart?.content).toBe(
      [
        "---",
        "type: Document",
        'title: "Quickstart"',
        'description: "Zero to first query"',
        'tags: ["acme-docs", "setup"]',
        "---",
        "",
        "## Install",
        "",
        "Run `acme init` and follow the prompts.",
        "",
      ].join("\n"),
    );
  });

  test("filter hook drops pages and is counted, not silent", async () => {
    const result = await collectFumadocsPages(acmeSource(), {
      prefix: "acme",
      filter: (p) => !p.path.startsWith("guides/"),
    });
    expect(result.docs.some((d) => d.path.startsWith("acme/guides"))).toBe(false);
    expect(result.skipped.filtered).toBe(2);
  });

  test("transform hook rewrites bodies; returning null skips fail-soft", async () => {
    const result = await collectFumadocsPages(acmeSource(), {
      prefix: "acme",
      transform: (body, p) =>
        p.path === "quickstart.mdx" ? null : body.replaceAll("Acme", "ACME"),
    });
    expect(result.docs.some((d) => d.path === "acme/quickstart.md")).toBe(false);
    expect(result.skipped.transformSkipped).toBe(1);
    expect(result.docs.find((d) => d.path === "acme/overview.md")?.content).toContain(
      "ACME turns your warehouse",
    );
  });

  test("missing processed text fails loud, naming the config — never raw-MDX fallback", async () => {
    const broken = sourceOf([
      page("no-postprocess.mdx", "body", { title: "X", missingProcessed: true }),
    ]);
    await expect(collectFumadocsPages(broken, { prefix: "acme" })).rejects.toThrow(
      /includeProcessedMarkdown/,
    );

    const noMethod = sourceOf([page("no-method.mdx", "body", { noGetText: true })]);
    await expect(collectFumadocsPages(noMethod, { prefix: "acme" })).rejects.toThrow(
      ProcessedTextUnavailableError,
    );
  });

  test("a non-config load failure is a PageLoadError — no misdirected config guidance", async () => {
    const flaky: FumadocsOkfPage = {
      path: "guides/net.mdx",
      data: {
        title: "Net",
        getText: async () => {
          throw new Error("Fetch https://docs.example.com/guides/net.mdx → 404 Not Found");
        },
      },
    };
    const promise = collectFumadocsPages(sourceOf([flaky]), { prefix: "acme" });
    await expect(promise).rejects.toThrow(PageLoadError);
    try {
      await collectFumadocsPages(sourceOf([flaky]), { prefix: "acme" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("404 Not Found");
      expect(message).not.toContain("includeProcessedMarkdown");
    }
  });

  test("filters run before body resolution — a skipped page never loads its body", async () => {
    let loads = 0;
    const counting = (path: string): FumadocsOkfPage => ({
      path,
      data: {
        title: path,
        getText: async () => {
          loads++;
          return "A real prose body that would count as content.";
        },
      },
    });
    const source = sourceOf([
      counting("api-reference/stub.mdx"), // built-in skip
      counting("internal/notes.mdx"), // caller filter skip
      counting("kept.mdx"),
    ]);
    const result = await collectFumadocsPages(source, {
      prefix: "acme",
      filter: (p) => !p.path.startsWith("internal/"),
    });
    expect(result.docs.map((d) => d.path)).toEqual(["acme/kept.md"]);
    expect(loads).toBe(1);
  });

  test("archive-path collision is a hard error naming both pages", async () => {
    const colliding = sourceOf([
      page("guide.mdx", "a standalone page with plenty of prose", { title: "A" }),
      page("guide/index.mdx", "a landing that folds onto guide.md", { title: "B" }),
    ]);
    await expect(collectFumadocsPages(colliding, { prefix: "acme" })).rejects.toThrow(
      ArchivePathCollisionError,
    );
  });

  test("cross-collect collisions are refused at pack — merge never last-write-wins", async () => {
    // Two collects with the SAME prefix producing the same archive path:
    // within-collect checks can't see this; packOkfBundle must.
    const a = await collectFumadocsPages(
      sourceOf([page("setup.mdx", "prose from the first section collect")]),
      { prefix: "kb" },
    );
    const b = await collectFumadocsPages(
      sourceOf([page("setup.mdx", "prose from the second section collect")]),
      { prefix: "kb" },
    );
    const merged = mergeCollectResults([a, b]);
    expect(() => packOkfBundle(merged.docs)).toThrow(ArchivePathCollisionError);
  });

  test("skipApiReference: false keeps the stubs (and contentless still applies)", async () => {
    const result = await collectFumadocsPages(acmeSource(), {
      prefix: "acme",
      skipApiReference: false,
      skipContentless: false,
    });
    expect(result.docs.some((d) => d.path === "acme/api-reference/create-widget.md")).toBe(true);
    expect(result.docs.some((d) => d.path === "acme/changelog.md")).toBe(true);
  });
});

describe("caps validation", () => {
  test("doc-count overflow reports the actual numbers and the settings knob", async () => {
    const many = sourceOf(
      Array.from({ length: 5 }, (_, i) => page(`p${i}.mdx`, `Body of page number ${i}.`)),
    );
    await expect(
      buildFumadocsOkfBundle(many, { prefix: "acme", caps: { maxDocs: 3 } }),
    ).rejects.toThrow(/maxDocs: 5 documents > 3 documents.*ATLAS_KNOWLEDGE_INGEST_MAX_DOCS/s);
  });

  test("per-doc byte overflow names the document", async () => {
    const big = sourceOf([page("big.mdx", "x".repeat(2000), { title: "Big" })]);
    await expect(
      buildFumadocsOkfBundle(big, { prefix: "acme", caps: { maxDocBytes: 100 } }),
    ).rejects.toThrow(IngestCapExceededError);
    await expect(
      buildFumadocsOkfBundle(big, { prefix: "acme", caps: { maxDocBytes: 100 } }),
    ).rejects.toThrow(/acme\/big\.md/);
  });

  test("decoded-total overflow trips maxBundleBytes", async () => {
    const docs = Array.from({ length: 4 }, (_, i) => ({
      path: `acme/p${i}.md`,
      content: "y".repeat(400),
      bytes: 400,
      sourcePath: `p${i}.mdx`,
    }));
    expect(() =>
      packOkfBundle(docs, { maxDocs: 100, maxDocBytes: 1000, maxBundleBytes: 1000 }),
    ).toThrow(/maxBundleBytes: 1600 bytes > 1000 bytes/);
  });
});

describe("deterministic packing", () => {
  test("same source builds byte-identical archives, regardless of page order", async () => {
    const pages = acmeSource().getPages();
    const a = await buildFumadocsOkfBundle(sourceOf(pages), { prefix: "acme" });
    const b = await buildFumadocsOkfBundle(sourceOf([...pages].reverse()), { prefix: "acme" });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  test("stats reconcile: documents == emitted docs, skips accounted", async () => {
    const result = await buildFumadocsOkfBundle(acmeSource(), { prefix: "acme" });
    expect(result.stats.documents).toBe(result.docs.length);
    expect(result.stats.documents).toBe(6);
    expect(result.stats.skipped.apiReference + result.stats.skipped.contentless).toBe(2);
    expect(result.stats.totalDocBytes).toBe(result.docs.reduce((n, d) => n + d.bytes, 0));
    expect(result.stats.archiveBytes).toBe(result.bytes.length);
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

describe("isContentlessBody", () => {
  test("component-only body is contentless; prose and code are content", () => {
    expect(isContentlessBody("<ChangelogTimeline />")).toBe(true);
    expect(isContentlessBody("Real prose that should be kept for the KB.")).toBe(false);
    expect(isContentlessBody("```sql\nSELECT 1;\n```")).toBe(false);
  });
});
