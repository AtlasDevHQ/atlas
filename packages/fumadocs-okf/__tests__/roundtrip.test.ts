/**
 * Round-trip: the generated archive through the REAL Atlas ingest pipeline
 * stages — `extractBundle` (magic-byte container detection, traversal/size
 * guards) → `parseLenientBundle` (frontmatter, reserved basenames, links) —
 * imported from `@atlas/api` as a dev dependency, with ZERO changes to
 * `packages/api` (issue #4367 acceptance criterion). These are exactly the
 * stages `ingestBundle()` runs before its transaction, and the ones
 * bundle-sync feeds after `guardedFetch` pulls the endpoint; the
 * transactional tail (draft rows → review → publish) is `packages/api`'s own
 * tested territory.
 *
 * The headline assertion is the reconcile guardrail from the issue: EVERY
 * document the adapter reports built must come out of the lenient parser —
 * no silent reserved-basename drops (the 8-of-165 `index.md` gap that
 * motivated the rename mapping), no rejections, no non-markdown skips.
 */

import { describe, expect, test } from "bun:test";

import { extractBundle } from "@atlas/api/lib/knowledge/bundle-archive";
import { parseLenientBundle } from "@atlas/api/lib/knowledge/parse-lenient";

import { buildFumadocsOkfBundle, DEFAULT_INGEST_CAPS } from "../src/index";
import { acmeSource, page, sourceOf } from "./fixture";

describe("bundle-sync round-trip (no packages/api changes)", () => {
  test("every built doc survives extract + lenient parse — zero silent drops", async () => {
    const built = await buildFumadocsOkfBundle(acmeSource(), {
      prefix: "acme",
      tags: ["acme-docs"],
    });

    const extracted = extractBundle(built.bytes, {
      maxDocBytes: DEFAULT_INGEST_CAPS.maxDocBytes,
      maxTotalBytes: DEFAULT_INGEST_CAPS.maxBundleBytes,
    });
    expect(extracted.format).toBe("tar.gz");
    expect(extracted.errors).toEqual([]);
    expect(extracted.files.length).toBe(built.stats.documents);

    const parsed = parseLenientBundle(extracted.files);
    expect(parsed.errors).toEqual([]);
    expect(parsed.skippedNonMarkdown).toBe(0);
    // The reconcile guardrail: built N === parsed N. Reserved basenames were
    // renamed at generation, so the parser's silent index.md/log.md skip can
    // never eat a document.
    expect(parsed.docs.length).toBe(built.stats.documents);
    expect(parsed.docs.map((d) => d.path).toSorted()).toEqual(
      built.docs.map((d) => d.path).toSorted(),
    );
  });

  test("frontmatter fidelity: title/description/tags/type land as authored", async () => {
    const built = await buildFumadocsOkfBundle(acmeSource(), {
      prefix: "acme",
      tags: ["acme-docs"],
    });
    const extracted = extractBundle(built.bytes, {
      maxDocBytes: DEFAULT_INGEST_CAPS.maxDocBytes,
      maxTotalBytes: DEFAULT_INGEST_CAPS.maxBundleBytes,
    });
    const parsed = parseLenientBundle(extracted.files);

    const quickstart = parsed.docs.find((d) => d.path === "acme/quickstart.md");
    expect(quickstart).toBeDefined();
    expect(quickstart?.type).toBe("Document");
    expect(quickstart?.title).toBe("Quickstart");
    expect(quickstart?.description).toBe("Zero to first query");
    expect(quickstart?.tags).toEqual(["acme-docs", "setup"]);
    expect(quickstart?.body.trim()).toBe(
      "## Install\n\nRun `acme init` and follow the prompts.",
    );

    // The folded section landing ingests as a real document.
    const guides = parsed.docs.find((d) => d.path === "acme/guides.md");
    expect(guides?.title).toBe("Guides");
    // The reserved-named page ingests under its -doc rename.
    expect(parsed.docs.some((d) => d.path === "acme/ops/log-doc.md")).toBe(true);
  });

  test("hostile frontmatter (quotes/colons/backslashes) survives the round-trip byte-faithfully", async () => {
    const built = await buildFumadocsOkfBundle(acmeSource(), { prefix: "acme" });
    const parsed = parseLenientBundle(
      extractBundle(built.bytes, {
        maxDocBytes: DEFAULT_INGEST_CAPS.maxDocBytes,
        maxTotalBytes: DEFAULT_INGEST_CAPS.maxBundleBytes,
      }).files,
    );
    const faq = parsed.docs.find((d) => d.path === "acme/faq.md");
    expect(faq).toBeDefined();
    expect(faq?.title).toBe('FAQ: "gotchas", edge: cases');
    expect(faq?.description).toBe('Answers to: "why?", "how?" — and C:\\paths too');
    expect(faq?.body.trim()).toBe('Q: does `"SELECT *"` count? A: yes\\no, it depends.');
  });

  test("a prefix-split (>100-byte) archive path round-trips intact through the real USTAR reader", async () => {
    const deepDir = `${"section-".repeat(8)}nested`; // 71 chars
    const longStem = `${"page-".repeat(10)}leaf`; // 54 chars → full path > 100
    const source = sourceOf([
      page(`${deepDir}/${longStem}.mdx`, "Deeply nested prose that must keep its path."),
    ]);
    const built = await buildFumadocsOkfBundle(source, { prefix: "acme" });
    const extracted = extractBundle(built.bytes, {
      maxDocBytes: DEFAULT_INGEST_CAPS.maxDocBytes,
      maxTotalBytes: DEFAULT_INGEST_CAPS.maxBundleBytes,
    });
    expect(extracted.errors).toEqual([]);
    expect(extracted.files.map((f) => f.path)).toEqual([`acme/${deepDir}/${longStem}.md`]);
  });

  // The reserved-basename and cap-default drift pins that used to live here
  // retired with #4373: both sides now import the same wire module
  // (`@atlas/okf-bundle/wire`), so equality holds by construction. The
  // behavioral pin that matters — built N == parsed N, zero silent drops —
  // is the first test above.
});
