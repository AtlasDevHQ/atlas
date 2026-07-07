/**
 * The Mintlify OKF importer (#4391) — the markdown-tree adapter plus a
 * `docs.json` nav filter, exercised through the BUILD entry with real
 * directory fixtures (the same posture as the markdown-tree tests). The nav
 * tests pin manifest resolution (docs.json over legacy mint.json), the
 * recursive navigation walk (tabs / anchors / dropdowns / versions /
 * languages / nested groups), and the fail-loud posture on a malformed or
 * unresolvable manifest — a broken manifest must never quietly produce an
 * empty (or over-full) bundle.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";

import {
  buildOkfBundle,
  createMintlifySource,
  NavManifestError,
  parseMintlifyNav,
  type ParseYaml,
} from "../src/index";

const parseYaml: ParseYaml = (raw) => yaml.load(raw);

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function treeOf(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okf-mintlify-"));
  cleanups.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), content, "utf8");
  }
  return root;
}

/** A representative Mintlify site: tabs → groups → nested groups, an anchor
 *  division, a global external anchor (href only, never a page), and pages
 *  both in and out of nav. */
const REPRESENTATIVE_DOCS_JSON = JSON.stringify({
  name: "Acme Docs",
  theme: "mint",
  navigation: {
    tabs: [
      {
        tab: "Guides",
        groups: [
          {
            group: "Get Started",
            pages: [
              "introduction",
              "quickstart",
              { group: "Advanced", pages: ["advanced/config"] },
            ],
          },
        ],
      },
      {
        tab: "API",
        anchors: [{ anchor: "Reference", pages: ["api/overview"] }],
      },
    ],
    global: {
      anchors: [{ anchor: "Community", href: "https://community.example.com" }],
    },
  },
});

const REPRESENTATIVE_TREE: Record<string, string> = {
  "docs.json": REPRESENTATIVE_DOCS_JSON,
  "introduction.mdx": [
    "---",
    'title: "Introduction"',
    "description: What Acme is",
    "---",
    'import { Card } from "@mintlify/components";',
    "",
    "Acme introduction prose that survives the strip.",
  ].join("\n"),
  "quickstart.mdx": "---\ntitle: Quickstart\n---\nQuickstart prose, long enough to count.",
  "advanced/config.mdx": "---\ntitle: Config\n---\nAdvanced configuration prose here.",
  "api/overview.md": "---\ntitle: API Overview\n---\nOverview of the API surface.",
  // Present on disk, absent from nav — must be skipped and COUNTED.
  "changelog/v1.mdx": "---\ntitle: v1\n---\nOld changelog entry, not navigable.",
  "snippets/reusable.mdx": "Reusable snippet content, never a page.",
};

describe("createMintlifySource → buildOkfBundle", () => {
  test("collects only nav-reachable pages; off-nav pages are skipped and counted", async () => {
    const root = await treeOf(REPRESENTATIVE_TREE);
    const { source, filter, nav } = await createMintlifySource({ root, parseYaml });

    expect(nav.manifestPath).toBe("docs.json");
    const result = await buildOkfBundle(source, { prefix: "docs", filter, tags: ["mintlify"] });
    expect(result.docs.map((d) => d.path)).toEqual([
      "docs/advanced/config.md",
      "docs/api/overview.md",
      "docs/introduction.md",
      "docs/quickstart.md",
    ]);
    // changelog/v1.mdx + snippets/reusable.mdx declined by the nav filter.
    expect(result.stats.skipped.filtered).toBe(2);

    // Mintlify frontmatter rides the shared wire split into OKF fields; the
    // MDX module line is stripped by the existing fence-aware strip.
    const intro = result.docs.find((d) => d.path === "docs/introduction.md");
    expect(intro?.content).toContain('title: "Introduction"');
    expect(intro?.content).toContain('description: "What Acme is"');
    expect(intro?.content).toContain("Acme introduction prose");
    expect(intro?.content).not.toContain("@mintlify/components");

    // Deterministic rebuild: identical tree → identical bytes.
    const againSource = await createMintlifySource({ root, parseYaml });
    const again = await buildOkfBundle(againSource.source, {
      prefix: "docs",
      filter: againSource.filter,
      tags: ["mintlify"],
    });
    expect(Buffer.from(again.bytes).equals(Buffer.from(result.bytes))).toBe(true);
  });

  test("legacy mint.json manifests are accepted when docs.json is absent", async () => {
    const root = await treeOf({
      "mint.json": JSON.stringify({
        name: "Legacy",
        navigation: [
          {
            group: "Docs",
            pages: ["welcome", { group: "Nested", pages: ["deep/page"] }],
          },
        ],
      }),
      "welcome.mdx": "---\ntitle: Welcome\n---\nWelcome page prose, long enough.",
      "deep/page.mdx": "---\ntitle: Deep\n---\nNested legacy page prose here.",
      "orphan.mdx": "Not in the legacy nav, must be filtered.",
    });
    const { source, filter, nav } = await createMintlifySource({ root, parseYaml });
    expect(nav.manifestPath).toBe("mint.json");
    const result = await buildOkfBundle(source, { prefix: "kb", filter });
    expect(result.docs.map((d) => d.path)).toEqual(["kb/deep/page.md", "kb/welcome.md"]);
    expect(result.stats.skipped.filtered).toBe(1);
  });

  test("docs.json wins over a stale mint.json sitting next to it", async () => {
    const root = await treeOf({
      "docs.json": JSON.stringify({ navigation: { pages: ["current"] } }),
      "mint.json": JSON.stringify({ navigation: [{ group: "Old", pages: ["stale"] }] }),
      "current.mdx": "---\ntitle: Current\n---\nCurrent page prose, long enough.",
      "stale.mdx": "---\ntitle: Stale\n---\nStale page prose, long enough.",
    });
    const { filter, nav } = await createMintlifySource({ root, parseYaml });
    expect(nav.manifestPath).toBe("docs.json");
    expect(nav.pages.has("current")).toBe(true);
    expect(nav.pages.has("stale")).toBe(false);
    expect(filter({ path: "stale.mdx", loadBody: async () => "" })).toBe(false);
  });

  test("versions and languages divisions resolve to the union of their page sets", async () => {
    const root = await treeOf({
      "docs.json": JSON.stringify({
        navigation: {
          versions: [
            { version: "v2", groups: [{ group: "Docs", pages: ["v2/start"] }] },
            {
              version: "v1",
              languages: [{ language: "en", pages: ["v1/en/start"] }],
            },
          ],
        },
      }),
      "v2/start.mdx": "---\ntitle: V2\n---\nVersion two start page prose.",
      "v1/en/start.mdx": "---\ntitle: V1 EN\n---\nVersion one english prose.",
    });
    const { source, filter } = await createMintlifySource({ root, parseYaml });
    const result = await buildOkfBundle(source, { prefix: "docs", filter });
    expect(result.docs.map((d) => d.path)).toEqual(["docs/v1/en/start.md", "docs/v2/start.md"]);
  });

  test("nav entries tolerate a leading slash and an explicit extension", async () => {
    const root = await treeOf({
      "docs.json": JSON.stringify({
        navigation: { pages: ["/slashed", "explicit.mdx"] },
      }),
      "slashed.mdx": "---\ntitle: Slashed\n---\nLeading-slash nav entry prose.",
      "explicit.mdx": "---\ntitle: Explicit\n---\nExtension-carrying nav entry prose.",
    });
    const { source, filter } = await createMintlifySource({ root, parseYaml });
    const result = await buildOkfBundle(source, { prefix: "docs", filter });
    expect(result.docs.map((d) => d.path)).toEqual(["docs/explicit.md", "docs/slashed.md"]);
  });
});

