/**
 * Fumadocs-SPECIFIC adapter behavior: the loader mapping, the
 * `getText("processed")` prescription vs. generic load errors, and the
 * default `api-reference/` stub skip. The source-neutral core surface
 * (path derivation, caps, collisions, deterministic packing, contentless
 * heuristic) is covered in `@atlas/okf-bundle`'s own tests through the
 * doc-source seam.
 */

import { describe, expect, test } from "bun:test";

import {
  buildFumadocsOkfBundle,
  collectFumadocsPages,
  PageLoadError,
  ProcessedTextUnavailableError,
  type FumadocsOkfPage,
} from "../src/index";
import { acmeSource, page, sourceOf } from "./fixture";

describe("collectFumadocsPages (loader mapping)", () => {
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

  test("page.data frontmatter carries through: title/description/tags; body is byte-faithful", async () => {
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

  test("hooks receive the ORIGINAL Fumadocs page (not the internal doc-source wrapper)", async () => {
    const seen: string[] = [];
    const result = await collectFumadocsPages(acmeSource(), {
      prefix: "acme",
      filter: (p) => {
        // `data` only exists on the Fumadocs page shape.
        expect(typeof p.data).toBe("object");
        return true;
      },
      transform: (body, p) => {
        // The wrapper has no `data` — a regression that passes it through
        // would break every transform that reads page frontmatter.
        expect(typeof p.data).toBe("object");
        seen.push(p.path);
        return p.data.title === "Quickstart" ? `${body}\n\ntransform saw the real page` : body;
      },
      tags: (p) => (p.data.title ? [p.data.title.toLowerCase()] : []),
    });
    expect(seen.length).toBeGreaterThan(0);
    const quickstart = result.docs.find((d) => d.path === "acme/quickstart.md");
    expect(quickstart?.content).toContain('"quickstart"');
    expect(quickstart?.content).toContain("transform saw the real page");
  });

  test('a non-string getText("processed") result is a PageLoadError naming the page', async () => {
    const odd: FumadocsOkfPage = {
      path: "guides/odd.mdx",
      data: {
        title: "Odd",
        getText: async () => undefined as unknown as string,
      },
    };
    await expect(collectFumadocsPages(sourceOf([odd]), { prefix: "acme" })).rejects.toThrow(
      PageLoadError,
    );
    await expect(collectFumadocsPages(sourceOf([odd]), { prefix: "acme" })).rejects.toThrow(
      /guides\/odd\.mdx.*non-string/,
    );
  });

  test("page metadata resolves lazily — a skipped page never reads data.title/description/tags", async () => {
    // Structural shims may back the data fields with getters that read and
    // parse the file (the docs portal does); the 473 filtered api-reference
    // stubs must cost a directory entry, not a read each.
    let metadataReads = 0;
    const lazy = (path: string): FumadocsOkfPage => ({
      path,
      data: {
        get title(): string {
          metadataReads++;
          return path;
        },
        getText: async () => "A real prose body that would count as content.",
      },
    });
    await collectFumadocsPages(sourceOf([lazy("api-reference/stub.mdx"), lazy("kept.mdx")]), {
      prefix: "acme",
    });
    expect(metadataReads).toBe(1); // only the kept page's title was rendered
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

  test("filters run before body resolution — a skipped page never calls getText", async () => {
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

describe("buildFumadocsOkfBundle", () => {
  test("stats reconcile and packing stays deterministic through the adapter entry", async () => {
    const pages = acmeSource().getPages();
    const a = await buildFumadocsOkfBundle(sourceOf(pages), { prefix: "acme" });
    const b = await buildFumadocsOkfBundle(sourceOf([...pages].reverse()), { prefix: "acme" });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.stats.documents).toBe(a.docs.length);
    expect(a.stats.documents).toBe(6);
    expect(a.stats.archiveBytes).toBe(a.bytes.length);
    expect(a.stats.totalDocBytes).toBe(a.docs.reduce((n, d) => n + d.bytes, 0));
    expect(a.stats.skipped.apiReference).toBe(1);
    expect(a.stats.skipped.contentless).toBe(1);
    expect(a.stats.renamedReserved).toEqual([{ from: "ops/log.mdx", to: "acme/ops/log-doc.md" }]);
  });

  test("caps overrides flow through to the core validation", async () => {
    const many = sourceOf(
      Array.from({ length: 5 }, (_, i) => page(`p${i}.mdx`, `Body of page number ${i}.`)),
    );
    await expect(
      buildFumadocsOkfBundle(many, { prefix: "acme", caps: { maxDocs: 3 } }),
    ).rejects.toThrow(/maxDocs: 5 documents > 3 documents/);
  });
});
