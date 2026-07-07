/**
 * The MkDocs OKF importer (#4392) — the markdown-tree adapter plus a nav
 * filter keyed on `mkdocs.yml`'s `nav:` tree, exercised through the BUILD
 * entry with real directory fixtures (the same posture as the Mintlify
 * tests). Pins: the `docs_dir` resolution, the nav walk over MkDocs's three
 * entry shapes (bare path, titled path, titled section list), MkDocs's
 * nav-absent auto-discovery semantics, and the fail-loud posture on a
 * missing/malformed/unresolvable config.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";

import {
  buildOkfBundle,
  createMkDocsSource,
  NavManifestError,
  parseMkDocsConfig,
  type ParseYaml,
} from "../src/index";

const parseYaml: ParseYaml = (raw) => yaml.load(raw);

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function treeOf(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okf-mkdocs-"));
  cleanups.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), content, "utf8");
  }
  return root;
}

/** A representative MkDocs (Material-shaped) site: bare-path entries, titled
 *  entries, a titled nested section, an external link, and pages both in and
 *  out of nav. */
const REPRESENTATIVE_MKDOCS_YML = [
  "site_name: Acme Docs",
  "theme:",
  "  name: material",
  "nav:",
  "  - Home: index.md",
  "  - getting-started.md",
  "  - User Guide:",
  "      - guide/index.md",
  "      - Configuration: guide/config.md",
  "  - Community: https://community.example.com",
  "",
].join("\n");

const REPRESENTATIVE_TREE: Record<string, string> = {
  "mkdocs.yml": REPRESENTATIVE_MKDOCS_YML,
  "docs/index.md": "# Welcome\n\nAcme home page prose, long enough to count.",
  "docs/getting-started.md": "Getting started prose that is long enough.",
  "docs/guide/index.md": "Guide overview prose, definitely long enough.",
  "docs/guide/config.md": "Configuration guide prose, long enough here.",
  // Present on disk, absent from nav — must be skipped and COUNTED.
  "docs/drafts/wip.md": "A draft page the nav never mentions, skipped.",
};