describe("fail-loud manifest handling", () => {
  test("neither docs.json nor mint.json at root → NavManifestError naming both", async () => {
    const root = await treeOf({
      "page.mdx": "---\ntitle: P\n---\nSome page prose, long enough to count.",
    });
    await expect(createMintlifySource({ root, parseYaml })).rejects.toThrow(NavManifestError);
    await expect(createMintlifySource({ root, parseYaml })).rejects.toThrow(/docs\.json.*mint\.json/);
  });

  test("malformed JSON → NavManifestError naming the manifest", async () => {
    const root = await treeOf({
      "docs.json": "{ not json",
      "page.mdx": "---\ntitle: P\n---\nSome page prose, long enough to count.",
    });
    await expect(createMintlifySource({ root, parseYaml })).rejects.toThrow(NavManifestError);
    await expect(createMintlifySource({ root, parseYaml })).rejects.toThrow(/docs\.json/);
  });

  test("a manifest whose navigation yields ZERO pages → NavManifestError, never a silent empty bundle", async () => {
    const root = await treeOf({
      "docs.json": JSON.stringify({
        navigation: {
          global: { anchors: [{ anchor: "Only Links", href: "https://example.com" }] },
        },
      }),
      "page.mdx": "---\ntitle: P\n---\nSome page prose, long enough to count.",
    });
    await expect(createMintlifySource({ root, parseYaml })).rejects.toThrow(NavManifestError);
    await expect(createMintlifySource({ root, parseYaml })).rejects.toThrow(/no page paths/);
  });

  test("a manifest with no navigation key at all → NavManifestError", async () => {
    const root = await treeOf({
      "docs.json": JSON.stringify({ name: "No Nav Here" }),
      "page.mdx": "---\ntitle: P\n---\nSome page prose, long enough to count.",
    });
    await expect(createMintlifySource({ root, parseYaml })).rejects.toThrow(NavManifestError);
    await expect(createMintlifySource({ root, parseYaml })).rejects.toThrow(/navigation/);
  });

  test("a non-object manifest document → NavManifestError", () => {
    expect(() => parseMintlifyNav("[1, 2, 3]", "docs.json")).toThrow(NavManifestError);
    expect(() => parseMintlifyNav('"just a string"', "docs.json")).toThrow(NavManifestError);
  });
});

describe("parseMintlifyNav", () => {
  test("walks dropdowns and collects only strings inside pages arrays (hrefs/openapi ignored)", () => {
    const nav = parseMintlifyNav(
      JSON.stringify({
        navigation: {
          dropdowns: [
            {
              dropdown: "SDKs",
              openapi: "https://example.com/openapi.json",
              groups: [{ group: "TS", pages: ["sdk/ts"], icon: "code" }],
            },
          ],
          anchors: [{ anchor: "Blog", href: "https://blog.example.com" }],
        },
      }),
      "docs.json",
    );
    expect([...nav.pages].sort()).toEqual(["sdk/ts"]);
  });

  test("external links inside a pages array are ignored, not treated as page paths", () => {
    const nav = parseMintlifyNav(
      JSON.stringify({
        navigation: { pages: ["real/page", "https://example.com/external"] },
      }),
      "docs.json",
    );
    expect([...nav.pages].sort()).toEqual(["real/page"]);
  });
});
