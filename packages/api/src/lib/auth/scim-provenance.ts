/**
 * F-57 — SCIM provenance check on admin user mutations.
 *
 * SCIM declares the IdP (Okta, Azure AD, etc.) as the source of truth for
 * user identity. Admin UI mutations on SCIM-provisioned users that proceed
 * silently get reverted on the next sync — at best surprising, at worst
 * orphaning audit references when a delete + re-provision creates a fresh
 * userId. This module gates those mutations.
 *
 * Two policy modes (per-workspace setting `ATLAS_SCIM_OVERRIDE_POLICY`):
 *   - `strict`  (default) — block with 409 SCIM_MANAGED.
 *   - `override`          — let the mutation proceed and stamp the audit row
 *                           with `metadata.scim_override = true`.
 *
 * Detection reads the `scimUser` projection that @better-auth/scim writes
 * on every provisioning sync (see `ee/src/auth/scim.ts`). When EE is disabled, no
 * internal DB is configured, or the SCIM tables haven't been migrated, the
 * helper returns `false` (no SCIM contract → mutation proceeds unchanged).
 *
 * See `.claude/research/security-audit-1-2-3.md` § Phase 7 → F-57.
 */

import { Effect } from "effect";
import type { z } from "@hono/zod-openapi";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { SCIMProvenance } from "@atlas/api/lib/effect/services";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { SCIMManagedSchema } from "@atlas/api/lib/auth/scim-managed-schema";

export { SCIMManagedSchema } from "@atlas/api/lib/auth/scim-managed-schema";

const log = createLogger("scim-provenance");

export type SCIMOverridePolicy = "strict" | "override";

export const SCIM_OVERRIDE_POLICIES = ["strict", "override"] as const satisfies readonly SCIMOverridePolicy[];

export const DEFAULT_SCIM_OVERRIDE_POLICY: SCIMOverridePolicy = "strict";

export const SCIM_OVERRIDE_POLICY_SETTING_KEY = "ATLAS_SCIM_OVERRIDE_POLICY";

/**
 * Parse a raw setting value into a policy enum, defaulting to `strict` for
 * any unrecognized input. Strict is the safer fail-closed default — the
 * mutation only proceeds when an operator has explicitly opted in.
 */
export function parseSCIMOverridePolicy(raw: string | undefined): SCIMOverridePolicy {
  return raw === "override" ? "override" : DEFAULT_SCIM_OVERRIDE_POLICY;
}

/**
 * Resolve the active SCIM override policy for a workspace, falling back to
 * platform-level overrides and the registry default.
 */
export function getSCIMOverridePolicy(orgId: string | undefined): SCIMOverridePolicy {
  return parseSCIMOverridePolicy(getSettingAuto(SCIM_OVERRIDE_POLICY_SETTING_KEY, orgId));
}

/**
 * Check whether `userId` was provisioned via SCIM. When `orgId` is supplied
 * the check is scoped to that workspace's SCIM providers (a user provisioned
 * in workspace A but not B should not block mutations in B). When omitted
 * the check runs across all SCIM providers — used by platform-admin paths
 * that have no active workspace context.
 *
 * Returns `false` (treat as non-SCIM) when:
 *   - enterprise mode is disabled,
 *   - the internal DB is not configured,
 *   - the `scimUser` table does not exist (EE flag flipped on but the
 *     better-auth/scim plugin migration hasn't run yet — common during
 *     staged rollouts).
 *
 * Genuine query failures propagate so the route handler can fail closed
 * (block the mutation, surface 500). Silently returning `false` here would
 * reverse the SCIM contract on a transient DB blip.
 */
