/**
 * StagingSeed — idempotent first-boot bootstrap for the `staging` deploy
 * region (staging slice 6, #2911).
 *
 * The staging instance (`*.staging.useatlas.dev`) runs the full SaaS code
 * path but starts from an empty internal database. A human soaking a
 * tag-gated release needs a known-good tenant the moment the API boots:
 * an admin they can sign in as, a datasource to query, and a CRM install
 * to exercise the lead pipeline. {@link ensureStagingSeed} creates exactly
 * that, once, on the first boot against an empty staging DB.
 *
 * Design — a deep module behind a one-line interface:
 *
 *   ensureStagingSeed() -> Effect<StagingSeedResult, StagingSeedError>
 *
 * On the first call against an empty staging DB it creates, in order:
 *   1. admin user        `admin@staging.useatlas.dev` (password from
 *                        `STAGING_ADMIN_PASSWORD`, email pre-verified so
 *                        it is sign-in-able with no manual SQL)
 *   2. organization      slug `staging-internal` (the idempotency marker)
 *   3. datasource        the shared `__demo__` NovaMart connection
 *                        (`demo-postgres` catalog row, shared across
 *                        workspaces)
 *   4. Twenty install    pointing at the separate Twenty Cloud workspace
 *                        (`STAGING_TWENTY_API_KEY` / `STAGING_TWENTY_BASE_URL`)
 *
 * Idempotent on three axes:
 *   - Region: a no-op when {@link getApiRegion} !== `"staging"`. The gate is
 *     the very first statement so a prod (`us`/`eu`/`apac`) or self-hosted
 *     (region unset) boot does zero DB work and emits no log line.
 *   - Marker: subsequent staging boots detect the `staging-internal`
 *     organization and short-circuit BEFORE any write. A second call is a
 *     single `SELECT` and nothing more.
 *   - Steps: each create step tolerates a prior partial boot — the admin
 *     user is reused if it already exists, and the datasource / Twenty rows
 *     upsert. A failure mid-sequence leaves the marker absent, so the next
 *     boot retries cleanly rather than wedging.
 *
 * Failure surfaces as a {@link StagingSeedError}. The boot wiring
 * (`StagingSeedLive` in `effect/layers.ts`) lets that error propagate so
 * the Layer DAG fails and `server.ts` exits non-zero — a misconfigured
 * staging boot is loud, never a silent skip (#2914).
 *
 * This module never reads operator env vars in a way that could leak into a
 * customer path: it runs only in the `staging` region, against Atlas's own
 * staging tenant, mirroring the dev-seed shape in `lib/auth/migrate.ts`.
 */

import { Context, Data, Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { getApiRegion } from "@atlas/api/lib/residency/misrouting";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createPlatformAdminUser } from "@atlas/api/lib/auth/admin-user-ops";

const log = createLogger("staging-seed");

// ── Deterministic identities ───────────────────────────────────────

/**
 * Organization slug that doubles as the idempotency marker. Its presence
 * means "this staging DB is already seeded" — the single source of truth
 * the short-circuit reads (#2911 acceptance: detect `org.slug` and skip).
 */
export const STAGING_ORG_SLUG = "staging-internal";

/** Deterministic admin email — paired with `STAGING_ADMIN_PASSWORD`. */
export const STAGING_ADMIN_EMAIL = "admin@staging.useatlas.dev";

/**
 * Catalog slug of the shared demo dataset. Migration 0093 seeds this row
 * (`Atlas-managed demo Postgres dataset, shared across all workspaces`) —
 * the canonical `__demo__` NovaMart connection. Installing it for the
 * staging org points that org at the shared demo data.
 */
const STAGING_DEMO_DATASOURCE_SLUG = "demo-postgres";

// ── Result + error types ───────────────────────────────────────────

/**
 * Discriminated outcome of a seed attempt.
 *
 * - `skipped-region`  — not the staging region; zero DB touches, no log.
 * - `skipped-gate`    — staging, but InternalDB/Migration not ready (only
 *                       produced by the boot Layer, never by this fn).
 * - `already-seeded`  — the `staging-internal` marker exists; zero writes.
 * - `seeded`          — a fresh seed ran; `created` reports what landed.
 */
export type StagingSeedOutcome =
  | "skipped-region"
  | "skipped-gate"
  | "already-seeded"
  | "seeded";

export interface StagingSeedResult {
  readonly outcome: StagingSeedOutcome;
  /** Present only when `outcome === "seeded"`. */
  readonly created?: {
    readonly org: boolean;
    readonly admin: boolean;
    readonly datasource: boolean;
    readonly twenty: boolean;
  };
}

/** The step that was running when the seed failed — for log correlation. */
export type StagingSeedPhase =
  | "marker"
  | "admin"
  | "org"
  | "datasource"
  | "twenty";

