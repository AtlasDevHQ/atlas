/**
 * `OpenApiGenericFormInstallHandler` — admin install flow for the built-in
 * generic OpenAPI REST datasource (PRD #2868 slice 2, #2926). Retires slice-1's
 * `ATLAS_OPENAPI_TWENTY*` env-var hardcoding: a workspace admin now installs any
 * OpenAPI 3.x API as a read-only datasource from `/admin/connections`.
 *
 * Shape generalizes the sibling form handlers (Obsidian / Webhook store config
 * directly in `workspace_plugins.config` with selective-field encryption) — but
 * differs in two ways that make it a *Datasource-pillar* install per ADR-0007:
 *
 *  1. **Multi-instance.** Postgres/Twenty/Stripe/an internal service install
 *     side by side. Each submit mints a fresh `install_id` (the composite PK is
 *     `(workspace_id, catalog_id, install_id)`), so there is NO singleton
 *     `ON CONFLICT (workspace_id, catalog_id)` — that index gates chat/action
 *     only. The handler inserts a new row every time.
 *  2. **Probe-on-install.** It fetches the spec (slice-0 `openapi-spec`) and
 *     caches the normalized snapshot in `config.openapi_snapshot` so the agent
 *     loop resolves the operation surface from the DB row, never a live re-probe
 *     per turn. A probe failure surfaces as a field-level 400 so the install
 *     modal can tell the admin the URL/credential is wrong.
 *
 * **Encryption is schema-driven.** `auth_value` carries `secret: true` in
 * {@link OPENAPI_GENERIC_CONFIG_SCHEMA}; `encryptSecretFields` reads that flag
 * and AES-256-GCM-encrypts the value before it touches the DB. Adding a future
 * secret field is a one-line schema change — never a hand-wired crypto call
 * (AC3 / PRD user story 19). A plaintext credential never lands in config.
 *
 * **SaaS keyset gate.** Mirrors the Obsidian/Twenty/Email posture: refuse the
 * install when `ATLAS_DEPLOY_MODE=saas` and no encryption keyset is configured,
 * so a misconfigured SaaS deploy fails closed at the credential boundary rather
 * than silently persisting plaintext.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ../../openapi/catalog.ts — config schema + snapshot shape
 * @see ../../openapi/probe.ts — spec probe + snapshot builder
 */

import crypto from "crypto";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { assertSaasEncryptionKeyset } from "./persist-form-install";
import { safeHost } from "./safe-host";
import { isPlaintextCredentialRisk } from "@atlas/api/lib/db/secret-encryption";
import { encryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { assertBaseUrlAllowed, EgressBlockedError } from "@atlas/api/lib/openapi/egress-guard";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import type { WorkspaceId } from "@useatlas/types";
import {
  OPENAPI_GENERIC_SLUG,
  OPENAPI_GENERIC_CATALOG_ID,
  OPENAPI_GENERIC_CONFIG_SCHEMA,
  OPENAPI_AUTH_KINDS,
  OPENAPI_SUPPORTED_AUTH_KINDS,
  DEFAULT_REPRESENTATION_MODE,
  narrowSupportedAuthKind,
  type SupportedAuthKind,
} from "@atlas/api/lib/openapi/catalog";
import {
  buildResolvedAuth,
  probeSpec,
  buildSnapshot,
  OpenApiProbeError,
  type ProbeOptions,
} from "@atlas/api/lib/openapi/probe";
import { baselineSpecDiffRecord } from "@atlas/api/lib/openapi/diff";
import { findDataCandidateBySlug } from "@atlas/api/lib/openapi/data-candidates";
import { isShareableSpec, probeShared } from "@atlas/api/lib/openapi/shared-spec-cache";
import { FormInstallValidationError } from "./email-form-handler";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

const log = createLogger("integrations.install.openapi-generic");

/** Defensive upper bound on the credential — guards against pathological pastes. */
const AUTH_VALUE_MAX = 8192;

const UrlSchema = z
  .string()
  .min(1, "openapi_url is required")
  .transform((raw) => raw.trim())
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      // intentionally ignored: URL constructor throw is the negative
      // validation signal — the user sees the .refine message.
      return false;
    }
  }, "openapi_url must be a well-formed http(s) URL");

