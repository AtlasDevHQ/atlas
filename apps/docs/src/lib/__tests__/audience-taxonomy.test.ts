import { test, expect } from "bun:test";
import {
  AUDIENCE_CLASSES,
  CONTENT_ROOTS,
  classifyByPath,
  resolveClassification,
  assertClassified,
  audienceMounts,
  detectForkViolations,
  assertNoUnmarkedForks,
  validateContentTaxonomy,
  type ContentEntry,
} from "@/lib/audience-taxonomy";

/**
 * Audience-taxonomy unit tests (PRD #4257, slice #4260). Pure logic — no
 * generated `.source/server`, no network/filesystem — mirroring
 * `source-partition.test.ts`. Proves:
 *  - every content file classifies to exactly one audience, and a missing /
 *    invalid / ambiguous classification is a HARD error (build-failing);
 *  - `shared` mounts into BOTH human trees (shared-presence);
 *  - the fork-marker convention: a marked pair is recognized, an un-marked
 *    duplicate is flagged.
 */

// ── classification ──────────────────────────────────────────────────────────

test("directory manifest classifies each content root to exactly one audience", () => {
  expect(classifyByPath("content/docs/index.mdx")).toBe("saas-only");
  expect(classifyByPath("content/docs/api-reference/chat/postChat.mdx")).toBe(
    "saas-only",
  );
  expect(classifyByPath("content/self-hosted/docker.mdx")).toBe(
    "self-hosted-only",
  );
  expect(classifyByPath("content/shared/single-source-example.mdx")).toBe(
    "shared",
  );
});

test("classification is robust to absolute filesystem paths", () => {
  expect(
    classifyByPath("/home/x/apps/docs/content/docs/guides/slack.mdx"),
  ).toBe("saas-only");
});

test("an orphan file (under no known root) fails to classify — hard error", () => {
  const orphan: ContentEntry = { absolutePath: "content/misc/stray.mdx" };
  expect(classifyByPath(orphan.absolutePath)).toBeNull();
  const result = resolveClassification(orphan);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("orphan");
  expect(() => assertClassified([orphan])).toThrow(/taxonomy check failed/);
});

test("build FAILS on a missing classification within a batch of valid pages", () => {
  const entries: ContentEntry[] = [
    { absolutePath: "content/docs/index.mdx" },
    { absolutePath: "content/self-hosted/index.mdx" },
    { absolutePath: "content/nowhere/oops.mdx" }, // orphan
  ];
  expect(() => assertClassified(entries)).toThrow(/oops\.mdx/);
});

test("an explicit `audience:` that AGREES with the directory is accepted", () => {
  const result = resolveClassification({
    absolutePath: "content/shared/x.mdx",
    audience: "shared",
  });
  expect(result).toEqual({ ok: true, class: "shared" });
});

test("build FAILS on an ambiguous classification (frontmatter contradicts directory)", () => {
  const entry: ContentEntry = {
    absolutePath: "content/docs/x.mdx",
    audience: "shared", // lives in the saas tree — contradiction
  };
  const result = resolveClassification(entry);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("ambiguous");
  expect(() => assertClassified([entry])).toThrow(/ambiguous/);
});

test("build FAILS on an invalid `audience:` value", () => {
  const entry: ContentEntry = {
    absolutePath: "content/docs/x.mdx",
    audience: "everyone",
  };
  const result = resolveClassification(entry);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("invalid audience");
});

test("an empty absolutePath is a hard error, distinct from an orphan", () => {
  const result = resolveClassification({ absolutePath: "" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("empty absolutePath");
    expect(result.error).not.toContain("orphan");
  }
});

test("CONTENT_ROOTS covers every audience class (no class can be undirectoried)", () => {
  // A future AudienceClass added without a matching content root would silently
  // orphan every such page; assert the manifest stays exhaustive.
  const covered = new Set(CONTENT_ROOTS.map((r) => r.class));
  for (const cls of AUDIENCE_CLASSES) {
    expect(covered.has(cls)).toBe(true);
  }
});

// ── shared-presence ─────────────────────────────────────────────────────────

test("a `shared` page mounts into BOTH human trees; single-audience pages into one", () => {
  expect(audienceMounts("shared")).toEqual(["saas", "self-hosted"]);
  expect(audienceMounts("saas-only")).toEqual(["saas"]);
  expect(audienceMounts("self-hosted-only")).toEqual(["self-hosted"]);
});

// ── fork-marker convention ──────────────────────────────────────────────────

test("an un-marked cross-audience duplicate is flagged", () => {
  const entries: ContentEntry[] = [
    { absolutePath: "content/docs/deployment.mdx" },
    { absolutePath: "content/self-hosted/deployment.mdx" },
  ];
  const violations = detectForkViolations(entries);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.kind).toBe("unmarked");
  expect(violations[0]?.topic).toBe("deployment");
  expect(() => assertNoUnmarkedForks(entries)).toThrow(/fork-marker check failed/);
});

