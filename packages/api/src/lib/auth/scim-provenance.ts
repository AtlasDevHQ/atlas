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
 * Detection mirrors the `account` ↔ `scimProvider` join used by
 * `ee/src/auth/scim.ts:198-205` (getSyncStatus). When EE is disabled, no
 * internal DB is configured, or the SCIM tables haven't been migrated, the
 * helper returns `false` (no SCIM contract → mutation proceeds unchanged).
 *
 * See `.claude/research/security-audit-1-2-3.md` § Phase 7 → F-57.
 */

import { Effect } from "effect";
import type { z } from "@hono/zod-openapi";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { isEnterpriseEnabled } from "@atlas/ee/index";
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
 *   - the `scimProvider` table does not exist (EE flag flipped on but the
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
): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    if (!isEnterpriseEnabled()) return false;
    if (!hasInternalDB()) return false;

    const sql = orgId
      ? `SELECT 1 FROM account a
         JOIN "scimProvider" sp ON a."providerId" = sp."providerId"
         WHERE a."userId" = $1 AND sp."organizationId" = $2
         LIMIT 1`
      : `SELECT 1 FROM account a
         JOIN "scimProvider" sp ON a."providerId" = sp."providerId"
         WHERE a."userId" = $1
         LIMIT 1`;
    const params = orgId ? [userId, orgId] : [userId];

    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<Record<string, unknown>>(sql, params),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.catchAll((err) => {
        // 42P01 — relation does not exist. SCIM tables are owned by the
        // @better-auth/scim plugin and only exist after its migration runs.
        // EE flag flipped on but migration pending → treat the user as
        // non-SCIM rather than fail closed; callers will re-evaluate after
        // the migration lands.
        //
        // Pin on the SQLSTATE first (pg's DatabaseError carries `.code`).
        // Fall back to a tightened message check requiring BOTH the table
        // name AND "does not exist" — bare "does not exist" matches
        // 42704 (undefined role), 42883 (undefined function), 3F000
        // (schema does not exist), and friends, none of which mean SCIM
        // is uninstalled. Any of those would let an admin mutate a SCIM
        // user — exactly the silent failure F-57 forbids.
        const code = (err as { code?: unknown }).code;
        const msg = err.message ?? String(err);
        const isMissingScimProvider =
          code === "42P01" ||
          (msg.includes("does not exist") && msg.includes("scimProvider"));
        if (isMissingScimProvider) {
          log.warn(
            { err: msg, userId, orgId },
            "scimProvider table missing — treating user as non-SCIM",
          );
          return Effect.succeed([] as Record<string, unknown>[]);
        }
        return Effect.fail(err);
      }),
    );

    return rows.length > 0;
  });

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
 */
export const evaluateSCIMGuard = (opts: {
  userId: string;
  orgId?: string;
  requestId: string;
}): Effect.Effect<SCIMGuardResult, Error> =>
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
 * lives in plain async/await today). The Effect runs to completion and any
 * unrecoverable failure propagates as a thrown Error — the caller's
 * `runHandler` / try-catch surfaces it as a 500 with the standard requestId
 * shape, which is the desired fail-closed behaviour for a security check.
 */
export async function evaluateSCIMGuardAsync(opts: {
  userId: string;
  orgId?: string;
  requestId: string;
}): Promise<SCIMGuardResult> {
  return Effect.runPromise(evaluateSCIMGuard(opts));
}