export const isSCIMProvisioned = (
  userId: string,
  orgId?: string,
): Effect.Effect<boolean, Error, SCIMProvenance> => {
  // EE-gate via the `SCIMProvenance` Tag (#2570). The no-op default
  // reports `available: false`, so self-hosted short-circuits to
  // "treat as non-SCIM" — identical to the pre-#2570
  // `isEnterpriseEnabled()` check.
  //
  // The `SCIMProvenance` Tag is exposed in the `R` channel (#2591) so
  // callers compose via the module-level `runEnterprise(...)` helper
  // instead of paying for a fresh `Effect.provide(EnterpriseLayer)` per
  // call. Re-wrapping `EnterpriseLayer` internally rebuilt the
  // dynamic `@atlas/ee/layers` import wrapper per invocation and
  // defeated Effect's reference-keyed Layer memoization — exactly the
  // problem #2594 hoisted the rest of the call sites out of.
  return Effect.gen(function* () {
    const provenance = yield* SCIMProvenance;
    if (!provenance.available) return false;
    if (!hasInternalDB()) return false;

    // #5493: @better-auth/scim 1.7 replaced `scimProvider` with a catalog,
    // and `scimUser` carries BOTH `userId` and `provisioningDomainId`
    // directly. That collapses the old two-table join through
    // `account."providerId"` into a single-table lookup.
    //
    // This is a strict narrowing, not just a simplification. The 1.6 join
    // matched any `account` row whose `providerId` string happened to equal
    // a provider's — `account` also holds OAuth/credential rows, so a
    // collision between an unrelated provider id and a SCIM one would have
    // read as "SCIM-provisioned". `scimUser` rows are written only by the
    // provisioning path, so membership is now exact.
    //
    // ⚠️ BOTH models are consulted, and that is load-bearing until the
    // `scimProvider` -> managed-connection data migration lands.
    //
    // On a deploy that is UPGRADING, `scimUser` is empty — nothing has
    // backfilled it — while the legacy `scimProvider` rows still describe
    // real directory-managed users. Reading only the new table would return
    // `false` for every one of them, and this predicate FAILS OPEN by
    // contract: `false` means "no SCIM contract, mutation proceeds". So an
    // admin could edit a directory-managed user the IdP still owns, which
    // is precisely the F-57 guarantee this module exists to hold. That is a
    // security regression, not a cosmetic gap, so the legacy read stays
    // until the migration makes it redundant.
    //
    // Each side is independently guarded on its own table being absent, so
    // a fresh install (no `scimProvider`) and a fully-migrated install
    // (no rows) both cost one extra indexed lookup that finds nothing.
    const newSql = orgId
      ? `SELECT 1 FROM "scimUser"
         WHERE "userId" = $1 AND "provisioningDomainId" = $2
         LIMIT 1`
      : `SELECT 1 FROM "scimUser"
         WHERE "userId" = $1
         LIMIT 1`;
    const legacySql = orgId
      ? `SELECT 1 FROM account a
         JOIN "scimProvider" sp ON a."providerId" = sp."providerId"
         WHERE a."userId" = $1 AND sp."organizationId" = $2
         LIMIT 1`
      : `SELECT 1 FROM account a
         JOIN "scimProvider" sp ON a."providerId" = sp."providerId"
         WHERE a."userId" = $1
         LIMIT 1`;
    const params = orgId ? [userId, orgId] : [userId];

    /**
     * Run one provenance lookup, tolerating ONLY "that table does not
     * exist" and failing closed on everything else.
     *
     * 42P01 — relation does not exist. SCIM tables are owned by the
     * @better-auth/scim plugin and only exist after its migration runs (and
     * `scimProvider` ceases to exist once 1.7 has replaced it). EE flag
     * flipped on but migration pending → treat as "this model says nothing"
     * rather than fail closed; the other model still gets its say.
     *
     * Pin on the SQLSTATE first (pg's DatabaseError carries `.code`). Fall
     * back to a tightened message check requiring BOTH the table name AND
     * "does not exist" — bare "does not exist" matches 42704 (undefined
     * role), 42883 (undefined function), 3F000 (schema does not exist), and
     * friends, none of which mean SCIM is uninstalled. Any of those would
     * let an admin mutate a SCIM user — exactly the silent failure F-57
     * forbids.
     */
    const probe = (sql: string, table: string) =>
      Effect.tryPromise({
        try: () => internalQuery<Record<string, unknown>>(sql, params),
        catch: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          const code = (err as { code?: unknown }).code;
          const msg = err.message ?? String(err);
          const isMissingTable =
            code === "42P01" ||
            (msg.includes("does not exist") && msg.includes(table));
          if (isMissingTable) {
            log.warn(
              { err: msg, userId, orgId, table },
              `${table} table missing — that model reports no SCIM provenance`,
            );
            return Effect.succeed([] as Record<string, unknown>[]);
          }
          return Effect.fail(err);
        }),
      );

    // Independent reads — run together per CLAUDE.md's no-async-waterfalls
    // rule. Neither short-circuits the other: a `true` from EITHER model
    // means the user is directory-managed.
    const [newRows, legacyRows] = yield* Effect.all(
      [probe(newSql, "scimUser"), probe(legacySql, "scimProvider")],
      { concurrency: "unbounded" },
    );

    return newRows.length > 0 || legacyRows.length > 0;
  });
};

