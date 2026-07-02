/**
 * Knowledge-ingest caps — resolved from the settings registry, NOT env vars
 * (ADR-0028 §5 "caps via the settings registry"; CLAUDE.md SaaS-first
 * configuration rule). A platform operator tunes these from the Admin console
 * without a redeploy; the three keys are declared platform-scoped in
 * `lib/settings.ts` (`ATLAS_KNOWLEDGE_INGEST_*`, operator-only —
 * `saasVisible: false`), so `getSettingAuto` resolves platform-override → env →
 * registry default and hot-reloads in SaaS mode.
 *
 * The registry stores every value as a string; each reader coerces to a
 * positive integer and clamps a garbage / non-positive override back to the
 * default rather than failing an ingest on a fat-fingered setting — but a
 * present-but-unparseable override is logged (distinct from "unset") so the
 * misconfig is debuggable rather than silently swallowed. The setting keys are
 * string literals on the reader call lines so `scripts/check-settings-readers.sh`
 * (a `/ci` gate) sees a real runtime consumer.
 */

import { getSettingAuto } from "@atlas/api/lib/settings";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("knowledge.ingest-limits");

export const DEFAULT_INGEST_MAX_DOCS = 1000;
export const DEFAULT_INGEST_MAX_DOC_BYTES = 1_000_000; // 1 MB per document
export const DEFAULT_INGEST_MAX_BUNDLE_BYTES = 25_000_000; // 25 MB per upload

/**
 * Coerce a settings string to a positive int, falling back to `fallback`. An
 * UNSET key falls back silently (the common case); a SET-but-unparseable value
 * (`"25MB"`, `"-5"`, overflow) falls back WITH a warn so an operator can see why
 * their override didn't take — never a silent swallow.
 */
export function positiveIntSetting(key: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  log.warn(
    { key, raw, fallback },
    "Knowledge ingest cap override is non-positive or unparseable — using the default",
  );
  return fallback;
}

/** Max number of concept documents a single bundle may ingest. */
export function getIngestMaxDocs(): number {
  return positiveIntSetting(
    "ATLAS_KNOWLEDGE_INGEST_MAX_DOCS",
    getSettingAuto("ATLAS_KNOWLEDGE_INGEST_MAX_DOCS"),
    DEFAULT_INGEST_MAX_DOCS,
  );
}

/** Max decoded size of any single document in a bundle (bytes). */
export function getIngestMaxDocBytes(): number {
  return positiveIntSetting(
    "ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES",
    getSettingAuto("ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES"),
    DEFAULT_INGEST_MAX_DOC_BYTES,
  );
}

/**
 * Max raw upload size of the whole bundle (bytes). The route enforces it against
 * the raw request body (the first line of defense); it is ALSO passed as the
 * decoded-total cap that the streaming extractor uses to abort a decompression
 * bomb mid-inflate (the second).
 */
export function getIngestMaxBundleBytes(): number {
  return positiveIntSetting(
    "ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES",
    getSettingAuto("ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES"),
    DEFAULT_INGEST_MAX_BUNDLE_BYTES,
  );
}
