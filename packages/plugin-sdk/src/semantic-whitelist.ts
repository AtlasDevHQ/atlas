/**
 * Semantic-layer whitelist load policy for datasource query tools.
 *
 * Every dialect query tool (ES Query DSL, SOQL, future datasource plugins)
 * gates member access on the semantic layer via `ctx.connections.tables(id)`.
 * That accessor has three outcomes, and the policy for each is a SECURITY
 * contract (#3243 / #3313) — stated here once instead of re-implemented (and
 * re-explained in comments) by every plugin:
 *
 * - **throws** — the semantic-layer scan FAILED: the whitelist load is
 *   incomplete. The query must be REFUSED (fail closed) rather than the error
 *   swallowed into an empty set, which would silently widen access to
 *   structural-only — the "false negative on a security check" anti-pattern.
 *   {@link gateOnSemanticWhitelist} returns the canonical refusal.
 * - **empty** — a legitimately-empty layer: STRUCTURAL-ONLY mode. The dialect
 *   validator's always-on rails still apply, but any explicitly named member
 *   the credential can read is queryable. Surfaced to the operator once at
 *   registration via {@link warnIfStructuralOnly}.
 * - **non-empty** — the membership whitelist the dialect validator checks
 *   names against.
 */

import type { PluginLogger } from "./types";

/**
 * The dialect's vocabulary for whitelist policy copy. Declared once per
 * plugin and shared by the query-time gate and the registration-time warning
 * so the two surfaces can't drift.
 */
export interface SemanticWhitelistSubject {
  /** Registered tool name, e.g. `"queryElasticsearch"`. */
  readonly toolName: string;
  /** Singular noun for one queryable member: `"index"`, `"object"`, `"table"`. */
  readonly member: string;
  /**
   * What structural-only mode exposes, e.g. `"any explicitly-named,
   * non-system index"`. Defaults to `any explicitly-named ${member}`.
   */
  readonly structuralExposure?: string;
  /** Plural query kind for log copy, e.g. `"DSL queries"`, `"SOQL queries"`. */
  readonly queryKind: string;
  /** Short label for query-time refusal logs, e.g. `"ES DSL"`, `"SOQL"`. */
  readonly logLabel: string;
}

/** Result of the query-time whitelist load. */
export type SemanticWhitelistGate =
  | {
      readonly ok: true;
      /** Member names to validate against. Empty = structural-only mode. */
      readonly allowed: Set<string>;
      /** True when the layer is legitimately empty (structural-only mode). */
      readonly structuralOnly: boolean;
    }
  | {
      readonly ok: false;
      /** Canonical agent-facing refusal — return it as the tool error. */
      readonly error: string;
    };

/**
 * Load the semantic whitelist at query time, owning the fail-closed policy.
 *
 * Call this at the top of a dialect tool's `execute`; on `ok: false` return
 * `{ success: false, error: gate.error }` without issuing any request. The
 * scan-failure path is logged here (`logger.error`) so callers don't repeat
 * the policy.
 */
export function gateOnSemanticWhitelist(
  subject: SemanticWhitelistSubject,
  read: () => Iterable<string>,
  logger?: PluginLogger,
  logContext?: Record<string, unknown>,
): SemanticWhitelistGate {
  let allowed: Set<string>;
  try {
    allowed = new Set(read());
  } catch (err) {
    logger?.error(
      { ...logContext, error: err instanceof Error ? err.message : String(err) },
      `${subject.logLabel} refused — semantic layer unavailable (scan failed)`,
    );
    return {
      ok: false,
      error: `The semantic layer is temporarily unavailable (its scan failed), so ${subject.member} access cannot be verified. Refusing the query to avoid unsafe access — retry once it recovers.`,
    };
  }
  return { ok: true, allowed, structuralOnly: allowed.size === 0 };
}

/**
 * One-time operator signal at tool registration (#3313).
 *
 * - Empty whitelist → warn that the tool runs in STRUCTURAL-ONLY mode, naming
 *   the consequence so operators know to add entity YAMLs.
 * - Whitelist read throws → warn that the scan failed and queries will fail
 *   closed (the query-time gate logs each refusal; this only flags the state
 *   at registration).
 * - Non-empty → silent.
 */
export function warnIfStructuralOnly(
  subject: SemanticWhitelistSubject,
  read: () => Iterable<string>,
  logger: PluginLogger,
): void {
  try {
    if (new Set(read()).size === 0) {
      const exposure = subject.structuralExposure ?? `any explicitly-named ${subject.member}`;
      logger.warn(
        `${subject.toolName} registered with an empty semantic-layer whitelist — running in STRUCTURAL-ONLY mode: ${exposure} the credential can read is queryable. Add entity YAMLs to enforce a per-${subject.member} allow-list.`,
      );
    }
  } catch (err) {
    logger.warn(
      `${subject.toolName}: semantic-layer scan failed at registration — ${subject.queryKind} will fail closed until it recovers (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}