const OptionalUrlSchema = z
  .string()
  .transform((raw) => raw.trim())
  .refine((raw) => {
    if (raw.length === 0) return true;
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      // intentionally ignored: URL constructor throw is the negative
      // validation signal — the user sees the .refine message.
      return false;
    }
  }, "base_url_override must be a well-formed http(s) URL")
  .optional();

export const OpenApiGenericFormDataSchema = z
  .object({
    openapi_url: UrlSchema,
    auth_kind: z.enum(OPENAPI_AUTH_KINDS),
    auth_value: z
      .string()
      .max(AUTH_VALUE_MAX, `auth_value must be ${AUTH_VALUE_MAX} characters or fewer`)
      .transform((raw) => raw.trim())
      .optional(),
    auth_header_name: z.string().trim().max(256).optional(),
    auth_param_name: z.string().trim().max(256).optional(),
    base_url_override: OptionalUrlSchema,
    write_allowlist: z.string().trim().optional(),
    display_name: z.string().trim().max(256).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // oauth2 is declared in the enum (stable, shown coming-soon) but its flow
    // ships in slice 6 — reject it here with a field error so the modal points
    // at the right input rather than a generic 500 from the probe.
    if (!OPENAPI_SUPPORTED_AUTH_KINDS.includes(data.auth_kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_kind"],
        message: `"${data.auth_kind}" auth is not supported yet (coming in a later release).`,
      });
      return;
    }
    // Credential-bearing kinds require a value; "none" must not carry one.
    const needsValue = data.auth_kind !== "none";
    if (needsValue && (!data.auth_value || data.auth_value.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_value"],
        message: "auth_value is required for the selected authentication type.",
      });
    }
    if (data.auth_kind === "apikey-header" && !data.auth_header_name) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_header_name"],
        message: "auth_header_name is required for apikey-header auth.",
      });
    }
    if (data.auth_kind === "apikey-query" && !data.auth_param_name) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_param_name"],
        message: "auth_param_name is required for apikey-query auth.",
      });
    }
    // write_allowlist must be a JSON array of strings when present (honored in
    // slice 5; validated now so a malformed value is caught at install).
    if (data.write_allowlist && data.write_allowlist.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.write_allowlist);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["write_allowlist"],
          message: "write_allowlist must be valid JSON (an array of operationId strings).",
        });
        return;
      }
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
        ctx.addIssue({
          code: "custom",
          path: ["write_allowlist"],
          message: "write_allowlist must be a JSON array of operationId strings.",
        });
      }
    }
  });

export type OpenApiGenericFormData = z.infer<typeof OpenApiGenericFormDataSchema>;

