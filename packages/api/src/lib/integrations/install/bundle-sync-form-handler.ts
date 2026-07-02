/**
 * `BundleSyncFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `bundle-sync` Knowledge Base catalog row (#4211, ADR-0028 §5
 * follow-up).
 *
 * Installing `bundle-sync` creates a **synced collection**: a
 * `pillar='knowledge'` `workspace_plugins` row (multi-instance, `install_id` =
 * collection slug — the same shape as `okf-upload`) whose config carries a
 * bundle **endpoint URL** + auth scheme. The Scheduler pulls the endpoint on a
 * cadence (`lib/knowledge/sync.ts`) and re-runs the #4207 ingest, so the diff
 * is computed by upsert-by-path and every synced change lands `draft`.
 *
 * Two things distinguish this from the okf-upload handler:
 *
 *  1. **SSRF gate at install time.** The endpoint is a workspace-admin-supplied
 *     URL Atlas will fetch server-side on a schedule — exactly the #3006 threat
 *     shape — so the URL is validated through `assertBaseUrlAllowed` (the
 *     single egress chokepoint) here, and re-validated by `guardedFetch` at
 *     every fetch + redirect hop. A blocked target is a field-level 400, not a
 *     500.
 *  2. **The first Knowledge Base credential.** The optional auth secret
 *     (bearer token / basic `user:password`) is routed to the dedicated
 *     `knowledge_sync_credentials` table (encrypted via
 *     `db/secret-encryption.ts`, an `INTEGRATION_TABLES` participant) — it is
 *     NEVER stored in `workspace_plugins.config`. Write order mirrors the
 *     Twenty handler: SaaS keyset gate → credential row → install row (the
 *     credential is the load-bearing artefact; re-running the install heals a
 *     half-completed pair).
 *
 * Re-installing an existing slug edits the container in place (endpoint /
 * auth / description) WITHOUT touching its documents; switching auth back to
 * `none` deletes the credential row (secrets never outlive their use).
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { KnowledgeSyncAuthScheme, WorkspaceId } from "@useatlas/types";
import {
  assertBaseUrlAllowed,
  EgressBlockedError,
  hostForLog,
} from "@atlas/api/lib/openapi/egress-guard";
import {
  saveSyncCredential,
  deleteSyncCredential,
} from "@atlas/api/lib/knowledge/sync-credentials";
import {
  assertSaasEncryptionKeyset,
  FormInstallValidationError,
} from "./persist-form-install";
import {
  assertCollectionSlugAvailable,
  resolveCollectionSlug,
  KNOWLEDGE_INSTALL_ID_FIELD,
} from "./okf-upload-form-handler";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

/** The built-in Knowledge Base (Bundle Sync) catalog slug + row id. */
export const BUNDLE_SYNC_SLUG = "bundle-sync";
export const BUNDLE_SYNC_CATALOG_ID = "catalog:bundle-sync";

/** Endpoint auth schemes — pinned to the wire union (`@useatlas/types`).
 *  `none` = public endpoint, no credential row. */
export const BUNDLE_SYNC_AUTH_SCHEMES = [
  "none",
  "bearer",
  "basic",
] as const satisfies readonly KnowledgeSyncAuthScheme[];
export type BundleSyncAuthScheme = (typeof BUNDLE_SYNC_AUTH_SCHEMES)[number];

/** Defensive upper bounds — guard against pathological pastes. */
const ENDPOINT_URL_MAX = 2048;
const AUTH_SECRET_MAX = 4096;

/** The non-secret config persisted on the `workspace_plugins` row. */
export interface BundleSyncCollectionConfig {
  readonly endpoint_url: string;
  readonly auth_scheme: BundleSyncAuthScheme;
  readonly description?: string;
}

export type ParsedBundleSyncConfig =
  | { readonly ok: true; readonly endpointUrl: string; readonly authScheme: BundleSyncAuthScheme }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the sync engine's inputs. Lives
 * next to {@link BundleSyncCollectionConfig} so the JSONB field names have
 * exactly one owner — the sync engine consumes this instead of re-deriving
 * the shape by hand (a field rename would compile clean and silently break
 * every sync). Errors are actionable admin-facing messages (they land in
 * `knowledge_sync_state.error`).
 */
