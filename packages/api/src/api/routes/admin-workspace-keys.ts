/**
 * Workspace-scoped API-key minting (#4046 / ADR-0027 §6).
 *
 * Mounted under /api/v1/admin/workspace-keys via admin.route().
 *
 * The unattended-CI credential is a Better Auth `apiKey()` key whose `metadata`
 * carries `{orgId, role, claims}` (api-key-metadata.ts) — the binding an
 * interactive session gets from the org plugin. With that metadata a key resolves
 * through the SAME actor path + gate chain as the device-flow bearer (managed.ts).
 *
 * The raw Better Auth `/api/auth/api-key/create` mount cannot inject this
 * metadata from the caller's membership and would mint an UNBOUND key (which
 * `validateManaged` then refuses, fail-closed). So minting a *workspace* key goes
 * through THIS route, which derives the metadata server-side:
 *  - **orgId** from the caller's resolved `orgContext` — NEVER a body field, so a
 *    caller can't mint a key for another workspace (isolation derives from the
 *    credential).
 *  - **role** capped at the minter's own effective role (`capRole`) — an admin
 *    can't mint an owner-authority key. ADR-0027 §2: the key grants no reach the
 *    minter doesn't already have. Minting a portable workspace credential is an
 *    admin-floor action (this router is `createAdminRouter`), matching the
 *    existing `/admin/api-keys` surface; a member's own CLI reach is the device-
 *    flow `atlas login` (free, no provisioning), not a minted key.
 *  - **claims** the RLS claim values the caller chooses within their own bag (or
 *    omitted) — surfaced into the key so RLS-enabled workspaces filter rows.
 *
 * The key is owned by the authenticated minter (Better Auth ties `referenceId` to
 * the session user when we forward the request headers), so a leaked key traces
 * to a real person + scope — never an anonymous principal. The full key value is
 * returned ONCE and never stored in plaintext (nor audited). List + revoke reuse
 * the native member-scoped `/api/auth/api-key/{list,delete}` mounts; revocation
 * takes effect on the next request because `validateManaged` verifies the key
 * live.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { capRole, clampToOrgRole, getUserRole } from "@atlas/api/lib/auth/permissions";
import { buildApiKeyMetadata, boundClaimsToMinter } from "@atlas/api/lib/auth/api-key-metadata";
import { ORG_ROLES } from "@atlas/api/lib/auth/types";
import type { OrgRole } from "@atlas/api/lib/auth/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-workspace-keys");

/** A workspace key never outlives a reasonable CI rotation cadence by default. */
const DEFAULT_EXPIRES_IN_DAYS = 90;
const MAX_EXPIRES_IN_DAYS = 365;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MintRequestSchema = z.object({
  /** Human label for the key (shown in the list UI). */
  name: z.string().trim().min(1, "name is required").max(100),
  /**
   * The org role the key should exercise. Capped server-side at the minter's own
   * effective role — a member cannot mint an admin/owner key. Omit to use the
   * minter's own role.
   */
  role: z.enum(ORG_ROLES).optional(),
  /**
   * RLS claim values the key carries (e.g. `{ tenant_id: "acme" }`), surfaced so
   * RLS-enabled workspaces filter rows for this key. Omit when the workspace has
   * no RLS, or when the key should carry no extra claims.
   */
  claims: z.record(z.string(), z.unknown()).optional(),
  /** Key lifetime in days (1–365). Defaults to 90. */
  expiresInDays: z.number().int().positive().max(MAX_EXPIRES_IN_DAYS).optional(),
});

