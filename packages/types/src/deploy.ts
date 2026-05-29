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