describe("createMkDocsSource → buildOkfBundle", () => {
  test("collects only nav-reachable pages; off-nav pages are skipped and counted", async () => {
    const root = await treeOf(REPRESENTATIVE_TREE);
    const { source, filter, nav } = await createMkDocsSource({ root, parseYaml });

    expect(nav.configPath).toBe("mkdocs.yml");
    expect(nav.docsDir).toBe("docs");
    const result = await buildOkfBundle(source, { prefix: "kb", filter, tags: ["mkdocs"] });
    expect(result.docs.map((d) => d.path)).toEqual([
      "kb/getting-started.md",
      "kb/guide/config.md",
      "kb/guide.md",
      "kb/overview.md",
    ]);
    // drafts/wip.md declined by the nav filter.
    expect(result.stats.skipped.filtered).toBe(1);

    // Deterministic rebuild: identical tree → identical bytes.
    const againSource = await createMkDocsSource({ root, parseYaml });
    const again = await buildOkfBundle(againSource.source, {
      prefix: "kb",
      filter: againSource.filter,
      tags: ["mkdocs"],
    });
    expect(Buffer.from(again.bytes).equals(Buffer.from(result.bytes))).toBe(true);
  });

  test("maps frontmatter title/description; a differing nav label is never used as the title", async () => {
    const root = await treeOf({
      "mkdocs.yml": "nav:\n  - Nav Label That Differs: page.md\n",
      "docs/page.md": [
        "---",
        'title: "Frontmatter Title"',
        "description: Frontmatter description here",
        "---",
        "Body prose that is long enough to count.",
      ].join("\n"),
    });
    const { source, filter } = await createMkDocsSource({ root, parseYaml });
    const result = await buildOkfBundle(source, { prefix: "kb", filter });
    const doc = result.docs.find((d) => d.path === "kb/page.md");
    expect(doc?.content).toContain('title: "Frontmatter Title"');
    expect(doc?.content).toContain('description: "Frontmatter description here"');
    // The nav label is navigation chrome, not document metadata — it must not
    // leak into the OKF title (collectNavPages deliberately discards labels).
    expect(doc?.content).not.toContain("Nav Label That Differs");
  });

  test("a custom extensions option keeps the filter's strip in sync — failure stays accurately attributed", async () => {
    const root = await treeOf({
      "mkdocs.yml": "nav:\n  - Notes: notes.markdown\n",
      "docs/notes.markdown": "---\ntitle: Notes\n---\nCustom-extension page prose here.",
    });
    const { source, filter } = await createMkDocsSource({
      root,
      parseYaml,
      extensions: [".markdown"],
    });
    // The filter must PASS the page (extension strip synced to the effective
    // set), so the build fails downstream naming the page — the core archive
    // mapping accepts only .md/.mdx. Out of sync, the filter would drop every
    // page and misattribute the failure as an EmptyBundleError.
    await expect(buildOkfBundle(source, { prefix: "kb", filter })).rejects.toThrow(
      /notes\.markdown/,
    );
  });

  test("a custom docs_dir roots the tree walk — archive paths carry no docs-dir prefix", async () => {
    const root = await treeOf({
      "mkdocs.yml": ["site_name: Custom", "docs_dir: content", "nav:", "  - Home: home.md", ""].join(
        "\n",
      ),
      "content/home.md": "Home page prose that is long enough to count.",
      // A stray page in the DEFAULT docs dir must be invisible — the walk is
      // rooted at content/, not docs/.
      "docs/ignored.md": "This lives in the default docs dir, never walked.",
    });
    const { source, filter, nav } = await createMkDocsSource({ root, parseYaml });
    expect(nav.docsDir).toBe("content");
    const result = await buildOkfBundle(source, { prefix: "kb", filter });
    expect(result.docs.map((d) => d.path)).toEqual(["kb/home.md"]);
  });

  test("a config with no nav collects the whole docs_dir (MkDocs auto-discovery)", async () => {
    const root = await treeOf({
      "mkdocs.yml": "site_name: Auto\ntheme:\n  name: material\n",
      "docs/index.md": "Auto index page prose, long enough to count.",
      "docs/guide.md": "Auto guide page prose, long enough to count.",
    });
    const { source, filter, nav } = await createMkDocsSource({ root, parseYaml });
    expect(nav.pages).toBeNull();
    const result = await buildOkfBundle(source, { prefix: "kb", filter });
    expect(result.docs.map((d) => d.path)).toEqual(["kb/guide.md", "kb/overview.md"]);
    expect(result.stats.skipped.filtered).toBe(0);
  });

  test("legacy mkdocs.yaml config is accepted when mkdocs.yml is absent", async () => {
    const root = await treeOf({
      "mkdocs.yaml": "site_name: Legacy\nnav:\n  - Welcome: welcome.md\n",
      "docs/welcome.md": "Welcome page prose, long enough to count here.",
      "docs/orphan.md": "Not in the nav, must be filtered and counted.",
    });
    const { source, filter, nav } = await createMkDocsSource({ root, parseYaml });
    expect(nav.configPath).toBe("mkdocs.yaml");
    const result = await buildOkfBundle(source, { prefix: "kb", filter });
    expect(result.docs.map((d) => d.path)).toEqual(["kb/welcome.md"]);
    expect(result.stats.skipped.filtered).toBe(1);
  });

  test("mkdocs.yml wins over a stale mkdocs.yaml sitting next to it", async () => {
    const root = await treeOf({
      "mkdocs.yml": "nav:\n  - Current: current.md\n",
      "mkdocs.yaml": "nav:\n  - Stale: stale.md\n",
      "docs/current.md": "Current page prose, long enough to count.",
      "docs/stale.md": "Stale page prose, long enough to count here.",
    });
    const { nav } = await createMkDocsSource({ root, parseYaml });
    expect(nav.configPath).toBe("mkdocs.yml");
    expect(nav.pages?.has("current")).toBe(true);
    expect(nav.pages?.has("stale")).toBe(false);
  });

  test("an explicit config override is used exclusively — no mkdocs.yml fallback", async () => {
    const root = await treeOf({
      "custom.yml": "nav:\n  - Only: only.md\n",
      "mkdocs.yml": "nav:\n  - Never: never.md\n",
      "docs/only.md": "The override config's page prose, long enough.",
      "docs/never.md": "The default config's page prose, long enough.",
    });
    const { nav } = await createMkDocsSource({ root, parseYaml, config: "custom.yml" });
    expect(nav.configPath).toBe("custom.yml");
    expect(nav.pages?.has("only")).toBe(true);
    expect(nav.pages?.has("never")).toBe(false);

    // An ABSENT override fails loud naming the override — never a silent
    // fallback to the mkdocs.yml sitting right there.
    await expect(
      createMkDocsSource({ root, parseYaml, config: "absent.yml" }),
    ).rejects.toThrow(/absent\.yml/);
  });
});

