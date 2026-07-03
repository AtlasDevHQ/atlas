import type { Audience } from "@/lib/audience";
import { AUDIENCE_CLASSES, type AudienceClass } from "@/lib/audience-classes";

// Re-export the SSOT so existing importers keep resolving these from here.
export { AUDIENCE_CLASSES, type AudienceClass };

/**
 * The declarative audience taxonomy for the segmented docs portal (PRD #4257).
 *
 * Every content file resolves to exactly ONE audience class. Classification is
 * driven by a directory manifest (`CONTENT_ROOTS`) rather than per-file
 * frontmatter, because the SaaS tree (`content/docs/**`) is hundreds of files
 * plus a fully generated `api-reference/` tree — requiring an `audience:` line
 * on each of those does not fit the collection shape. The directory is the
 * SSOT; an OPTIONAL `audience:` frontmatter field lets an author state a page's
 * class explicitly, and is machine-checked to AGREE with the directory (a
 * contradiction is a hard "ambiguous" build error — the teeth that catch a
 * mis-filed page).
 *
 * This module imports NO generated `.source/server` and no React runtime, so it
 * is fully unit-testable with synthetic entries (see
 * `__tests__/audience-taxonomy.test.ts`). The build-time gate lives in
 * `src/lib/source.ts`, which feeds the real pages through
 * `validateContentTaxonomy` and throws — failing `next build` — on any orphan,
 * invalid, or ambiguous classification, or un-marked cross-audience duplicate.
 */

export function isAudienceClass(value: unknown): value is AudienceClass {
  return (
    typeof value === "string" &&
    (AUDIENCE_CLASSES as readonly string[]).includes(value)
  );
}

interface ContentRoot {
  readonly prefix: string;
  readonly class: AudienceClass;
}

/**
 * The taxonomy manifest: each content-root directory maps to exactly one
 * audience class. The three roots are disjoint, so a file matches at most one.
 * A file under none of them is an ORPHAN (a hard build error).
 */
export const CONTENT_ROOTS: readonly ContentRoot[] = [
  { prefix: "content/self-hosted/", class: "self-hosted-only" },
  { prefix: "content/shared/", class: "shared" },
  { prefix: "content/docs/", class: "saas-only" },
];

/**
 * Which human section(s) a class is mounted into. `shared` is the single-source
 * case — one file on disk, mounted into BOTH human trees (full presence, single
 * source). This is the machine-readable form of the shared-presence guarantee.
 */
export const AUDIENCE_MOUNTS = {
  "saas-only": ["saas"],
  "self-hosted-only": ["self-hosted"],
  shared: ["saas", "self-hosted"],
} as const satisfies Record<AudienceClass, readonly Audience[]>;

export function audienceMounts(cls: AudienceClass): readonly Audience[] {
  return AUDIENCE_MOUNTS[cls];
}

/**
 * Match a file path against the manifest. Robust to both repo-relative paths
 * (`content/docs/x.mdx`) and absolute filesystem paths that merely CONTAIN a
 * known root (`/…/apps/docs/content/docs/x.mdx`) — same defensive approach as
 * `githubEditPath`.
 */
function matchRoot(
  absolutePath: string,
): { readonly root: ContentRoot; readonly rel: string } | null {
  for (const root of CONTENT_ROOTS) {
    const idx = absolutePath.indexOf(root.prefix);
    if (idx >= 0) {
      return { root, rel: absolutePath.slice(idx + root.prefix.length) };
    }
  }
  return null;
}

/** The audience class implied by a file's content-root directory, or null. */
export function classifyByPath(absolutePath: string): AudienceClass | null {
  return matchRoot(absolutePath)?.root.class ?? null;
}

export interface ContentEntry {
  /** Real source file path, e.g. `content/docs/guides/slack.mdx`. */
  readonly absolutePath: string;
  /** Optional explicit `audience:` frontmatter declaration. */
  readonly audience?: string | null;
  /** Optional `fork:` frontmatter marker (a stable divergence key). */
  readonly fork?: string | null;
}

export type Classification =
  | { readonly ok: true; readonly class: AudienceClass }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve a single content file to its audience class, or an error string.
 *
 * Fails (build error) when the file is:
 *  - an ORPHAN — under no known content root (missing classification), or
 *  - INVALID — declares an `audience:` value outside `AUDIENCE_CLASSES`, or
 *  - AMBIGUOUS — declares an `audience:` that contradicts its directory.
 */
export function resolveClassification(entry: ContentEntry): Classification {
  if (entry.absolutePath === "") {
    // Fail closed: a page with no source path can't be classified. Distinct
    // message from a genuine orphan so the cause (a missing `absolutePath`, not a
    // mis-filed page) is obvious.
    return {
      ok: false,
      error: `unclassifiable page: empty absolutePath — fumadocs should always populate this, so a blank one is a build-time anomaly`,
    };
  }
  const dirClass = classifyByPath(entry.absolutePath);
  if (dirClass === null) {
    return {
      ok: false,
      error: `orphan page "${entry.absolutePath}" is not under any known content root (${CONTENT_ROOTS.map(
        (r) => r.prefix,
      ).join(", ")}) — every page must live in exactly one audience tree`,
    };
  }

  const declared = entry.audience;
  if (declared != null && declared !== "") {
    if (!isAudienceClass(declared)) {
      return {
        ok: false,
        error: `invalid audience "${declared}" in "${entry.absolutePath}" — expected one of ${AUDIENCE_CLASSES.join(
          ", ",
        )}`,
      };
    }
    if (declared !== dirClass) {
      return {
        ok: false,
        error: `ambiguous audience for "${entry.absolutePath}": frontmatter declares "${declared}" but its directory implies "${dirClass}" — move the file or fix the frontmatter`,
      };
    }
  }

  return { ok: true, class: dirClass };
}

