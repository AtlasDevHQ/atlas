/**
 * Deploy-region identity — the fixed set of first-party Atlas deployment
 * instances.
 *
 * Each Atlas API instance is stamped with exactly one of these via the
 * `ATLAS_API_REGION` env var (read at runtime by `getApiRegion()` in
 * `@atlas/api/lib/residency/misrouting`, falling back to
 * `residency.defaultRegion` in atlas.config.ts). The three production SaaS
 * instances are `us` / `eu` / `apac`; `staging` is the single pre-prod soak
 * instance under `*.staging.useatlas.dev`.
 *
 * This is a CLOSED union of Atlas-operated deployments — distinct from two
 * neighbouring concepts:
 *
 * - `Region` (./residency) is an OPEN `string`: an operator-defined data-
 *   residency routing key for a *workspace*, not constrained to this set. A
 *   self-hosted operator can name regions anything. Its companion
 *   `WELL_KNOWN_REGIONS` suggests *finer-grained* admin-UI keys
 *   (`us-east`, `eu-west`, …) — independent of, and not to be confused
 *   with, the coarse first-party keys here: a `DeployRegion` of `"us"` is
 *   the `deploy/api/atlas.config.ts` residency key, not `"us-east"`.
 * - `DeployEnv` (`@atlas/api/lib/env-profile`, `"production" | "staging" |
 *   "development"`) is the deployment *shape* that drives non-secret runtime
 *   toggles (email verification, cookie prefix). The three prod regions all
 *   share the `production` env profile; `staging` overlaps only by name —
 *   it's a different axis (one specific instance vs. an env class).
 *
 * Type-only: the runtime read remains a raw `string` via `getApiRegion()`;
 * this union exists so deploy-region-aware code (e.g. the staging outbound
 * clamp) can name the cases exhaustively without re-spelling the literals.
 */
export type DeployRegion = "us" | "eu" | "apac" | "staging";

/**
 * The closed set of {@link DeployRegion} values, as a runtime tuple. Kept
 * adjacent to the type so the two cannot drift — enforced in BOTH directions:
 *  - `satisfies readonly DeployRegion[]` rejects an entry here that is not a
 *    `DeployRegion` (tuple ⊆ union — catches a typo'd tuple entry).
 *  - `_AssertDeployRegionsExhaustive` below rejects a region added to the
 *    `DeployRegion` union without a matching entry here (union ⊆ tuple — the
 *    direction `satisfies` alone does NOT catch).
 */
const DEPLOY_REGIONS = ["us", "eu", "apac", "staging"] as const satisfies readonly DeployRegion[];

/**
 * Compile-time exhaustiveness check. If a region is ever added to
 * {@link DeployRegion} without a matching {@link DEPLOY_REGIONS} entry, the
 * `Exclude` is non-`never`, this type collapses to `never`, and the assignment
 * below fails to type-check — so the runtime guard can never silently fail to
 * recognize a region the type system already knows about. (`satisfies` above
 * only guards the opposite direction.)
 */
type _AssertDeployRegionsExhaustive =
  [Exclude<DeployRegion, (typeof DEPLOY_REGIONS)[number]>] extends [never] ? true : never;
const _deployRegionsExhaustive: _AssertDeployRegionsExhaustive = true;

/**
 * Exact runtime narrowing guard for {@link DeployRegion}.
 *
 * The staging email-clamp wiring (`packages/api/src/lib/email/delivery.ts`,
 * #2913/#2985) reads the deploy region from `getApiRegion(): string | null`
 * and MUST narrow it through this guard rather than an unchecked
 * `as DeployRegion` cast. The guard is deliberately EXACT — no trim, no
 * lowercase, no prefix match: only the four literal first-party regions
 * return `true`.
 *
 * Exactness is the safety property. A "close" value — `null`, `"Staging"`,
 * `"staging "` with whitespace, a granular `"us-west"`, a typo — returns
 * `false`, and the wiring site treats a `false` result as "not a known
 * region" and fails CLOSED (clamps outbound mail / hard-fails boot) instead
 * of mistaking a mislabelled staging box for a prod region and emailing a
 * real recipient. Loosening this guard would silently re-open that leak.
 */
export function isDeployRegion(value: string | null): value is DeployRegion {
  return value !== null && (DEPLOY_REGIONS as readonly string[]).includes(value);
}