test("a fork pair marked with the SAME key is recognized (no violation)", () => {
  const entries: ContentEntry[] = [
    { absolutePath: "content/docs/deployment.mdx", fork: "deployment" },
    { absolutePath: "content/self-hosted/deployment.mdx", fork: "deployment" },
  ];
  expect(detectForkViolations(entries)).toHaveLength(0);
  expect(() => assertNoUnmarkedForks(entries)).not.toThrow();
});

test("a fork pair with DIFFERENT keys is flagged as mismatched", () => {
  const entries: ContentEntry[] = [
    { absolutePath: "content/docs/deployment.mdx", fork: "deploy-saas" },
    { absolutePath: "content/self-hosted/deployment.mdx", fork: "deploy-oss" },
  ];
  const violations = detectForkViolations(entries);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.kind).toBe("mismatched");
});

test("a half-marked duplicate (only one side declares fork) is flagged", () => {
  const entries: ContentEntry[] = [
    { absolutePath: "content/docs/deployment.mdx", fork: "deployment" },
    { absolutePath: "content/self-hosted/deployment.mdx" }, // no marker
  ];
  expect(detectForkViolations(entries)[0]?.kind).toBe("unmarked");
});

test("section landing pages (index) are NOT treated as a fork duplicate", () => {
  const entries: ContentEntry[] = [
    { absolutePath: "content/docs/index.mdx" },
    { absolutePath: "content/self-hosted/index.mdx" },
  ];
  expect(detectForkViolations(entries)).toHaveLength(0);
});

test("a shared page is never a fork duplicate even if a same-slug tree page exists", () => {
  const entries: ContentEntry[] = [
    { absolutePath: "content/shared/overview.mdx" },
    { absolutePath: "content/docs/overview.mdx" },
  ];
  // Only saas-only vs self-hosted-only pairs are fork candidates; shared is
  // single-sourced, so this same-slug pair is not a cross-audience duplicate.
  expect(detectForkViolations(entries)).toHaveLength(0);
});

// ── end-to-end gate ─────────────────────────────────────────────────────────

test("validateContentTaxonomy passes a well-formed corpus and dedupes shared mounts", () => {
  const entries: ContentEntry[] = [
    { absolutePath: "content/docs/index.mdx" },
    { absolutePath: "content/self-hosted/index.mdx" },
    // shared page appears once per mount — same absolutePath, deduped:
    { absolutePath: "content/shared/example.mdx" },
    { absolutePath: "content/shared/example.mdx" },
  ];
  expect(() => validateContentTaxonomy(entries)).not.toThrow();
});

test("validateContentTaxonomy throws on either failure class", () => {
  expect(() =>
    validateContentTaxonomy([{ absolutePath: "content/nowhere/x.mdx" }]),
  ).toThrow(/taxonomy check failed/);
  expect(() =>
    validateContentTaxonomy([
      { absolutePath: "content/docs/deployment.mdx" },
      { absolutePath: "content/self-hosted/deployment.mdx" },
    ]),
  ).toThrow(/fork-marker check failed/);
});

// ── SSOT contract ────────────────────────────────────────────────────────────

test("AUDIENCE_CLASSES pins the three-class contract (single-sourced from audience-classes.ts)", () => {
  // `source.config.ts` imports this SAME tuple for its `z.enum(...)`, so there is
  // no second literal to drift; this pins the public members of the contract.
  expect([...AUDIENCE_CLASSES]).toEqual([
    "saas-only",
    "self-hosted-only",
    "shared",
  ]);
});