/** Test seams — injected id/clock/probe so the handler is deterministic in tests. */
export interface OpenApiGenericFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
  /** Returns the ISO-8601 `probedAt` stamp. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /** `fetch` override threaded into the spec probe. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export class OpenApiGenericFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(options: OpenApiGenericFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.fetchImpl = options.fetchImpl;
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    // ── 1. Validate the form ────────────────────────────────────────
    const parsed = OpenApiGenericFormDataSchema.safeParse(formData);
    if (!parsed.success) {
      throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
    }
    const data = parsed.data;

    // ── 2. Narrow the form's auth kind to the executable subset ─────
    // oauth2 is rejected by the schema's superRefine above; the `null` arm is
    // unreachable but kept total so `persistOpenApiDatasourceInstall` receives a
    // {@link SupportedAuthKind}, never a raw form string.
    const supportedKind = narrowSupportedAuthKind(data.auth_kind);
    if (!supportedKind) {
      throw FormInstallValidationError.fromZodFlatten({
        fieldErrors: {
          auth_kind: [`"${data.auth_kind}" auth is not supported yet (coming in a later release).`],
        },
        formErrors: [],
      });
    }

    // ── 3. Shared probe → encrypt → insert core ─────────────────────
    // Everything past form parsing (keyset gate, plaintext warning, SSRF guard,
    // probe→snapshot, schema-driven encryption, multi-instance INSERT) is the
    // SAME for every OpenAPI datasource install — the generic row here AND the
    // built-in data candidates (slice 6a, #3028) — so it lives in one shared
    // function. A candidate handler is then a thin wrapper that pre-fills
    // openapi_url + auth_kind and calls the same core (no forked install path).
    return persistOpenApiDatasourceInstall({
      workspaceId,
      catalogId: OPENAPI_GENERIC_CATALOG_ID,
      catalogSlug: OPENAPI_GENERIC_SLUG,
      configSchema: OPENAPI_GENERIC_CONFIG_SCHEMA,
      openapiUrl: data.openapi_url,
      authKind: supportedKind,
      ...(data.auth_value ? { authValue: data.auth_value } : {}),
      ...(data.auth_header_name ? { authHeaderName: data.auth_header_name } : {}),
      ...(data.auth_param_name ? { authParamName: data.auth_param_name } : {}),
      ...(data.base_url_override ? { baseUrlOverride: data.base_url_override } : {}),
      ...(data.write_allowlist ? { writeAllowlist: data.write_allowlist } : {}),
      ...(data.display_name ? { displayName: data.display_name } : {}),
      newId: this.newId,
      now: this.now,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }
}

/**
 * Params for {@link persistOpenApiDatasourceInstall} — the resolved (post-form)
 * inputs every OpenAPI datasource install shares. `authKind` is the already-
 * narrowed {@link SupportedAuthKind} (oauth2 unrepresentable). `catalogId` is the
 * `catalog:*` FK written to the row; `catalogSlug` is the bare slug returned on
 * the {@link InstallRecord}. `configSchema`'s `secret: true` flags drive
 * encryption — never named here.
 */