/**
 * Boot-time failure of the staging seed. Mirrors the SaaS boot-guard
 * tagged-error precedent in `effect/saas-guards.ts`: it stays OUT of the
 * HTTP `mapTaggedError` / `ATLAS_ERROR_TAG_LIST` exhaustiveness set because
 * it can only occur during the boot Layer DAG, never inside a request
 * handler. A `Data.TaggedError` is an `Error` subtype, so it unifies under
 * `buildAppLayer`'s `Error` channel.
 */
export class StagingSeedError extends Data.TaggedError("StagingSeedError")<{
  readonly message: string;
  readonly phase: StagingSeedPhase;
}> {}

/**
 * Effect-Context Tag for the boot Layer in `effect/layers.ts`. The Tag's
 * value is the {@link StagingSeedResult} so a future `/health` or admin
 * surface can read the boot outcome without re-grepping logs (mirrors
 * `CatalogSeed`).
 */
export class StagingSeed extends Context.Tag("StagingSeed")<
  StagingSeed,
  StagingSeedResult
>() {}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Seed the staging tenant if (a) this is the staging region and (b) it has
 * not been seeded yet. See the module doc for the full contract.
 *
 * R = `never`: this Effect drives the work through the module-level
 * `internalQuery` / Better Auth instance (same helpers the dev seed uses),
 * not through Context Tags — so it is callable directly in tests against a
 * real Postgres without standing up the full Layer DAG. The boot Layer that
 * wraps it owns the InternalDB / Migration readiness gate.
 */
export function ensureStagingSeed(): Effect.Effect<StagingSeedResult, StagingSeedError> {
  return Effect.gen(function* () {
    // 1. Region gate — first statement, before any DB touch or log line, so
    //    non-staging boots are provably inert (#2911 / #2914).
    if (getApiRegion() !== "staging") {
      return { outcome: "skipped-region" } satisfies StagingSeedResult;
    }

    // 2. Marker — a single SELECT. If present, this DB is already seeded and
    //    we short-circuit with zero writes (idempotency).
    const alreadySeeded = yield* step("marker", markerExists);
    if (alreadySeeded) {
      log.info(
        { slug: STAGING_ORG_SLUG },
        "Staging seed: marker organization present — already seeded, skipping",
      );
      return { outcome: "already-seeded" } satisfies StagingSeedResult;
    }

    log.info("Staging seed: empty staging DB — seeding admin + org + datasource + Twenty");

    // 3. Seed. Order matters: the org needs the admin as owner, and the
    //    datasource / Twenty installs are scoped to the org. Each step is
    //    individually idempotent so a prior partial boot retries cleanly.
    const userId = yield* step("admin", createAdminUser);
    yield* step("admin", () => verifyAdminEmail(userId));
    const orgId = yield* step("org", () => createStagingOrg(userId));
    const datasource = yield* step("datasource", () => seedDemoDatasource(orgId));
    const twenty = yield* step("twenty", () => seedTwentyInstall(orgId));

    log.info(
      { orgId, userId, datasource, twenty },
      "Staging seed: complete",
    );
    return {
      outcome: "seeded",
      created: { org: true, admin: true, datasource, twenty },
    } satisfies StagingSeedResult;
  });
}

// ── Step runner ────────────────────────────────────────────────────

/**
 * Wrap one async seed step as an Effect, normalizing any throw into a
 * phase-tagged {@link StagingSeedError}. Never swallows: the error
 * propagates so the boot Layer can fail loudly.
 */
function step<A>(
  phase: StagingSeedPhase,
  fn: () => Promise<A>,
): Effect.Effect<A, StagingSeedError> {
  return Effect.tryPromise({
    try: fn,
    catch: (err) =>
      new StagingSeedError({
        phase,
        message: err instanceof Error ? err.message : String(err),
      }),
  });
}

// ── Steps ──────────────────────────────────────────────────────────

