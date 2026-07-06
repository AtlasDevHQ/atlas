import { describe, expect, test } from "bun:test";

import {
  ArchivePathCollisionError,
  buildOkfBundle,
  collectPages,
  deriveArchivePath,
  EmptyBundleError,
  IngestCapExceededError,
  InvalidPagePathError,
  isContentlessBody,
  mergeCollectResults,
  normalizePrefix,
  packOkfBundle,
  pageTags,
  PageLoadError,
  type DocSourcePage,
} from "../src/index";
import { acmeSource, isAcmeApiReferenceStub, page, sourceOf } from "./fixture";

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

describe("collectPages (through the doc-source seam only)", () => {
  test("collects the Acme fixture with counted skips and reserved renames", async () => {
    const result = await collectPages(acmeSource(), {
      prefix: "acme",
      isApiReferenceStub: isAcmeApiReferenceStub,
    });

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
    const result = await collectPages(acmeSource(), {
      prefix: "acme",
      tags: ["acme-docs"],
      isApiReferenceStub: isAcmeApiReferenceStub,
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
    const result = await collectPages(acmeSource(), {
      prefix: "acme",
      isApiReferenceStub: isAcmeApiReferenceStub,
      filter: (p) => !p.path.startsWith("guides/"),
    });
    expect(result.docs.some((d) => d.path.startsWith("acme/guides"))).toBe(false);
    expect(result.skipped.filtered).toBe(2);
  });

  test("transform hook rewrites bodies; returning null skips fail-soft", async () => {
    const result = await collectPages(acmeSource(), {
      prefix: "acme",
      isApiReferenceStub: isAcmeApiReferenceStub,
      transform: (body, p) =>
        p.path === "quickstart.mdx" ? null : body.replaceAll("Acme", "ACME"),
    });
    expect(result.docs.some((d) => d.path === "acme/quickstart.md")).toBe(false);
    expect(result.skipped.transformSkipped).toBe(1);
    expect(result.docs.find((d) => d.path === "acme/overview.md")?.content).toContain(
      "ACME turns your warehouse",
    );
  });

  test("a loadBody failure propagates fail-loud — never a silently partial bundle", async () => {
    const flaky = sourceOf([
      page("guides/net.mdx", "", {
        title: "Net",
        loadError: "Fetch https://docs.example.com/guides/net.mdx → 404 Not Found",
      }),
    ]);
    await expect(collectPages(flaky, { prefix: "acme" })).rejects.toThrow("404 Not Found");
  });

  test("a non-string loadBody result is a PageLoadError naming the page", async () => {
    const broken: DocSourcePage = {
      path: "guides/odd.mdx",
      title: "Odd",
      loadBody: async () => undefined as unknown as string,
    };
    const promise = collectPages(sourceOf([broken]), { prefix: "acme" });
    await expect(promise).rejects.toThrow(PageLoadError);
    await expect(
      collectPages(sourceOf([broken]), { prefix: "acme" }),
    ).rejects.toThrow(/guides\/odd\.mdx/);
  });

  test("skips run before body resolution — a skipped page never loads its body", async () => {
    let loads = 0;
    const counting = (path: string): DocSourcePage => ({
      path,
      title: path,
      loadBody: async () => {
        loads++;
        return "A real prose body that would count as content.";
      },
    });
    const source = sourceOf([
      counting("api-reference/stub.mdx"), // adapter stub predicate skip
      counting("internal/notes.mdx"), // caller filter skip
      counting("kept.mdx"),
    ]);
    const result = await collectPages(source, {
      prefix: "acme",
      isApiReferenceStub: isAcmeApiReferenceStub,
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
    await expect(collectPages(colliding, { prefix: "acme" })).rejects.toThrow(
      ArchivePathCollisionError,
    );
  });

  test("mergeCollectResults sums every skip bucket and concatenates renames", async () => {
    const a = await collectPages(
      sourceOf([
        page("api-reference/stub.mdx", "<APIPage />"),
        page("kept.mdx", "Prose that stays in the bundle."),
        page("dropped.mdx", "Prose the filter declines."),
      ]),
      {
        prefix: "one",
        isApiReferenceStub: isAcmeApiReferenceStub,
        filter: (p) => p.path !== "dropped.mdx",
      },
    );
    const b = await collectPages(
      sourceOf([
        page("ops/log.mdx", "A reserved-basename page that gets renamed."),
        page("empty.mdx", "<OnlyAComponent />"),
        page("skipped.mdx", "Transform sends this one away."),
      ]),
      {
        prefix: "two",
        transform: (body, p) => (p.path === "skipped.mdx" ? null : body),
      },
    );
    const merged = mergeCollectResults([a, b]);
    expect(merged.skipped).toEqual({
      filtered: 1,
      apiReference: 1,
      contentless: 1,
      transformSkipped: 1,
    });
    expect(merged.renamedReserved).toEqual([{ from: "ops/log.mdx", to: "two/ops/log-doc.md" }]);
    expect(merged.docs.map((d) => d.path)).toEqual(["one/kept.md", "two/ops/log-doc.md"]);
  });

  test("cross-collect collisions are refused at pack — merge never last-write-wins", async () => {
    // Two collects with the SAME prefix producing the same archive path:
    // within-collect checks can't see this; packOkfBundle must.
    const a = await collectPages(
      sourceOf([page("setup.mdx", "prose from the first section collect")]),
      { prefix: "kb" },
    );
    const b = await collectPages(
      sourceOf([page("setup.mdx", "prose from the second section collect")]),
      { prefix: "kb" },
    );
    const merged = mergeCollectResults([a, b]);
    expect(() => packOkfBundle(merged.docs)).toThrow(ArchivePathCollisionError);
  });

  test("without a stub predicate nothing lands in the apiReference bucket", async () => {
    const result = await collectPages(acmeSource(), {
      prefix: "acme",
      skipContentless: false,
    });
    expect(result.skipped.apiReference).toBe(0);
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
      buildOkfBundle(many, { prefix: "acme", caps: { maxDocs: 3 } }),
    ).rejects.toThrow(/maxDocs: 5 documents > 3 documents.*ATLAS_KNOWLEDGE_INGEST_MAX_DOCS/s);
  });

  test("per-doc byte overflow names the document", async () => {
    const big = sourceOf([page("big.mdx", "x".repeat(2000), { title: "Big" })]);
    await expect(
      buildOkfBundle(big, { prefix: "acme", caps: { maxDocBytes: 100 } }),
    ).rejects.toThrow(IngestCapExceededError);
    await expect(
      buildOkfBundle(big, { prefix: "acme", caps: { maxDocBytes: 100 } }),
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

  test("compressed-archive overflow trips maxBundleBytes with its own detail", () => {
    // The post-gzip check is defense-in-depth: for ordinary text the archive
    // compresses BELOW the decoded total, so to reach the branch the decoded
    // sum must pass while the packed artifact does not. The validator trusts
    // each doc's `bytes` accounting (collect computes it; this test supplies
    // it), so a high-entropy body whose recorded `bytes` understates the
    // content exercises exactly the packed-size refusal.
    let seed = 42;
    const content = Array.from({ length: 2000 }, () => {
      seed = (seed * 48271) % 2147483647; // Lehmer LCG — stays inside 2^53, no precision collapse
      return String.fromCharCode(33 + (seed % 94));
    }).join("");
    const doc = { path: "acme/rand.md", content, bytes: 300, sourcePath: "rand.mdx" };
    expect(() =>
      packOkfBundle([doc], { maxDocs: 10, maxDocBytes: 5000, maxBundleBytes: 1000 }),
    ).toThrow(/compressed archive size/);
  });

  test("an undefined cap override falls back to the default instead of disabling validation", async () => {
    // `caps: { maxDocs: cfg.maxDocs }` with an undefined value must not
    // overwrite the default with undefined (every `>` compare would then be
    // false and generation-time validation silently vanish).
    const many = sourceOf(
      Array.from({ length: 3 }, (_, i) => page(`p${i}.mdx`, `Body of page number ${i}.`)),
    );
    const built = await buildOkfBundle(many, {
      prefix: "acme",
      caps: { maxDocs: undefined, maxDocBytes: undefined, maxBundleBytes: undefined },
    });
    expect(built.stats.documents).toBe(3); // defaults applied, build still validated + succeeded
    await expect(
      buildOkfBundle(many, { prefix: "acme", caps: { maxDocs: 2, maxDocBytes: undefined } }),
    ).rejects.toThrow(/maxDocs: 3 documents > 2 documents/);
  });
});

describe("empty-bundle guard", () => {
  test("packOkfBundle refuses a zero-document set — it would archive the whole collection", () => {
    // A zero-doc bundle fed to the bundle-sync subtractive diff archiveAbsents
    // every existing document; refuse rather than emit a valid empty archive.
    expect(() => packOkfBundle([])).toThrow(EmptyBundleError);
  });

  test("allowEmpty opts into a valid terminator-only archive", () => {
    const { bytes, totalDocBytes } = packOkfBundle([], undefined, { allowEmpty: true });
    expect(totalDocBytes).toBe(0);
    expect(bytes.length).toBeGreaterThan(0); // real gzip of the two-block terminator
  });

  test("buildOkfBundle fails loud when every page is filtered out (a broken glob's shape)", async () => {
    const allFiltered = sourceOf([page("a.mdx", "prose"), page("b.mdx", "more prose")]);
    await expect(
      buildOkfBundle(allFiltered, { prefix: "kb", filter: () => false }),
    ).rejects.toThrow(EmptyBundleError);
  });

  test("buildOkfBundle with allowEmpty tolerates an empty source", async () => {
    const built = await buildOkfBundle(sourceOf([]), { prefix: "kb", allowEmpty: true });
    expect(built.stats.documents).toBe(0);
  });
});

describe("concurrency clamp", () => {
  test("a non-finite / sub-1 concurrency still collects every page (never zero workers)", async () => {
    // Array.from({length: NaN}) is empty → zero workers → a silently empty
    // bundle; the clamp must fall back to the default instead.
    for (const concurrency of [0, -1, Number.NaN, 0.5]) {
      const result = await collectPages(acmeSource(), {
        prefix: "acme",
        concurrency,
        isApiReferenceStub: isAcmeApiReferenceStub,
      });
      expect(result.docs.length).toBe(6);
    }
  });

  test("concurrency 1 produces a byte-identical archive to the default", async () => {
    const opts = { prefix: "acme", isApiReferenceStub: isAcmeApiReferenceStub };
    const serial = await buildOkfBundle(acmeSource(), { ...opts, concurrency: 1 });
    const parallel = await buildOkfBundle(acmeSource(), opts);
    expect(Buffer.from(serial.bytes).equals(Buffer.from(parallel.bytes))).toBe(true);
  });
});

describe("normalizePrefix", () => {
  test("rejects traversal, absolute, and empty prefixes at generation time", () => {
    // The prefix prepends EVERY archive entry path (collect.ts), so a bad
    // prefix must fail loud, not smuggle a traversal into the extract tree.
    expect(() => normalizePrefix("../evil")).toThrow(InvalidPagePathError);
    expect(() => normalizePrefix("/abs")).toThrow(InvalidPagePathError);
    expect(() => normalizePrefix("")).toThrow(InvalidPagePathError);
    expect(() => normalizePrefix("   ")).toThrow(InvalidPagePathError);
  });

  test("a bad prefix fails the whole collect", async () => {
    await expect(collectPages(acmeSource(), { prefix: "../escape" })).rejects.toThrow(
      InvalidPagePathError,
    );
  });

  test("accepts multi-segment prefixes, normalizing separators", () => {
    expect(normalizePrefix("kb/site")).toEqual(["kb", "site"]);
    expect(normalizePrefix("docs")).toEqual(["docs"]);
  });
});

describe("pageTags (shared frontmatter-tag narrower)", () => {
  test("drops non-strings, trims, and drops empties, preserving order", () => {
    expect(pageTags([1, "ok", null, "  x  ", "", true, "y"])).toEqual(["ok", "x", "y"]);
  });

  test("a non-array value is an empty list", () => {
    expect(pageTags("nope")).toEqual([]);
    expect(pageTags(undefined)).toEqual([]);
    expect(pageTags({ a: 1 })).toEqual([]);
  });
});

describe("deterministic packing", () => {
  test("same source builds byte-identical archives, regardless of page order", async () => {
    const pages = acmeSource().getPages();
    const opts = { prefix: "acme", isApiReferenceStub: isAcmeApiReferenceStub };
    const a = await buildOkfBundle(sourceOf(pages), opts);
    const b = await buildOkfBundle(sourceOf([...pages].reverse()), opts);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  test("stats reconcile: documents == emitted docs, skips accounted", async () => {
    const result = await buildOkfBundle(acmeSource(), {
      prefix: "acme",
      isApiReferenceStub: isAcmeApiReferenceStub,
    });
    expect(result.stats.documents).toBe(result.docs.length);
    expect(result.stats.documents).toBe(6);
    expect(result.stats.skipped.apiReference + result.stats.skipped.contentless).toBe(2);
    expect(result.stats.totalDocBytes).toBe(result.docs.reduce((n, d) => n + d.bytes, 0));
    expect(result.stats.archiveBytes).toBe(result.bytes.length);
  });
});

describe("isContentlessBody", () => {
  test("component-only body is contentless; prose and code are content", () => {
    expect(isContentlessBody("<ChangelogTimeline />")).toBe(true);
    expect(isContentlessBody("Real prose that should be kept for the KB.")).toBe(false);
    expect(isContentlessBody("```sql\nSELECT 1;\n```")).toBe(false);
  });

  test("a long run of unclosed '<' resolves in linear time (no polynomial ReDoS)", () => {
    // Guards the js/polynomial-redos fix: the tag-strip regex must not blow up
    // on a pathological body of many `<` with no closing `>`. The strip leaves
    // the literal `<` run intact, so the body reads as content — the property
    // under test is that it returns *quickly*, not what it returns.
    const start = performance.now();
    expect(isContentlessBody("<".repeat(200_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