const MintResponseSchema = z.object({
  /** The full key value — shown ONCE; store it now. */
  key: z.string(),
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  role: z.enum(ORG_ROLES),
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const mintRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Workspace Keys"],
  summary: "Mint a workspace-scoped API key",
  description:
    "Mint an unattended-CI API key bound to the active workspace, carrying {orgId, role, claims} metadata so it resolves through the same gate chain as an `atlas login` session. The role is capped at the minter's own; the workspace is derived from the credential, never the body. Returns the full key once.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: MintRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Key minted (full value returned once)",
      content: { "application/json": { schema: MintResponseSchema } },
    },
    400: { description: "Invalid request body", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminWorkspaceKeys = createAdminRouter();
adminWorkspaceKeys.use(requireOrgContext());

adminWorkspaceKeys.openapi(mintRoute, async (c) => {
  const body = c.req.valid("json");

  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId, user } = yield* AuthContext;
      const { requestId } = c.get("orgContext");

      // requireOrgContext guarantees orgId; user is set by adminAuth.
      if (!orgId || !user) {
        return c.json(
          { error: "no_workspace", message: "No active workspace bound to your session.", requestId },
          400,
        );
      }

      // Role ceiling: the minter's own effective role caps the key's role. A
      // member can't mint an admin/owner key; an admin can't mint an owner key.
      // A workspace key is org-scoped, so clamp the ceiling to org roles — a
      // `platform_admin` minter mints at most an `owner`-authority key (a key
      // never carries cross-tenant god-mode; mirrors the cli downgrade). The
      // OrgRole return type makes the no-god-key invariant compiler-guaranteed.
      const minterCeiling: OrgRole = clampToOrgRole(getUserRole(user));
      const requestedRole = body.role ?? minterCeiling;
      const role: OrgRole = clampToOrgRole(capRole(requestedRole, minterCeiling));

      // #4110 AC3 — bound the supplied RLS claims to the minter's OWN claim bag,
      // the claims-axis mirror of the `capRole` ceiling above: a key must never
      // carry RLS authority (or a forged identity claim) the minting admin
      // doesn't already hold. Reserved identity/security keys are rejected
      // outright; any other key must match the minter's own claim value exactly.
      const claimCheck = boundClaimsToMinter(body.claims, user.claims);
      if (!claimCheck.ok) {
        return c.json(
          {
            error: "claim_not_allowed",
            message:
              claimCheck.reason === "reserved"
                ? `The claim "${claimCheck.key}" is reserved by the auth layer and cannot be set on a workspace key.`
                : `The claim "${claimCheck.key}" is not in your own access scope. A workspace key cannot carry RLS claims you do not hold.`,
            requestId,
          },
          422,
        );
      }

      // The RLS claims to embed. Defaults to none (the workspace either has no
      // RLS, or the caller supplies specific claim values within their own scope).
      const metadata = buildApiKeyMetadata({
        orgId,
        role,
        ...(body.claims ? { claims: body.claims } : {}),
      });

      const expiresInSec = (body.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS) * 24 * 60 * 60;

      // Forward the request headers so Better Auth binds the key's `referenceId`
      // to the AUTHENTICATED minter — the key's owning member, traceable in the
      // audit. The metadata field is a client-passable property (not server-only),
      // and `enableMetadata: true` is set on the plugin (server.ts).
      //
      // `getAuthInstance` is imported DYNAMICALLY (not a top-level import) on
      // purpose: a static import would pull `auth/server.ts` (and its eager
      // `db/internal` dependencies) into the admin route graph at module-eval
      // time, which breaks tests that partial-mock `db/internal`. Mirrors the
      // existing dynamic-import pattern in admin.ts. Inside the Effect generator
      // the dynamic import is sequenced via `Effect.promise`, not `await`.
      const { getAuthInstance } = yield* Effect.promise(
        () => import("@atlas/api/lib/auth/server"),
      );
      const auth = getAuthInstance();
      const createApiKey = (auth.api as { createApiKey?: unknown }).createApiKey as
        | ((opts: {
            body: { name: string; metadata: Record<string, unknown>; expiresIn: number };
            headers: Headers;
          }) => Promise<{ id?: string; key?: string } | undefined>)
        | undefined;

      if (!createApiKey) {
        log.error({ requestId, orgId }, "apiKey plugin createApiKey unavailable — cannot mint workspace key");
        return c.json(
          { error: "key_minting_unavailable", message: "API key minting is not available on this deployment.", requestId },
          500,
        );
      }

      const created = yield* Effect.tryPromise({
        try: () =>
          createApiKey({
            body: {
              name: body.name,
              metadata: metadata as unknown as Record<string, unknown>,
              expiresIn: expiresInSec,
            },
            headers: c.req.raw.headers,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.error({ requestId, orgId, err: errorMessage(err) }, "createApiKey failed");
          return Effect.succeed(undefined);
        }),
      );

      if (!created?.key || !created.id) {
        return c.json(
          { error: "key_mint_failed", message: "Could not mint the workspace API key. Try again shortly.", requestId },
          500,
        );
      }

      // Audit the mint (never the key value): keyId + the granted scope, so a
      // leaked key's blast radius is reconstructable from the trail.
      logAdminAction({
        actionType: ADMIN_ACTIONS.workspace_key.mint,
        targetType: "workspace_key",
        targetId: created.id,
        metadata: { keyId: created.id, role, hasClaims: !!body.claims },
      });

      return c.json(
        { key: created.key, id: created.id, name: body.name, orgId, role },
        200,
      );
    }),
    { label: "mint workspace key" },
  );
});

export { adminWorkspaceKeys };