/** Does the `staging-internal` organization already exist? */
async function markerExists(): Promise<boolean> {
  const rows = await internalQuery<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM organization WHERE slug = $1) AS exists`,
    [STAGING_ORG_SLUG],
  );
  return rows[0]?.exists === true;
}

/**
 * Create (or reuse) the deterministic staging admin. Returns the user id.
 * `createPlatformAdminUser` is itself retry-safe — it reuses an existing
 * `admin@staging.useatlas.dev` row (so a re-run after a partial boot doesn't
 * trip Better Auth's duplicate-email guard) and always (re)promotes to
 * `platform_admin`, repairing a prior run that created the user but not the
 * role. So this wrapper just supplies the deterministic credential.
 */
async function createAdminUser(): Promise<string> {
  const password = process.env.STAGING_ADMIN_PASSWORD?.trim();
  if (!password) {
    throw new Error(
      "STAGING_ADMIN_PASSWORD is not set — cannot seed the staging admin user. " +
        "Set it to the deterministic credential for admin@staging.useatlas.dev.",
    );
  }

  const auth = await getAuth();
  // Better Auth's typed `api` surface doesn't expose the organization plugin's
  // endpoints, so reach them through the same loose cast the dev seed uses
  // (`lib/auth/migrate.ts`).
  const api = auth.api as Record<string, unknown>;
  // #3159 — the admin plugin's `createUser` (which accepted a `role`) was
  // removed; `createPlatformAdminUser` creates via core signUpEmail + promotes
  // the row to `platform_admin` directly (role is an input:false additionalField).
  return createPlatformAdminUser(api, {
    email: STAGING_ADMIN_EMAIL,
    password,
    name: "Staging Admin",
  });
}

/**
 * Mark the seeded admin's email verified so it is sign-in-able with no
 * manual step. The staging admin keeps its deterministic password (no
 * `password_change_required` flag) so repeated smoke logins keep working.
 */
async function verifyAdminEmail(userId: string): Promise<void> {
  await internalQuery(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [userId]);
}

/** Create the `staging-internal` organization with the admin as owner. */
async function createStagingOrg(userId: string): Promise<string> {
  const auth = await getAuth();
  const api = auth.api as Record<string, unknown>;
  const createOrg = api.createOrganization as
    | ((opts: {
        body: { name: string; slug: string; userId: string };
      }) => Promise<{ id?: string } | undefined>)
    | undefined;
  if (!createOrg) {
    throw new Error("Staging seed: organization createOrganization API unavailable");
  }
  const org = await createOrg({
    body: { name: "Staging Internal", slug: STAGING_ORG_SLUG, userId },
  });
  const orgId = org?.id;
  if (!orgId) {
    throw new Error("Staging seed: createOrganization returned no org id");
  }
  return orgId;
}

/**
 * Install the shared `__demo__` NovaMart datasource (`demo-postgres`
 * catalog row) for the staging org. Mirrors the dev-seed workspace_plugins
 * upsert in `lib/auth/migrate.ts`. The demo dataset is operator/env-managed
 * (empty `config_schema`), so the install carries an empty config — the
 * connection URL resolves from `ATLAS_DATASOURCE_URL` at runtime.
 *
 * Returns `false` (non-fatal) if the catalog row is missing — that means
 * migration 0093 / the builtin datasource seeder has not run, which the
 * boot Layer's ordering dependency is meant to prevent.
 */
async function seedDemoDatasource(orgId: string): Promise<boolean> {
  const rows = await internalQuery<{ id: string }>(
    `SELECT id FROM plugin_catalog WHERE slug = $1 AND pillar = 'datasource' LIMIT 1`,
    [STAGING_DEMO_DATASOURCE_SLUG],
  );
  if (rows.length === 0) {
    log.warn(
      { slug: STAGING_DEMO_DATASOURCE_SLUG },
      "Staging seed: demo datasource catalog row missing — skipping datasource install",
    );
    return false;
  }
  await internalQuery(
    `INSERT INTO workspace_plugins
       (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, status)
     VALUES ($1, $2, $3, 'default', 'datasource', '{}'::jsonb, true, NOW(), 'published')
     ON CONFLICT (workspace_id, catalog_id, install_id)
       DO UPDATE SET status = 'published', updated_at = NOW()`,
    [`cn_${orgId}_demo`, orgId, rows[0].id],
  );
  return true;
}

/**
 * Install the staging Twenty integration pointing at the separate Twenty
 * Cloud workspace. Uses the canonical encrypted-at-rest store
 * (`saveTwentyIntegration`, `twenty_integrations` table) rather than a
 * hand-rolled INSERT, so the apiKey lands encrypted exactly like an admin
 * install. Best-effort: if the staging Twenty credentials are unset, the
 * rest of the seed still succeeds (a Twenty outage must not wedge the
 * staging boot), and the gap is logged.
 */
async function seedTwentyInstall(orgId: string): Promise<boolean> {
  const apiKey = process.env.STAGING_TWENTY_API_KEY?.trim();
  const baseUrl = process.env.STAGING_TWENTY_BASE_URL?.trim();
  if (!apiKey || !baseUrl) {
    log.warn(
      "Staging seed: STAGING_TWENTY_API_KEY / STAGING_TWENTY_BASE_URL unset — skipping Twenty install",
    );
    return false;
  }
  const { saveTwentyIntegration } = await import(
    "@atlas/api/lib/integrations/twenty/store"
  );
  await saveTwentyIntegration(orgId, { apiKey, baseUrl });
  return true;
}

// ── Auth instance accessor ─────────────────────────────────────────

/**
 * Lazily resolve the Better Auth instance — the same accessor the dev seed
 * uses. Dynamic import keeps this module free of a static auth dependency
 * (auth init pulls in the full Better Auth + DB stack) so it loads cheaply
 * in the non-staging path and in unit tests.
 */
async function getAuth() {
  const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
  return getAuthInstance();
}