describe("parseMkDocsConfig", () => {
  test("walks the three nav entry shapes and ignores titles + external links", () => {
    const nav = parseMkDocsConfig(
      [
        "nav:",
        "  - Home: index.md",
        "  - getting-started.md",
        "  - User Guide:",
        "      - guide/intro.md",
        "      - Configuration: guide/config.md",
        "  - Community: https://community.example.com",
        "  - Protocol Relative: //cdn.example.com/x",
      ].join("\n"),
      "mkdocs.yml",
      parseYaml,
    );
    expect([...(nav.pages ?? [])].sort()).toEqual([
      "getting-started",
      "guide/config",
      "guide/intro",
      "index",
    ]);
  });

  test("nav entries tolerate a leading slash and a missing extension", () => {
    const nav = parseMkDocsConfig(
      "nav:\n  - A: /slashed.md\n  - B: extensionless\n",
      "mkdocs.yml",
      parseYaml,
    );
    expect([...(nav.pages ?? [])].sort()).toEqual(["extensionless", "slashed"]);
  });
});

describe("fail-loud config handling", () => {
  test("neither mkdocs.yml nor mkdocs.yaml at root → NavManifestError naming both", async () => {
    const root = await treeOf({ "docs/page.md": "Some page prose, long enough to count." });
    await expect(createMkDocsSource({ root, parseYaml })).rejects.toThrow(NavManifestError);
    await expect(createMkDocsSource({ root, parseYaml })).rejects.toThrow(
      /mkdocs\.yml.*mkdocs\.yaml/,
    );
  });

  test("an unreadable mkdocs.yml (a directory) fails loud — never a silent fallback to mkdocs.yaml", async () => {
    const root = await treeOf({
      "mkdocs.yaml": "nav:\n  - Stale: stale.md\n",
      "docs/stale.md": "Stale legacy page prose, long enough to count.",
    });
    await mkdir(join(root, "mkdocs.yml")); // present but unreadable (EISDIR)
    const attempt = createMkDocsSource({ root, parseYaml });
    await expect(attempt).rejects.toThrow(NavManifestError);
    const err = await attempt.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NavManifestError);
    expect((err as NavManifestError).manifestPath).toBe("mkdocs.yml");
  });

  test("malformed YAML → NavManifestError naming the config", () => {
    // A tab-indented mapping value is invalid YAML.
    expect(() => parseMkDocsConfig("nav:\n\t- bad: indentation", "mkdocs.yml", parseYaml)).toThrow(
      NavManifestError,
    );
  });

  test("a non-mapping config document → NavManifestError", () => {
    expect(() => parseMkDocsConfig("- just\n- a\n- list", "mkdocs.yml", parseYaml)).toThrow(
      /not a YAML mapping/,
    );
  });

  test("a non-list nav → NavManifestError", () => {
    expect(() => parseMkDocsConfig("nav: not-a-list", "mkdocs.yml", parseYaml)).toThrow(
      /not a list/,
    );
  });

  test("a nav that resolves to zero pages → NavManifestError, never a silent empty bundle", () => {
    expect(() =>
      parseMkDocsConfig(
        "nav:\n  - Community: https://example.com\n",
        "mkdocs.yml",
        parseYaml,
      ),
    ).toThrow(/no page paths/);
  });

  test("a non-string docs_dir → NavManifestError", () => {
    expect(() =>
      parseMkDocsConfig("docs_dir:\n  - a\nnav:\n  - H: home.md\n", "mkdocs.yml", parseYaml),
    ).toThrow(/docs_dir/);
  });

  test("a config-named docs_dir that does not exist → NavManifestError naming the docs_dir", async () => {
    // Only mkdocs.yml is written; the named docs dir is absent on disk.
    const root = await treeOf({ "mkdocs.yml": "docs_dir: missing_dir\nnav:\n  - Home: home.md\n" });
    await expect(createMkDocsSource({ root, parseYaml })).rejects.toThrow(NavManifestError);
    await expect(createMkDocsSource({ root, parseYaml })).rejects.toThrow(/missing_dir/);
  });
});
