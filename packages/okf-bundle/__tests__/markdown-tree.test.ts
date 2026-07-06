/**
 * The markdown-tree doc-source adapter (#4374) — exercised through the BUILD
 * entry with a real directory fixture, the same posture as the Acme fixture
 * tests (no test reaches past the doc-source seam). The frontmatter tests pin
 * that splitting goes through the wire module's shared mechanics (YAML via
 * the injected parser — block/flow lists, quoting, fail-loud on a malformed
 * block), replacing the docs portal's retired hand-rolled line-scan. The
 * ESM-strip tests moved here with the strip when it promoted out of the
 * portal shims.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";

import {
  buildOkfBundle,
  collectPages,
  createMarkdownTreeSource,
  PageLoadError,
  stripMdxModuleLines,
  type ParseYaml,
} from "../src/index";

const parseYaml: ParseYaml = (raw) => yaml.load(raw);

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function treeOf(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okf-md-tree-"));
  cleanups.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), content, "utf8");
  }
  return root;
}

describe("createMarkdownTreeSource → buildOkfBundle", () => {
  test("walks a tree: frontmatter into OKF, ESM-stripped .mdx bodies, deterministic paths", async () => {
    const root = await treeOf({
      "guides/setup.mdx": [
        "---",
        'title: "Setup"',
        "description: Getting started",
        "tags: [install]",
        "---",
        'import { Callout } from "fumadocs-ui/components/callout";',
        "",
        "Real setup prose that survives.",
      ].join("\n"),
      "guides/index.mdx": "---\ntitle: Guides\n---\nAll guides live here, organized by workload.",
      "plain.md": "Plain markdown body, no frontmatter at all — still a page.",
    });

    const source = await createMarkdownTreeSource({ root, parseYaml });
    expect(source.getPages().map((p) => p.path)).toEqual([
      "guides/index.mdx",
      "guides/setup.mdx",
      "plain.md",
    ]);

    const result = await buildOkfBundle(source, { prefix: "docs", tags: ["tree"] });
    expect(result.docs.map((d) => d.path)).toEqual([
      "docs/guides.md", // index fold
      "docs/guides/setup.md",
      "docs/plain.md",
    ]);
    const setup = result.docs.find((d) => d.path === "docs/guides/setup.md");
    expect(setup?.content).toContain('title: "Setup"');
    expect(setup?.content).toContain('description: "Getting started"');
    expect(setup?.content).toContain('tags: ["tree", "install"]');
    expect(setup?.content).toContain("Real setup prose");
    expect(setup?.content).not.toContain("fumadocs-ui/components");

    // Deterministic rebuild: identical content → identical bytes.
    const again = await buildOkfBundle(await createMarkdownTreeSource({ root, parseYaml }), {
      prefix: "docs",
      tags: ["tree"],
    });
    expect(Buffer.from(again.bytes).equals(Buffer.from(result.bytes))).toBe(true);
  });

  test("frontmatter goes through the wire split: block-list tags, quoted scalars, non-string tags dropped at render", async () => {
    const root = await treeOf({
      "a.mdx": "---\ntitle: 'Quoted'\ntags:\n  - alpha\n  - beta\n---\nBody prose here.",
      "b.mdx": "---\ntitle: Mixed\ntags: [ok, 42]\n---\nMore body prose here.",
    });
    const collected = await collectPages(await createMarkdownTreeSource({ root, parseYaml }), {
      prefix: "kb",
    });
    const a = collected.docs.find((d) => d.path === "kb/a.md");
    expect(a?.content).toContain('title: "Quoted"');
    expect(a?.content).toContain('tags: ["alpha", "beta"]');
    const b = collected.docs.find((d) => d.path === "kb/b.md");
    expect(b?.content).toContain('tags: ["ok"]'); // 42 dropped by the shared narrower
  });

  test("a malformed frontmatter block fails LOUD with the page named — never rides into a document", async () => {
    const root = await treeOf({
      "broken.mdx": "---\ntitle: [unclosed\n---\nBody.",
      "fine.mdx": "Fine page prose, long enough to count as content.",
    });
    const source = await createMarkdownTreeSource({ root, parseYaml });
    await expect(collectPages(source, { prefix: "kb" })).rejects.toThrow(PageLoadError);
    await expect(collectPages(source, { prefix: "kb" })).rejects.toThrow("broken.mdx");
  });

  test("metadata + body resolve lazily: a filtered page is never read", async () => {
    const root = await treeOf({
      "kept.mdx": "---\ntitle: Kept\n---\nKept page body prose, long enough.",
      // Malformed — but filtered out BEFORE any read, so the build succeeds.
      "api-reference/stub.mdx": "---\ntitle: [unclosed\n---\n<APIPage />",
    });
    const collected = await collectPages(await createMarkdownTreeSource({ root, parseYaml }), {
      prefix: "kb",
      isApiReferenceStub: (p) => p.path.startsWith("api-reference/"),
    });
    expect(collected.docs.map((d) => d.path)).toEqual(["kb/kept.md"]);
    expect(collected.skipped.apiReference).toBe(1);
  });

  test("hidden segments and foreign extensions are excluded; .md bodies keep column-0 import prose", async () => {
    const root = await treeOf({
      ".drafts/secret.mdx": "Never a page.",
      "notes.txt": "Not a page either.",
      "howto.md": "import duties apply when shipping hardware.\n\nPlain md is never ESM-stripped.",
    });
    const source = await createMarkdownTreeSource({ root, parseYaml });
    expect(source.getPages().map((p) => p.path)).toEqual(["howto.md"]);
    const body = await source.getPages()[0].loadBody();
    expect(body).toContain("import duties apply");
  });

  test("stripMdxModules: false keeps .mdx module lines verbatim", async () => {
    const root = await treeOf({
      "raw.mdx": 'import { X } from "y";\n\nProse after the import line.',
    });
    const source = await createMarkdownTreeSource({ root, parseYaml, stripMdxModules: false });
    expect(await source.getPages()[0].loadBody()).toContain('import { X } from "y";');
  });
});

// Promoted with the strip out of the portal shims (#4374) — same behaviors.
describe("stripMdxModuleLines", () => {
  test("removes top-level ESM but preserves fenced examples", () => {
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

  test("consumes a multi-line top-level import without eating the prose after it", () => {
    const input = [
      "import {",
      "  Callout,",
      "  Tabs,",
      '} from "fumadocs-ui/components";',
      "",
      "Prose that must survive the multi-line strip.",
    ].join("\n");
    expect(stripMdxModuleLines(input)).toBe("Prose that must survive the multi-line strip.");
  });

  test("does NOT run a terminator-less single-line export away into the prose", () => {
    // `export default Foo` has no trailing {/(/[/, — it must drop only its own
    // line, never the continuation-consuming scan (which would swallow the body).
    const input = ["export default MyComponent", "", "This prose must NOT be consumed."].join(
      "\n",
    );
    expect(stripMdxModuleLines(input)).toBe("This prose must NOT be consumed.");
  });

  test("an ESM statement that never terminates before EOF throws instead of silently swallowing the page", () => {
    // The continuation scan used to consume to EOF — silent content loss the
    // bundle guards can't see (the document is emitted wrong-but-present).
    const input = ["import {", "  Never,", "  Terminated"].join("\n");
    expect(() => stripMdxModuleLines(input)).toThrow(/never terminates/);
  });

  test("a prose-shaped continuation run trips the line cap instead of eating paragraphs", () => {
    // A hard-wrapped paragraph whose wrap lands `import ` at column 0 ending
    // in a comma looks like a multi-line ESM opener; the cap refuses before
    // the scan can swallow a page of prose (lines end in `.` — no terminator).
    const prose = Array.from({ length: 30 }, (_, n) => `Wrapped prose line number ${n}.`);
    const input = ["import duty rates rose sharply in Q3,", ...prose].join("\n");
    expect(() => stripMdxModuleLines(input)).toThrow(/unterminated top-level ESM/);
  });

  test("a prose false-positive that hits a bracket-tailed line throws instead of truncating", () => {
    // `import duty rates rose in Q3,` reads as a multi-line ESM opener; the
    // next line ends in `)` (a terminator CANDIDATE) but is not ESM-shaped —
    // consuming through it would silently delete the paragraph.
    const input = [
      "import duty rates rose sharply in Q3,",
      "according to the survey (Figure 2)",
      "",
      "More prose.",
    ].join("\n");
    expect(() => stripMdxModuleLines(input)).toThrow(/does not look like an ESM closer/);
  });

  test("a real multi-line export terminating on `}` still strips cleanly", () => {
    const input = [
      "export const meta = {",
      '  title: "Hello",',
      "}",
      "",
      "Prose survives.",
    ].join("\n");
    expect(stripMdxModuleLines(input)).toBe("Prose survives.");
  });

  test("an info-string fence line inside an open fence is content, not a closer", () => {
    // CommonMark: closing fences carry no info string. The inner ```ts line
    // must NOT close the outer block (which would invert fence state and
    // strip the import that is part of the example).
    const input = [
      "````md",
      "```ts",
      'import { Example } from "pkg";',
      "```",
      "````",
      "",
      "Prose after.",
    ].join("\n");
    const out = stripMdxModuleLines(input);
    expect(out).toContain('import { Example } from "pkg";');
    expect(out).toContain("Prose after.");
  });

  test("a 4-backtick fence is NOT closed by an inner 3-backtick fence (CommonMark closer length)", () => {
    // ````-fenced blocks exist precisely to show ```-fenced examples; the
    // inner fence is content. An import inside the outer fence must survive.
    const input = [
      "````mdx",
      "```ts",
      "code example",
      "```",
      'import { StillInsideOuterFence } from "x";',
      "````",
      "",
      "Prose after.",
    ].join("\n");
    const out = stripMdxModuleLines(input);
    expect(out).toContain("StillInsideOuterFence");
    expect(out).toContain("Prose after.");
  });

  test("a runaway strip surfaces through the adapter as PageLoadError naming the page", async () => {
    const root = await treeOf({
      "swallower.mdx": "import {\n  never,\n  closed",
    });
    const source = await createMarkdownTreeSource({ root, parseYaml });
    await expect(collectPages(source, { prefix: "kb" })).rejects.toThrow(PageLoadError);
    await expect(collectPages(source, { prefix: "kb" })).rejects.toThrow("swallower.mdx");
  });
});