export interface PersistOpenApiDatasourceInstallParams {
  readonly workspaceId: WorkspaceId;
  readonly catalogId: string;
  readonly catalogSlug: string;
  readonly configSchema: ReadonlyArray<ConfigSchemaField>;
  readonly openapiUrl: string;
  readonly authKind: SupportedAuthKind;
  readonly authValue?: string;
  readonly authHeaderName?: string;
  readonly authParamName?: string;
  readonly baseUrlOverride?: string;
  /**
   * The candidate's declared API base URL (host), used only to gate the probe
   * credential (#3034): the credential is sent to the spec host iff it matches
   * this host (or the `baseUrlOverride` host, which takes precedence). Absent for
   * a generic install with no `baseUrlOverride` ⇒ the credential is withheld
   * (fail-safe). See {@link import("../../openapi/probe").ProbeOptions.apiBaseUrl}.
   */
  readonly apiBaseUrl?: string;
  readonly writeAllowlist?: string;
  readonly displayName?: string;
  readonly newId: () => string;
  readonly now: () => string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * The shared OpenAPI datasource install core: keyset gate → plaintext warning →
 * SSRF guard → probe→snapshot → schema-driven encryption → multi-instance
 * INSERT. Extracted from {@link OpenApiGenericFormInstallHandler.validateConfig}
 * (slice 6a, #3028) so the generic handler AND every built-in data-candidate
 * handler share ONE install path — the candidate is a thin wrapper that pre-fills
 * `openapiUrl` + `authKind` and calls this, never a fork.
 *
 * A probe failure surfaces as a field-level {@link FormInstallValidationError} on
 * `openapi_url`; the SaaS keyset gate hard-fails; a self-hosted prod deploy with
 * no keyset warns (non-fatal). Inserts a fresh `install_id` every call
 * (multi-instance) under `status='draft'`.
 */
export async function persistOpenApiDatasourceInstall(
  params: PersistOpenApiDatasourceInstallParams,
): Promise<{ readonly installRecord: InstallRecord; readonly credentialWritten: boolean }> {
  const {
    workspaceId,
    catalogId,
    catalogSlug,
    configSchema,
    openapiUrl,
    authKind,
    authValue,
    authHeaderName,
    authParamName,
    baseUrlOverride,
    apiBaseUrl,
    writeAllowlist,
    displayName,
    newId,
    now,
    fetchImpl,
  } = params;

  // ── SaaS keyset gate ──────────────────────────────────────────────
  // Shared fail-closed gate (see persist-form-install.ts); catalogSlug
  // rides along so per-candidate installs stay attributable in the log.
  assertSaasEncryptionKeyset(log, workspaceId, "auth_value", { catalogSlug });

  // ── Self-hosted plaintext-credential warning (non-fatal) ──────────
  // The SaaS gate above hard-fails. A self-hosted prod-like deploy with a
  // credential and no keyset is *allowed* (keyless dev passthrough is intentional
  // repo-wide parity) but must not be silent — mirror the boot-time P0 alarm.
  if (authValue && isPlaintextCredentialRisk()) {
    log.warn(
      { workspaceId, catalogSlug },
      "Persisting an OpenAPI datasource credential with no encryption keyset configured in a " +
        "prod-like environment — auth_value will be stored in plaintext. Set ATLAS_ENCRYPTION_KEYS " +
        "(or ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET) to encrypt integration credentials at rest.",
    );
  }

  // ── SSRF guard for base_url_override ──────────────────────────────
  // The override becomes the operations base URL the agent later sends requests
  // to, host-side, via `executeRestOperation`. Block private/internal targets via
  // the shared chokepoint (the spec URL itself is guarded inside `probeSpec`).
  // Self-hosted operators opt OUT via ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS (#3006).
  if (baseUrlOverride) {
    try {
      assertBaseUrlAllowed(baseUrlOverride);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw FormInstallValidationError.fromZodFlatten({
          fieldErrors: {
            base_url_override: [
              "Base URL must use HTTPS and resolve to a public host — private or internal " +
                "addresses are blocked. Set ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true to allow " +
                "internal targets (self-hosted only).",
            ],
          },
          formErrors: [],
        });
      }
      throw err;
    }
  }

  // ── Probe the spec (slice-0) → snapshot ───────────────────────────
  // Some specs require the credential to read (Twenty's same-host /open-api/core);
  // others are public (the built-in candidates pin their spec to GitHub's raw CDN).
  // The probe attaches the credential ONLY when the spec host matches the resolved
  // API host (#3034): `base_url_override` if the admin supplied one, else the
  // candidate's declared `apiBaseUrl`, else unknown ⇒ withheld (fail-safe). A probe
  // failure is a user-fixable input error → 400 on `openapi_url`, not a 500.
  const auth = buildResolvedAuth(authKind, authValue, authHeaderName, authParamName);
  const resolvedApiBaseUrl = baseUrlOverride ?? apiBaseUrl;
  const probeOpts: ProbeOptions = {
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(resolvedApiBaseUrl ? { apiBaseUrl: resolvedApiBaseUrl } : {}),
  };
  // #2970: a built-in data candidate's PUBLIC spec (credential withheld — spec
  // host ≠ API host) is fetched + normalized ONCE across all workspaces. A second
  // workspace installing the same upstream pays no re-download: a fresh shared
  // entry short-circuits the network entirely, a stale one does a cheap conditional
  // GET. A plain generic install (admin-supplied URL) never shares — it probes
  // per-workspace with its credential as before. Shareability is derived from the
  // candidate's CODE-resident URLs, so config can't widen the sharing scope.
  const candidate = findDataCandidateBySlug(catalogSlug);
  const shareable =
    candidate !== undefined && isShareableSpec(candidate.openapiUrl, candidate.apiBaseUrl);
  let snapshot;
  try {
    const { doc, graph } = shareable
      ? await probeShared({
          catalogId: candidate.catalogId,
          specUrl: openapiUrl,
          ...(fetchImpl ? { fetchImpl } : {}),
        })
      : await probeSpec(openapiUrl, auth, probeOpts);
    snapshot = buildSnapshot(doc, graph, now());
  } catch (err) {
    if (err instanceof OpenApiProbeError) {
      log.warn(
        { workspaceId, catalogSlug, reason: err.reason },
        "OpenAPI install probe failed — surfacing as field validation error",
      );
      throw FormInstallValidationError.fromZodFlatten({
        fieldErrors: { openapi_url: [err.message] },
        formErrors: [],
      });
    }
    log.error(
      { workspaceId, catalogSlug, err: err instanceof Error ? err.message : String(err) },
      "OpenAPI install probe threw unexpectedly",
    );
    throw err;
  }

  // ── Assemble config + encrypt secret fields ───────────────────────
  // The `config_schema`'s `secret: true` flag drives encryption — never naming
  // `auth_value` here. Operational metadata is non-secret and passes through.
  const rawConfig: Record<string, unknown> = {
    openapi_url: openapiUrl,
    auth_kind: authKind,
    ...(authValue ? { auth_value: authValue } : {}),
    ...(authHeaderName ? { auth_header_name: authHeaderName } : {}),
    ...(authParamName ? { auth_param_name: authParamName } : {}),
    ...(baseUrlOverride ? { base_url_override: baseUrlOverride } : {}),
    ...(writeAllowlist ? { write_allowlist: writeAllowlist } : {}),
    display_name: displayName || snapshot.title,
    representation_mode: DEFAULT_REPRESENTATION_MODE,
    openapi_snapshot: snapshot,
    // First-ever discovery records a baseline (no diff) so the detail page reads
    // "Baseline recorded"; the first re-discovery overwrites it with the computed
    // drift against this snapshot (#2976).
    openapi_last_diff: baselineSpecDiffRecord(snapshot.probedAt),
  };
  const schema = parseConfigSchema(configSchema);
  const encryptedConfig = encryptSecretFields(rawConfig, schema);

  // ── Insert a fresh multi-instance datasource row ──────────────────
  // Same UUID for `id` and `install_id`. Fresh every submit (multi-instance);
  // the `(workspace_id, catalog_id, install_id)` DO UPDATE is belt-and-suspenders
  // idempotency on the never-colliding UUID. `status='draft'` (the #2177
  // convention) surfaces the pending-changes pill for atomic publish.
  const installId = newId();
  let persistedId: string;
  try {
    const rows = await internalQuery<{ id: string }>(
      `INSERT INTO workspace_plugins
         (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
       VALUES ($1, $2, $3, $1, 'datasource', $4::jsonb, true, 'draft', NOW(), NOW())
       ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
         SET config = EXCLUDED.config,
             enabled = true,
             updated_at = NOW()
       RETURNING id`,
      [installId, workspaceId, catalogId, JSON.stringify(encryptedConfig)],
    );
    const returned = rows[0]?.id;
    if (typeof returned !== "string" || returned.length === 0) {
      log.error(
        { workspaceId, catalogSlug, installId },
        "workspace_plugins upsert returned no id — Postgres invariant violation",
      );
      throw new Error(
        "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
      );
    }
    persistedId = returned;
  } catch (err) {
    log.error(
      { workspaceId, catalogSlug, installId, err: err instanceof Error ? err.message : String(err) },
      "Failed to persist OpenAPI datasource install record — aborting install",
    );
    throw err;
  }

  log.info(
    {
      workspaceId,
      catalogSlug,
      installId: persistedId,
      operationCount: snapshot.operationCount,
      specHost: safeHost(openapiUrl),
    },
    "OpenAPI datasource install completed",
  );
  return {
    installRecord: { id: persistedId, workspaceId, catalogId: catalogSlug },
    credentialWritten: authKind !== "none",
  };
}