/** Throw an aggregated build error if any entry fails to classify cleanly. */
export function assertClassified(entries: readonly ContentEntry[]): void {
  const errors: string[] = [];
  for (const entry of entries) {
    const result = resolveClassification(entry);
    if (!result.ok) errors.push(result.error);
  }
  if (errors.length > 0) {
    throw new Error(
      `[docs] audience taxonomy check failed (${errors.length} page(s)):\n  - ${errors.join(
        "\n  - ",
      )}`,
    );
  }
}

/**
 * A file's "topic" — its slug relative to its content root, without extension
 * or a trailing `/index`. Two files with the SAME topic in different audience
 * trees cover the same logical page. Returns "" for a section landing page
 * (each section legitimately owns its own landing page — never a fork).
 */
function topicKey(absolutePath: string): string | null {
  const matched = matchRoot(absolutePath);
  if (!matched) return null;
  return matched.rel
    .replace(/\.mdx?$/i, "")
    .replace(/(^|\/)index$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

export interface ForkViolation {
  readonly topic: string;
  readonly kind: "unmarked" | "mismatched";
  readonly files: readonly string[];
  readonly message: string;
}

/**
 * Detect cross-audience duplicate pages that are NOT declared intentional forks.
 *
 * A "duplicate" is the SAME topic authored as two distinct files across the
 * saas-only and self-hosted-only trees. `shared/` pages are single-sourced (one
 * file, two mounts) and can never be duplicates, so they are excluded. Section
 * landing pages (topic "") are excluded — each section owns its own.
 *
 * The fork-marker convention: to KEEP a topic as two deliberately divergent
 * files (rather than single-sourcing it into `content/shared/`), mark BOTH
 * files with the same `fork:` key. An un-marked duplicate is flagged (someone
 * forgot to single-source, or forgot to declare the fork); a duplicate whose
 * two members carry DIFFERENT keys is flagged as mismatched.
 */
export function detectForkViolations(
  entries: readonly ContentEntry[],
): ForkViolation[] {
  const byTopic = new Map<
    string,
    { path: string; cls: AudienceClass; fork: string }[]
  >();

  for (const entry of entries) {
    const cls = classifyByPath(entry.absolutePath);
    if (cls !== "saas-only" && cls !== "self-hosted-only") continue;
    const topic = topicKey(entry.absolutePath);
    if (!topic) continue; // orphan or section landing page
    const bucket = byTopic.get(topic) ?? [];
    bucket.push({ path: entry.absolutePath, cls, fork: (entry.fork ?? "").trim() });
    byTopic.set(topic, bucket);
  }

  const violations: ForkViolation[] = [];
  for (const [topic, files] of byTopic) {
    // Only a cross-audience pair is a fork candidate; a same-tree slug
    // collision is a different (routing) problem, not a fork.
    if (new Set(files.map((f) => f.cls)).size < 2) continue;

    const paths = files.map((f) => f.path).toSorted();
    const markers = files.map((f) => f.fork);
    if (markers.some((m) => m === "")) {
      violations.push({
        topic,
        kind: "unmarked",
        files: paths,
        message: `topic "${topic}" is duplicated across audiences without a fork marker — single-source it into content/shared/, or mark BOTH files with a matching \`fork:\` key: ${paths.join(
          ", ",
        )}`,
      });
      continue;
    }
    if (new Set(markers).size !== 1) {
      violations.push({
        topic,
        kind: "mismatched",
        files: paths,
        message: `topic "${topic}" fork markers disagree (${[
          ...new Set(markers),
        ].join(
          " vs ",
        )}) — both members of an intentional fork must share the SAME \`fork:\` key: ${paths.join(
          ", ",
        )}`,
      });
    }
  }
  return violations;
}

/** Throw an aggregated build error on any un-marked / mismatched fork pair. */
export function assertNoUnmarkedForks(entries: readonly ContentEntry[]): void {
  const violations = detectForkViolations(entries);
  if (violations.length > 0) {
    throw new Error(
      `[docs] fork-marker check failed (${violations.length} topic(s)):\n  - ${violations
        .map((v) => v.message)
        .join("\n  - ")}`,
    );
  }
}

/**
 * The single build-time gate. Feed it every real page (from both section
 * sources); it dedupes by source file (a `shared` page appears once per mount)
 * and throws on any failure — an orphan/invalid/ambiguous classification, or an
 * un-marked cross-audience duplicate. Called from `src/lib/source.ts`, so a
 * violation fails `next build`.
 */
export function validateContentTaxonomy(entries: readonly ContentEntry[]): void {
  const unique = new Map<string, ContentEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.absolutePath)) unique.set(entry.absolutePath, entry);
  }
  const deduped = [...unique.values()];
  assertClassified(deduped);
  assertNoUnmarkedForks(deduped);
}
