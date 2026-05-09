/**
 * Canonical-questions prompt source (#2076).
 *
 * Reads `eval/canonical-questions/questions.yml` (the source of truth for
 * the eval harness, #2025) and shapes each question as a `prompts/list`
 * entry with a stable `canonical-{slug}` name. The slug strategy depends
 * on the question's mode so the surface name carries enough context for
 * an agent's prompt picker without leaking the harness id (`cq-001`).
 *
 *   - mode=metric    → `canonical-{slugified metric_id}`
 *   - mode=pattern   → `canonical-{slugified entity}-{slugified pattern}`
 *   - mode=virtual   → `canonical-{slugified entity}-{slugified dimension}`
 *   - mode=glossary  → `canonical-glossary-{slugified term}`
 *   - fallback       → `canonical-{slugified id}`
 *
 * Every mode-specific shape falls back to `canonical-{slugified id}`
 * when the mode-specific fields are missing (e.g. a `mode: pattern`
 * row without an `entity`), so a malformed-but-tagged question still
 * gets a stable name rather than disappearing from the prompts surface.
 *
 * `evalMode` lets the description distinguish "deterministic" questions
 * (the harness asserts on dispatched SQL or a non-zero scalar) from "llm"
 * questions (glossary disambiguation, where the agent must ask). The
 * descriptive label is the only signal an agent's prompt picker has to
 * decide whether to surface a prompt — without it, the operator-facing
 * eval mode is invisible to consumers.
 *
 * Failures are logged to stderr (matching the rest of the @atlas/mcp
 * package's I/O convention) and result in `[]` so a malformed YAML
 * file degrades the prompts surface to "no canonical prompts" instead
 * of breaking `prompts/list` entirely.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

export const CANONICAL_PROMPT_PREFIX = "canonical-";

export type CanonicalEvalMode = "deterministic" | "llm";

/**
 * Closed union of source modes. The YAML at `eval/canonical-questions/`
 * uses the four named modes; anything else (a future / typo'd mode)
 * normalizes to `"other"` so the type stays closed without dropping
 * the row from the prompts surface.
 */
export const CANONICAL_SOURCE_MODES = [
  "metric",
  "pattern",
  "virtual",
  "glossary",
  "other",
] as const;
export type CanonicalSourceMode = (typeof CANONICAL_SOURCE_MODES)[number];

interface CanonicalPromptBase {
  readonly name: string;
  readonly description: string;
  readonly question: string;
  /** Source category (e.g. `simple_metric`, `join`, `glossary`). */
  readonly category: string | null;
}

/**
 * Stable shape consumed by the prompts registry. `question` is the
 * verbatim text the agent receives on `prompts/get`; `description` is
 * the human-facing summary shown in `prompts/list`.
 *
 * Discriminated by `sourceMode` so the invariant
 * `sourceMode === "glossary"` ↔ `evalMode === "llm"` is enforced at
 * the type level — previously the constructor enforced it but the
 * type system allowed nonsensical combinations (#2185).
 */
export type CanonicalPrompt =
  | (CanonicalPromptBase & {
      readonly sourceMode: "glossary";
      readonly evalMode: "llm";
    })
  | (CanonicalPromptBase & {
      readonly sourceMode: "metric" | "pattern" | "virtual" | "other";
      readonly evalMode: "deterministic";
    });

interface RawQuestion {
  id?: unknown;
  category?: unknown;
  question?: unknown;
  mode?: unknown;
  metric_id?: unknown;
  entity?: unknown;
  pattern?: unknown;
  dimension?: unknown;
  term?: unknown;
}

interface QuestionsRoot {
  questions?: unknown;
}

/**
 * Default location of `questions.yml`, resolved by walking up from this
 * file. Mirrors the strategy in `packages/cli/bin/canonical-eval.ts` —
 * keep the two in sync if the repo layout shifts.
 *
 *   <root>/packages/mcp/src/prompts/canonical.ts
 *     ../../../../  →  <root>
 */
const DEFAULT_QUESTIONS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "eval",
  "canonical-questions",
  "questions.yml",
);

/**
 * Resolve the canonical questions path. Honors the
 * `ATLAS_CANONICAL_QUESTIONS_PATH` env var so tests and self-hosted
 * deployments with a relocated `eval/` directory can override.
 */
export function getCanonicalQuestionsPath(): string {
  const override = process.env.ATLAS_CANONICAL_QUESTIONS_PATH;
  if (override !== undefined) {
    if (!override) {
      // Empty string is almost certainly an env-var template error —
      // refuse rather than silently falling back to the default and
      // masking the configuration mistake.
      throw new Error(
        "ATLAS_CANONICAL_QUESTIONS_PATH is set but empty — remove it to use the default, or provide a path",
      );
    }
    return path.resolve(override);
  }
  return DEFAULT_QUESTIONS_PATH;
}