/**
 * TS-side block-body shape. Derived from the Zod schema (defined in the
 * dependency-free `scim-managed-schema.ts` sibling) so the wire contract
 * has a single source of truth — adding a field to one without the other
 * becomes a compile error rather than a silent drift between what the
 * route returns and what the OpenAPI spec advertises.
 */
export type SCIMManagedBlockBody = z.infer<typeof SCIMManagedSchema>;

export function scimManagedBlockBody(requestId: string): SCIMManagedBlockBody {
  return {
    error: "scim_managed",
    code: "SCIM_MANAGED",
    message:
      "This user is provisioned via SCIM and is owned by the identity provider. The change you make will be reverted on the next sync.",
    requestId,
  };
}

export type SCIMGuardResult =
  | { readonly kind: "non_scim" }
  | { readonly kind: "override" }
  | { readonly kind: "block"; readonly status: 409; readonly body: SCIMManagedBlockBody };

/**
 * Effect-flavoured guard. Resolves SCIM provenance + policy into a single
 * decision the caller short-circuits on. Used directly from Effect-based
 * handlers (e.g. `assignRoleRoute` in admin-roles.ts).
 *
 * The `SCIMProvenance` Tag is required (#2591) — Effect-based handlers
 * inherit it from the Hono bridge's `EnterpriseLayer` automatically.
 * Non-Effect callers should go through `evaluateSCIMGuardAsync` below,
 * which composes via the shared module-level runtime.
 */
export const evaluateSCIMGuard = (opts: {
  userId: string;
  orgId?: string;
  requestId: string;
}): Effect.Effect<SCIMGuardResult, Error, SCIMProvenance> =>
  Effect.gen(function* () {
    const provisioned = yield* isSCIMProvisioned(opts.userId, opts.orgId);
    if (!provisioned) return { kind: "non_scim" } as const;
    const policy = getSCIMOverridePolicy(opts.orgId);
    if (policy === "override") return { kind: "override" } as const;
    return {
      kind: "block",
      status: 409,
      body: scimManagedBlockBody(opts.requestId),
    } as const;
  });

/**
 * Promise wrapper for non-Effect handlers (every user mutation in admin.ts
 * lives in plain async/await today). The Effect runs to completion through
 * the shared module-level `EnterpriseLayer` runtime — the dynamic
 * `@atlas/ee/layers` import is paid once per process rather than per call
 * (#2591). Any unrecoverable failure propagates as a thrown Error so the
 * caller's `runHandler` / try-catch surfaces it as a 500 with the standard
 * requestId shape, which is the desired fail-closed behaviour for a
 * security check.
 */
export async function evaluateSCIMGuardAsync(opts: {
  userId: string;
  orgId?: string;
  requestId: string;
}): Promise<SCIMGuardResult> {
  return runEnterprise(evaluateSCIMGuard(opts));
}
