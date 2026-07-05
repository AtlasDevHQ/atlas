/**
 * The docs → KB bundle refit (issue #4367): the portal script consumes the
 * `@atlas/fumadocs-okf` adapter, supplying audience stripping via the
 * body-transform hook. These tests PIN the leak-safety property PR #4366
 * carried — a SaaS bundle is structurally incapable of carrying self-hosted
 * branches — now expressed through the adapter pipeline:
 *
 *   1. the transform resolves `<WhenSaaS>`/`<WhenSelfHosted>`/`<AudienceLink>`
 *      for the target audience (inactive branch REMOVED, active branch
 *      unwrapped);
 *   2. a page the strip cannot fully resolve is SKIPPED (transform → null),
 *      never emitted with a residual branch;
 *   3. a full adapter build over an audience-forked fixture yields bundle
 *      bodies with zero opposite-audience content.
 */

import { describe, expect, test } from "bun:test";

import { buildFumadocsOkfBundle } from "@atlas/fumadocs-okf";
import type { FumadocsOkfPage, FumadocsOkfSource } from "@atlas/fumadocs-okf";
import {
  deployedPagePath,
  parseLlmsIndex,
  portalAudienceTransform,
  splitFrontmatter,
  stripMdxModuleLines,
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

function pageOf(path: string, body: string, title = "Page"): FumadocsOkfPage {
  return {
    path,
    data: { title, getText: async () => body },
  };
}

function sourceOf(pages: readonly FumadocsOkfPage[]): FumadocsOkfSource {
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

  test("adapter build over a forked fixture: SaaS bundle carries zero self-hosted content", async () => {
    const source = sourceOf([
      pageOf("guide.mdx", FORKED_BODY, "Guide"),
      pageOf("plain.mdx", "Plain shared prose, no conditionals at all.", "Plain"),
    ]);
    const result = await buildFumadocsOkfBundle(source, {
      prefix: "docs",
      transform: portalAudienceTransform("saas"),
    });
    expect(result.stats.documents).toBe(2);
    for (const doc of result.docs) {
      expect(doc.content).not.toContain("docker-compose");
      expect(doc.content).not.toContain("WhenSelfHosted");
    }
    // And the inverse mount: the self-hosted bundle carries no SaaS branch.
    const sh = await buildFumadocsOkfBundle(source, {
      prefix: "docs",
      transform: portalAudienceTransform("self-hosted"),
    });
    const guide = sh.docs.find((d) => d.path === "docs/guide.md");
    expect(guide?.content).toContain("docker-compose");
    expect(guide?.content).not.toContain("hosted console");
  });
});

describe("kb-bundle source shims", () => {
  test("splitFrontmatter pulls title/description/tags and leaves the body intact", () => {
    const { fm, body } = splitFrontmatter(
      '---\ntitle: "Quickstart"\ndescription: Zero to one\ntags: [a, b]\n---\n# Hello\n',
    );
    expect(fm).toEqual({ title: "Quickstart", description: "Zero to one", tags: ["a", "b"] });
    expect(body).toBe("# Hello\n");
  });

  test("stripMdxModuleLines removes top-level ESM but preserves fenced examples", () => {
    const input = [
      'import { Callout } from "fumadocs-ui/components/callout";',
      "",
      "Prose here.",
      "",
      "```ts",
      'import type { AtlasClient } from "@useatlas/sdk";',
      "```",
    ].join("\n");
    const out = stripMdxModuleLines(input);
    expect(out).not.toContain("fumadocs-ui/components");
    expect(out).toContain('import type { AtlasClient } from "@useatlas/sdk";');
  });

  test("deployedPagePath folds section landings so the adapter can dodge index.md", () => {
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
