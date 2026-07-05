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
import { acmeSource } from "./fixture";

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

  test("adapter default caps stay equal to the server ingest-limit defaults", async () => {
    // Import lazily: ingest-limits pulls the settings/logger modules, which is
    // fine to load but kept out of the shared top-level imports above.
    const limits = await import("@atlas/api/lib/knowledge/ingest-limits");
    expect(DEFAULT_INGEST_CAPS.maxDocs).toBe(limits.DEFAULT_INGEST_MAX_DOCS);
    expect(DEFAULT_INGEST_CAPS.maxDocBytes).toBe(limits.DEFAULT_INGEST_MAX_DOC_BYTES);
    expect(DEFAULT_INGEST_CAPS.maxBundleBytes).toBe(limits.DEFAULT_INGEST_MAX_BUNDLE_BYTES);
  });
});