export interface LoadCanonicalPromptsOptions {
  /** Override path; defaults to `getCanonicalQuestionsPath()`. */
  readonly path?: string;
}

export function loadCanonicalPrompts(
  opts?: LoadCanonicalPromptsOptions,
): CanonicalPrompt[] {
  const filePath = opts?.path ?? getCanonicalQuestionsPath();

  if (!fs.existsSync(filePath)) {
    process.stderr.write(
      `[atlas-mcp] canonical questions file not found at ${filePath} — skipping canonical prompts\n`,
    );
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] Failed to read canonical questions: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] Failed to parse canonical questions YAML: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    process.stderr.write(
      `[atlas-mcp] canonical questions YAML did not parse to an object at ${filePath} — skipping\n`,
    );
    return [];
  }
  const root = parsed as QuestionsRoot;
  if (!Array.isArray(root.questions)) {
    process.stderr.write(
      `[atlas-mcp] canonical questions YAML at ${filePath} has no top-level "questions:" array — skipping\n`,
    );
    return [];
  }

  const prompts: CanonicalPrompt[] = [];
  const seen = new Set<string>();

  for (const raw of root.questions) {
    const prompt = toCanonicalPrompt(raw as RawQuestion);
    if (!prompt) continue;
    // Defensive against duplicate slugs in source data — first one wins.
    if (seen.has(prompt.name)) continue;
    seen.add(prompt.name);
    prompts.push(prompt);
  }

  return prompts;
}

function toCanonicalPrompt(q: RawQuestion): CanonicalPrompt | null {
  if (typeof q.id !== "string" || !q.id) return null;
  if (typeof q.question !== "string" || !q.question) return null;
  if (typeof q.mode !== "string" || !q.mode) return null;

  // `q.id` is now narrowed to non-empty `string`, so `slugFor` is total —
  // every branch falls back to `slugify(q.id)` as a non-empty result.
  const slug = slugFor(q as RawQuestion & { id: string });
  const category =
    typeof q.category === "string" && q.category ? q.category : null;
  const sourceMode = normalizeSourceMode(q.mode);
  // The category-or-mode label keeps using the raw YAML mode when
  // category is missing — for unknown modes (which normalize to
  // "other") the raw value still surfaces in the description rather
  // than being collapsed to the literal "other".
  const labelMode = category ?? (sourceMode === "other" ? q.mode : sourceMode);
  const base: CanonicalPromptBase = {
    name: `${CANONICAL_PROMPT_PREFIX}${slug}`,
    description: "",
    question: q.question,
    category,
  };

  // Build the description+arm in lockstep so the discriminated union
  // doesn't have to be re-narrowed at the call site.
  if (sourceMode === "glossary") {
    return {
      ...base,
      description: `[canonical:${labelMode} · llm] ${q.question}`,
      sourceMode: "glossary",
      evalMode: "llm",
    };
  }
  return {
    ...base,
    description: `[canonical:${labelMode} · deterministic] ${q.question}`,
    sourceMode,
    evalMode: "deterministic",
  };
}

function normalizeSourceMode(raw: string): CanonicalSourceMode {
  return (CANONICAL_SOURCE_MODES as readonly string[]).includes(raw)
    ? (raw as CanonicalSourceMode)
    : "other";
}

function slugFor(q: RawQuestion & { id: string }): string {
  // Last-resort: `stringSlug(q.id)` returns null only for ids that
  // contain no `[a-z0-9]` after lowercasing — basically pathological
  // input ("---"). Fall back to the raw id in that case rather than
  // silently dropping the question; the row already passed the
  // non-empty `id` check at the call site.
  const idSlug = (): string => stringSlug(q.id) ?? q.id;
  switch (q.mode) {
    case "metric":
      return stringSlug(q.metric_id) ?? idSlug();
    case "pattern": {
      const entity = stringSlug(q.entity);
      const pattern = stringSlug(q.pattern);
      return entity && pattern ? `${entity}-${pattern}` : idSlug();
    }
    case "virtual": {
      const entity = stringSlug(q.entity);
      const dimension = stringSlug(q.dimension);
      return entity && dimension ? `${entity}-${dimension}` : idSlug();
    }
    case "glossary": {
      const term = stringSlug(q.term);
      return term ? `glossary-${term}` : idSlug();
    }
    default:
      return idSlug();
  }
}

function stringSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}
