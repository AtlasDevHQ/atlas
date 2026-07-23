/**
 * Knowledge-ingest caps — TWO tiers that compose, never replace each other.
 *
 * **Platform ceiling.** The `ATLAS_KNOWLEDGE_INGEST_*` settings-registry keys,
 * NOT env vars (ADR-0028 §5 "caps via the settings registry"; CLAUDE.md
 * SaaS-first configuration rule). A platform operator tunes these from the Admin
 * console without a redeploy; the three keys are declared platform-scoped in
 * `lib/settings.ts` (operator-only — `saasVisible: false`), so `getSettingAuto`
 * resolves platform-override → env → default and hot-reloads in SaaS mode. This
 * is the fleet-wide abuse guardrail, and on self-hosted it is the ONLY cap.
 *
 * **Plan tier.** `PlanLimits.maxKnowledgeBundleBytes` / `maxKnowledgeDocsPerBundle`
 * (#4235) — the SaaS pricing lever. The effective cap an ingest enforces is
 * `min(platform ceiling, tier limit)`, composed by `resolveIngestCaps` in
 * `lib/billing/knowledge-limits.ts`. That composition deliberately lives on the
 * BILLING side of the seam: this module is imported by the knowledge mirror and
 * by the connector clients that bound their own fetch, and pulling the billing
 * stack (enforcement → metering → seat-count) in here would widen those
 * modules' dependency graph — and break the partial `mock.module` shims their
 * tests rely on — for a concern none of them have.
 *
 * The per-document byte cap has no tier field: it is an abuse guardrail on a
 * single row, not a pricing lever, so {@link getIngestMaxDocBytes} stays
 * platform-only.
 *
 * **Deploy-mode-aware defaults.** For the Business tier's values to be
 * *reachable* on SaaS, the platform ceiling must sit at or above them — a 25 MB
 * ceiling would silently clamp a 100 MB Business entitlement. So the two
 * tier-composed keys carry NO static `default` in the registry (a static default
 * shadows a downstream default in `getSetting`'s precedence — the same pattern
 * `ATLAS_RATE_LIMIT_RPM` uses), and their fallback is applied here:
 * {@link SAAS_CEILING} on SaaS, the shipped `DEFAULT_INGEST_*` constants
 * everywhere else. Self-hosted behavior is therefore unchanged, and a SaaS
 * operator can still tighten or widen the fleet with a single override.
 *
 * The registry stores every value as a string; each reader coerces to a
 * positive integer and clamps a garbage / non-positive override back to the
 * default rather than failing an ingest on a fat-fingered setting — but a
 * present-but-unparseable override is logged (distinct from "unset") so the
 * misconfig is debuggable rather than silently swallowed. The setting keys are
 * string literals on the reader call lines so `scripts/check-settings-readers.sh`
 * (a `/ci` gate) sees a real runtime consumer.
 */

import {
  DEFAULT_INGEST_MAX_BUNDLE_BYTES,
  DEFAULT_INGEST_MAX_DOC_BYTES,
  DEFAULT_INGEST_MAX_DOCS,
} from "@atlas/okf-bundle/wire";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { resolveDeployMode } from "@atlas/api/lib/effect/deploy-mode";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("knowledge.ingest-limits");

// The default constants single-homed into the wire module (#4373) — bundle
// builders validate against the SAME values at generation time. Re-exported
// so this module remains the api-side home of the ingest-cap surface.
export { DEFAULT_INGEST_MAX_DOCS, DEFAULT_INGEST_MAX_DOC_BYTES, DEFAULT_INGEST_MAX_BUNDLE_BYTES };

/**
 * The SaaS platform ceilings — deliberately equal to the **Business** tier's
 * `PlanLimits` values (#4235), so the top plan is reachable and every lower
 * plan is bound by its own tier limit rather than by a fleet-wide clamp. Raise
 * these (or set a platform override) only alongside a matching `plans.ts` move;
 * a ceiling BELOW a tier limit silently downgrades what that tier was sold.
 */
const SAAS_CEILING = {
  maxDocs: 5_000,
  maxBundleBytes: 100_000_000,
} as const;

/**
 * Coerce a settings string to a positive int, falling back to `fallback`. An
 * UNSET key falls back silently (the common case); a SET-but-unparseable value
 * (`"25MB"`, `"-5"`, overflow) falls back WITH a warn so an operator can see why
 * their override didn't take — never a silent swallow.
 */
export function positiveIntSetting(key: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  // `Number.parseInt("25MB")` is 25 — it reads the leading digits and drops the
  // rest, silently turning a unit-suffixed or separator-laden value ("25MB",
  // "25_000_000") into a tiny cap that then fails every ingest with no clue why.
  // Require the whole trimmed string to be digits so those take the warn+fallback
  // path the docblock promises; `Number.isSafeInteger` additionally rejects an
  // all-digit overflow (`"9".repeat(20)` → 1e20).
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  // Shared by the ingest caps AND the ToC cap (mirror.ts) — keep the wording
  // setting-agnostic; the `key` field says which one.
  log.warn(
    { key, raw, fallback },
    "Knowledge numeric setting override is non-positive or unparseable — using the default",
  );
  return fallback;
}

/**
 * Max number of concept documents a single bundle may ingest — the PLATFORM
 * ceiling. Prefer `resolveIngestCaps` (billing/knowledge-limits.ts), which
 * composes this with the workspace's tier limit; this raw reader is for callers
 * with no workspace in hand (e.g. a connector client's fetch bound).
 */
export function getIngestMaxDocs(): number {
  return positiveIntSetting(
    "ATLAS_KNOWLEDGE_INGEST_MAX_DOCS",
    getSettingAuto("ATLAS_KNOWLEDGE_INGEST_MAX_DOCS"),
    resolveDeployMode() === "saas" ? SAAS_CEILING.maxDocs : DEFAULT_INGEST_MAX_DOCS,
  );
}

/**
 * Max decoded size of any single document in a bundle (bytes). Platform-only by
 * design — an abuse guardrail on one row, not a pricing lever (#4235).
 */
export function getIngestMaxDocBytes(): number {
  return positiveIntSetting(
    "ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES",
    getSettingAuto("ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES"),
    DEFAULT_INGEST_MAX_DOC_BYTES,
  );
}

/**
 * Max raw upload size of the whole bundle (bytes) — the PLATFORM ceiling. The
 * route enforces the *effective* cap against the raw request body (the first
 * line of defense); it is ALSO passed as the decoded-total cap that the
 * streaming extractor uses to abort a decompression bomb mid-inflate (the
 * second). Prefer `resolveIngestCaps` (billing/knowledge-limits.ts) where a
 * workspace is known.
 */
export function getIngestMaxBundleBytes(): number {
  return positiveIntSetting(
    "ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES",
    getSettingAuto("ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES"),
    resolveDeployMode() === "saas" ? SAAS_CEILING.maxBundleBytes : DEFAULT_INGEST_MAX_BUNDLE_BYTES,
  );
}