export function parseBundleSyncConfig(
  config: Record<string, unknown> | null,
): ParsedBundleSyncConfig {
  const endpointUrl = typeof config?.endpoint_url === "string" ? config.endpoint_url.trim() : "";
  if (endpointUrl === "") {
    return {
      ok: false,
      error: "Collection has no endpoint_url configured — edit the collection and set one.",
    };
  }
  const rawScheme = config?.auth_scheme ?? "none";
  if (
    typeof rawScheme !== "string" ||
    !(BUNDLE_SYNC_AUTH_SCHEMES as readonly string[]).includes(rawScheme)
  ) {
    return {
      ok: false,
      error: `Unknown auth scheme "${String(rawScheme)}" on the collection config — edit the collection to fix it.`,
    };
  }
  return { ok: true, endpointUrl, authScheme: rawScheme as BundleSyncAuthScheme };
}

/**
 * The multi-instance synced-collection upsert. Identical shape to
 * `KNOWLEDGE_INSTALL_UPSERT_SQL` (okf-upload): `status='published'` because the
 * COLLECTION container is live immediately — the review gate is on the
 * DOCUMENTS, which always sync in as `draft`. Exported so the real-Postgres
 * test executes this exact string against the live schema.
 */
export const BUNDLE_SYNC_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export interface BundleSyncFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
}

export class BundleSyncFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly log = createLogger("integrations.install.bundle-sync");

  constructor(options: BundleSyncFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{ readonly installRecord: InstallRecord; readonly credentialWritten: boolean }> {
    if (formData === null || typeof formData !== "object" || Array.isArray(formData)) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: ["Request body must be a JSON object of config fields."],
      });
    }
    const rawForm = formData as Record<string, unknown>;

    const collectionSlug = resolveCollectionSlug(
      rawForm[KNOWLEDGE_INSTALL_ID_FIELD],
      BUNDLE_SYNC_SLUG,
    );

    // ── Validate fields (endpoint URL + SSRF gate, auth pair, description) ──
    const endpointUrl = validateEndpointUrl(rawForm.endpoint_url);
    const { authScheme, authSecret } = validateAuth(rawForm.auth_scheme, rawForm.auth_secret);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled so a seed misconfig surfaces
    // as a clear 500 rather than an opaque FK error on the INSERT below.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [BUNDLE_SYNC_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "bundle-sync catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${BUNDLE_SYNC_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    // A slug taken by another knowledge catalog (okf-upload) would merge
    // document trees — reject before any write (#4211).
    await assertCollectionSlugAvailable(workspaceId, collectionSlug, catalogId);

    // ── Credential first (mirrors the Twenty handler's write order) ────────
    if (authSecret !== null) {
      // SaaS keyset gate BEFORE any credential byte is persisted — a
      // misconfigured SaaS deploy must fail closed, never store plaintext.
      assertSaasEncryptionKeyset(this.log, workspaceId, "auth_secret");
      try {
        await saveSyncCredential(workspaceId, collectionSlug, authSecret);
      } catch (err) {
        this.log.error(
          { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
          "Failed to persist knowledge_sync_credentials row — aborting install",
        );
        throw err;
      }
    } else {
      // Editing an existing collection back to `none` must not leave a stale
      // secret behind. Harmless no-op on a fresh install.
      await deleteSyncCredential(workspaceId, collectionSlug);
    }

    // ── Upsert the collection container (never carries the secret) ─────────
    const config: BundleSyncCollectionConfig = {
      endpoint_url: endpointUrl,
      auth_scheme: authScheme,
      ...(description !== null ? { description } : {}),
    };

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(BUNDLE_SYNC_INSTALL_UPSERT_SQL, [
        candidateId,
        workspaceId,
        catalogId,
        collectionSlug,
        JSON.stringify(config),
      ]);
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        // See the okf-upload handler for why an empty RETURNING is fail-loud
        // (candidateId would be WRONG on the conflict path).
        this.log.error(
          { workspaceId, candidateId, collectionSlug },
          "workspace_plugins upsert returned no id — Postgres invariant violation",
        );
        throw new Error(
          "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
        );
      }
      persistedId = returned;
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist bundle-sync collection install — aborting install (the credential write, if any, is idempotent; retrying the install is safe)",
      );
      throw err;
    }

    this.log.info(
      // Host only (via the guard's shared helper) — the URL path could embed a
      // token-ish segment.
      { workspaceId, collectionSlug, rowId: persistedId, endpointHost: hostForLog(endpointUrl), authScheme },
      "Bundle-sync collection install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: BUNDLE_SYNC_SLUG },
      credentialWritten: authSecret !== null,
    };
  }
}

