/**
 * The docs → KB bundle leak-safety regression net (issue #4367; refit onto
 * the core builder in #4374): the portal script consumes `@atlas/okf-bundle`
 * (local mode via the core's markdown-tree adapter), supplying audience
 * stripping via the body-transform hook. These tests PIN the leak-safety
 * property PR #4366 carried — a SaaS bundle is structurally incapable of
 * carrying self-hosted branches — expressed through the real portal wiring:
 *
 *   1. the transform resolves `<WhenSaaS>`/`<WhenSelfHosted>`/`<AudienceLink>`
 *      for the target audience (inactive branch REMOVED, active branch
 *      unwrapped);
 *   2. a page the strip cannot fully resolve is SKIPPED (transform → null),
 *      never emitted with a residual branch;
 *   3. a full build over an audience-forked fixture yields bundle bodies
 *      with zero opposite-audience content.
 *
 * The walk/frontmatter/ESM-strip mechanics that used to live in the portal
 * shims are the markdown-tree adapter's now — tested in
 * `packages/okf-bundle/__tests__/markdown-tree.test.ts`; only portal policy
 * (audience transform, section list, deployed-shim parsing) is pinned here.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { buildOkfBundle, collectPages } from "@atlas/okf-bundle";
import type { DocSource, DocSourcePage } from "@atlas/okf-bundle";
import {
  deployedPagePath,
  isApiReferencePage,
  parseLlmsIndex,
  portalAudienceTransform,
  portalLocalSource,
  portalSectionCollectOptions,
  sectionsFor,
  stripTwinHeading,
} from "../../../scripts/kb-bundle-sources";

const FORKED_BODY = [
  "Shared intro prose for every audience.",
  "",
  "<WhenSaaS>",
  "Use the hosted console at console.example.com.",
  "</WhenSaaS>",
  "",
  "<WhenSelfHosted>",
  "Edit your docker-compose.yml and restart the stack.",
  "</WhenSelfHosted>",
].join("\n");

function pageOf(path: string, body: string, title = "Page"): DocSourcePage {
  return {
    path,
    title,
    loadBody: async () => body,
  };
}

function sourceOf(pages: readonly DocSourcePage[]): DocSource {
  return { getPages: () => pages };
}

describe("portalAudienceTransform (leak safety)", () => {
  test("SaaS transform strips the self-hosted branch and unwraps the SaaS one", () => {
    const out = portalAudienceTransform("saas")(FORKED_BODY, pageOf("x.mdx", FORKED_BODY));
    expect(out).toContain("hosted console");
    expect(out).not.toContain("docker-compose");
    expect(out).not.toContain("WhenSelfHosted");
    expect(out).not.toContain("<WhenSaaS>");
  });

  test("an unresolvable page is skipped (null), never emitted with a residual tag", () => {
    // Single-line inline form — unsupported by the block strip, so the
    // fail-closed post-condition throws; the hook maps that to a skip.
    const inline = "Inline <WhenSelfHosted>secret self-hosted step</WhenSelfHosted> here.";
    const skips: string[] = [];
    const out = portalAudienceTransform("saas", (p) => skips.push(p))(
      inline,
      pageOf("broken.mdx", inline),
    );
    expect(out).toBeNull();
    expect(skips).toEqual(["broken.mdx"]);
  });

  test("core build over a forked fixture: SaaS bundle carries zero self-hosted content", async () => {
    const source = sourceOf([
      pageOf("guide.mdx", FORKED_BODY, "Guide"),
      pageOf("plain.mdx", "Plain shared prose, no conditionals at all.", "Plain"),
    ]);
    const result = await buildOkfBundle(source, {
      prefix: "docs",
      transform: portalAudienceTransform("saas"),
    });
    expect(result.stats.documents).toBe(2);
    for (const doc of result.docs) {
      expect(doc.content).not.toContain("docker-compose");
      expect(doc.content).not.toContain("WhenSelfHosted");
    }
    // And the inverse mount: the self-hosted bundle carries no SaaS branch.
    const sh = await buildOkfBundle(source, {
      prefix: "docs",
      transform: portalAudienceTransform("self-hosted"),
    });
    const guide = sh.docs.find((d) => d.path === "docs/guide.md");
    expect(guide?.content).toContain("docker-compose");
    expect(guide?.content).not.toContain("hosted console");
  });
});

describe("section composition (leak-safety leg 2)", () => {
  test("a SaaS bundle mounts only docs + shared — never the self-hosted tree", () => {
    expect(sectionsFor("saas")).toEqual(["docs", "shared"]);
    expect(sectionsFor("self-hosted")).toEqual(["self-hosted", "shared"]);
  });

  test("every section's collect options carry the audience transform (wiring pin)", async () => {
    for (const audience of ["saas", "self-hosted"] as const) {
      for (const section of sectionsFor(audience)) {
        const options = portalSectionCollectOptions(section, audience);
        expect(options.prefix).toBe(section);
        // API-reference stubs are skipped by default (the wiring pin the old
        // `skipApiReference: true` flag carried, now the portal predicate
        // through the core's `isApiReferenceStub` hook).
        expect(options.isApiReferenceStub?.(pageOf("api-reference/x.mdx", ""))).toBe(true);
        expect(options.isApiReferenceStub?.(pageOf("guides/x.mdx", ""))).toBe(false);
        // The transform must actually strip: run the forked body through it.
        const out = await options.transform?.(FORKED_BODY, pageOf("x.mdx", FORKED_BODY));
        if (audience === "saas") {
          expect(out).toContain("hosted console");
          expect(out).not.toContain("docker-compose");
        } else {
          expect(out).toContain("docker-compose");
          expect(out).not.toContain("hosted console");
        }
      }
    }
  });

  test("isApiReferencePage matches only a top-level api-reference segment", () => {
    expect(isApiReferencePage("api-reference/create-widget.mdx")).toBe(true);
    expect(isApiReferencePage("./API-Reference/x.mdx")).toBe(true);
    expect(isApiReferencePage("guides/api-reference-notes.mdx")).toBe(false);
  });
});

describe("portalLocalSource (markdown-tree adapter wiring)", () => {
  let dir: string | null = null;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("walks a content tree through the core adapter with the portal options", async () => {
    dir = await mkdtemp(join(tmpdir(), "kb-shim-"));
    await mkdir(join(dir, "guides"), { recursive: true });
    await writeFile(
      join(dir, "guides", "setup.mdx"),
      [
        "---",
        'title: "Setup"',
        "description: Getting started",
        "tags: [install]",
        "---",
        'import { Callout } from "fumadocs-ui/components/callout";',
        "",
        "Real setup prose that survives.",
      ].join("\n"),
      "utf8",
    );

    const source = await portalLocalSource(dir);
    const pages = source.getPages();
    expect(pages.map((p) => p.path)).toEqual(["guides/setup.mdx"]);
    expect(pages[0].title).toBe("Setup");
    expect(pages[0].description).toBe("Getting started");
    expect(pages[0].tags).toEqual(["install"]);

    // Through the core with the portal options: one doc, tagged, prefixed,
    // ESM-stripped.
    const collected = await collectPages(source, portalSectionCollectOptions("docs", "saas"));
    expect(collected.docs.map((d) => d.path)).toEqual(["docs/guides/setup.md"]);
    expect(collected.docs[0].content).toContain('tags: ["docs-portal", "docs", "install"]');
    expect(collected.docs[0].content).toContain("Real setup prose");
    expect(collected.docs[0].content).not.toContain("fumadocs-ui/components");
  });
});

describe("deployed-mode shim (portal-local)", () => {
  test("deployedPagePath folds section landings so the builder can dodge index.md", () => {
    expect(deployedPagePath("/quickstart")).toBe("quickstart.mdx");
    expect(deployedPagePath("/guides/")).toBe("guides/index.mdx");
  });

  test("parseLlmsIndex reads paths off absolutized URLs and keeps descriptions", () => {
    const entries = parseLlmsIndex(
      [
        "- [Quickstart](https://docs.useatlas.dev/quickstart): Zero to one",
        "- [Guides](https://docs.useatlas.dev/guides/)",
        "not a link line",
      ].join("\n"),
    );
    expect(entries).toEqual([
      { title: "Quickstart", path: "/quickstart", description: "Zero to one" },
      { title: "Guides", path: "/guides/", description: undefined },
    ]);
  });

  test("stripTwinHeading drops the injected `# Title (url)` line only", () => {
    expect(stripTwinHeading("# Title (/x)\n\nBody starts.")).toBe("Body starts.");
    expect(stripTwinHeading("No heading body.")).toBe("No heading body.");
  });
});
