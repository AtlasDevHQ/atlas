/**
 * Plugin-marketplace plan-gated veneer (enterprise) — #4001 (WS5).
 *
 * Inverts the inline `getConfig()?.deployMode === "saas" && saas_eligible ===
 * false` checks that lived in `api/routes/admin-marketplace.ts`. The unified
 * install pipeline (ADR-0007) stays in core; only the SaaS-eligibility gate —
 * the plan-gated veneer — moves here behind the `MarketplaceVeneer`
 * Context.Tag. The no-op default in `lib/effect/services.ts`
 * (`NoopMarketplaceVeneerLayer`) makes every catalog row eligible, so
 * self-hosted lists and installs the full catalog unchanged.
 *
 * `isSaasIneligible` is the single decision both the `/available` listing
 * filter and the `POST /install` server-side gate consult. It returns `true`
 * only when the deploy is SaaS AND the row is explicitly `saas_eligible =
 * false` (e.g. DuckDB — file-path based, not multi-tenant safe, #3301). The
 * resolved (not raw-env) deploy mode is read on every call so a config-file
 * `deployMode: "saas"` that downgrades to self-hosted without `@atlas/ee`
 * still lists everything (the env `ATLAS_DEPLOY_MODE=saas` path hard-fails
 * boot instead). Because SaaS mode requires enterprise, this Live layer is the
 * only place `deployMode === "saas"` is ever true — so the gate is correctly
 * absent without EE. Mirrors the keyset gate in
 * `lib/integrations/install/github-pat-form-handler.ts`.
 *
 * This veneer presumes the catalog it filters is **operator-curated only** —
 * that invariant is enforced at the catalog write seam by
 * `@atlas/api/lib/plugins/catalog-provenance.ts` (#4174). Third-party plugin
 * authorship is gated on #4099 (plugin-execution isolation) and must not be
 * added here or anywhere else before that lands.
 */

import { Layer } from "effect";
import { getConfig } from "@atlas/api/lib/config";
import {
  MarketplaceVeneer,
  type MarketplaceVeneerShape,
  type CatalogEligibilityRow,
} from "@atlas/api/lib/effect/services";

export const makeMarketplaceVeneerLive = (): MarketplaceVeneerShape =>
  ({
    isSaasIneligible: (row: CatalogEligibilityRow): boolean =>
      getConfig()?.deployMode === "saas" && row.saas_eligible === false,
  }) satisfies MarketplaceVeneerShape;

export const MarketplaceVeneerLive: Layer.Layer<MarketplaceVeneer> = Layer.sync(
  MarketplaceVeneer,
  makeMarketplaceVeneerLive,
);