/**
 * Validate the endpoint URL: required, well-formed, bounded, and allowed by
 * the SSRF egress guard (private/loopback/link-local/internal targets and
 * non-HTTPS are rejected unless the operator opt-out is set — see
 * `openapi/egress-guard.ts`). Every failure is a field-level 400.
 */
function validateEndpointUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new FormInstallValidationError({
      fieldErrors: { endpoint_url: ["Endpoint URL is required."] },
      formErrors: [],
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length > ENDPOINT_URL_MAX) {
    throw new FormInstallValidationError({
      fieldErrors: {
        endpoint_url: [`Endpoint URL must be ${ENDPOINT_URL_MAX} characters or fewer.`],
      },
      formErrors: [],
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // intentionally ignored: URL constructor throw is the negative validation
    // signal — the field error below is the actionable surface.
    throw new FormInstallValidationError({
      fieldErrors: {
        endpoint_url: ["Endpoint URL must be a well-formed URL (e.g. https://example.com/kb.tar.gz)."],
      },
      formErrors: [],
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new FormInstallValidationError({
      fieldErrors: { endpoint_url: ["Endpoint URL must be http(s)."] },
      formErrors: [],
    });
  }
  // URL userinfo (`https://user:pass@host/...`) would land the credential
  // PLAINTEXT in workspace_plugins.config (echoed by the admin list and
  // rendered in the UI) — and `fetch` rejects credentialed URLs anyway. The
  // encrypted Authentication fields are the only sanctioned carrier.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new FormInstallValidationError({
      fieldErrors: {
        endpoint_url: [
          "Remove the credentials from the URL — use the Authentication fields instead (stored encrypted).",
        ],
      },
      formErrors: [],
    });
  }
  try {
    assertBaseUrlAllowed(trimmed);
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      throw new FormInstallValidationError({
        // EgressBlockedError.message is already host-redacted + actionable.
        fieldErrors: { endpoint_url: [err.message] },
        formErrors: [],
      });
    }
    throw err;
  }
  return trimmed;
}

/**
 * Validate the auth pair: a recognized scheme, and a secret exactly when the
 * scheme needs one. Returns the secret as `null` for `none` (the caller then
 * deletes any stale credential row).
 */
function validateAuth(
  rawScheme: unknown,
  rawSecret: unknown,
): { authScheme: BundleSyncAuthScheme; authSecret: string | null } {
  const scheme = rawScheme === undefined || rawScheme === null ? "none" : rawScheme;
  if (
    typeof scheme !== "string" ||
    !(BUNDLE_SYNC_AUTH_SCHEMES as readonly string[]).includes(scheme)
  ) {
    throw new FormInstallValidationError({
      fieldErrors: { auth_scheme: ['Authentication must be one of "none", "bearer", or "basic".'] },
      formErrors: [],
    });
  }
  const authScheme = scheme as BundleSyncAuthScheme;

  const secret =
    typeof rawSecret === "string" && rawSecret.trim() !== "" ? rawSecret.trim() : null;
  if (authScheme === "none") {
    if (secret !== null) {
      throw new FormInstallValidationError({
        fieldErrors: {
          auth_secret: ['Remove the auth secret, or pick "bearer" / "basic" authentication.'],
        },
        formErrors: [],
      });
    }
    return { authScheme, authSecret: null };
  }
  if (secret === null) {
    throw new FormInstallValidationError({
      fieldErrors: {
        auth_secret: [
          authScheme === "bearer"
            ? "A bearer token is required for bearer authentication."
            : "A user:password secret is required for basic authentication.",
        ],
      },
      formErrors: [],
    });
  }
  if (secret.length > AUTH_SECRET_MAX) {
    throw new FormInstallValidationError({
      fieldErrors: { auth_secret: [`Auth secret must be ${AUTH_SECRET_MAX} characters or fewer.`] },
      formErrors: [],
    });
  }
  if (authScheme === "basic" && !secret.includes(":")) {
    throw new FormInstallValidationError({
      fieldErrors: { auth_secret: ["Basic auth secret must be in user:password form."] },
      formErrors: [],
    });
  }
  return { authScheme, authSecret: secret };
}

/** Optional human description — same rule as the okf-upload handler. */
function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new FormInstallValidationError({
      fieldErrors: { description: ["Description must be a string."] },
      formErrors: [],
    });
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}
