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
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import { encryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { assertBaseUrlAllowed, EgressBlockedError } from "@atlas/api/lib/openapi/egress-guard";
import type { WorkspaceId } from "@useatlas/types";
import {
  OPENAPI_GENERIC_SLUG,
  OPENAPI_GENERIC_CATALOG_ID,
  OPENAPI_GENERIC_CONFIG_SCHEMA,
  OPENAPI_AUTH_KINDS,
  OPENAPI_SUPPORTED_AUTH_KINDS,
  DEFAULT_REPRESENTATION_MODE,
  narrowSupportedAuthKind,
} from "@atlas/api/lib/openapi/catalog";
import {
  buildResolvedAuth,
  probeSpec,
  buildSnapshot,
  OpenApiProbeError,
  type ProbeOptions,
} from "@atlas/api/lib/openapi/probe";
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

    // ── 2. SaaS keyset gate ─────────────────────────────────────────
    if (process.env.ATLAS_DEPLOY_MODE === "saas" && !getEncryptionKeyset()) {
      log.error(
        { workspaceId },
        "Refusing form install: SaaS mode + no encryption keyset (would persist plaintext auth_value)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. " +
          "Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

    // ── 2b. SSRF guard for base_url_override ────────────────────────
    // The override becomes the operations base URL the agent later sends requests
    // to, host-side, via `executeRestOperation`. It's admin-supplied, so block
    // private/internal targets via the shared chokepoint (the spec URL itself is
    // guarded inside `probeSpec`). The guard is ON in every deploy mode;
    // self-hosted operators opt OUT via ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS (#3006).
    if (data.base_url_override) {
      try {
        assertBaseUrlAllowed(data.base_url_override);
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

    // ── 3. Probe the spec (slice-0) → snapshot ──────────────────────
    // The credential is needed because some specs (Twenty) require auth to read
    // `/open-api/core`. A probe failure is a user-fixable input error → 400 on
    // the offending field, not a 500.
    //
    // `data.auth_kind` is guaranteed non-oauth2 here (the schema's superRefine
    // fails the parse for oauth2 above); narrow to SupportedAuthKind so
    // buildResolvedAuth is called total. The `null` arm is unreachable.
    const supportedKind = narrowSupportedAuthKind(data.auth_kind);
    if (!supportedKind) {
      throw FormInstallValidationError.fromZodFlatten({
        fieldErrors: {
          auth_kind: [`"${data.auth_kind}" auth is not supported yet (coming in a later release).`],
        },
        formErrors: [],
      });
    }
    const auth = buildResolvedAuth(
      supportedKind,
      data.auth_value,
      data.auth_header_name,
      data.auth_param_name,
    );
    const probeOpts: ProbeOptions = this.fetchImpl ? { fetchImpl: this.fetchImpl } : {};
    let snapshot;
    try {
      const { doc, graph } = await probeSpec(data.openapi_url, auth, probeOpts);
      snapshot = buildSnapshot(doc, graph, this.now());
    } catch (err) {
      if (err instanceof OpenApiProbeError) {
        log.warn(
          { workspaceId, reason: err.reason },
          "OpenAPI install probe failed — surfacing as field validation error",
        );
        // Point the modal at openapi_url for every probe failure class
        // (unreachable / http_error / unparseable / no_operations) — the spec
        // URL is the field the admin can act on; the message carries the detail.
        throw FormInstallValidationError.fromZodFlatten({
          fieldErrors: { openapi_url: [err.message] },
          formErrors: [],
        });
      }
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "OpenAPI install probe threw unexpectedly",
      );
      throw err;
    }

    // ── 4. Assemble config + encrypt secret fields ──────────────────
    // The catalog `config_schema`'s `secret: true` flag drives encryption — we
    // never name `auth_value` explicitly here. Operational metadata
    // (representation_mode, openapi_snapshot) is non-secret and passes through.
    const rawConfig: Record<string, unknown> = {
      openapi_url: data.openapi_url,
      auth_kind: data.auth_kind,
      ...(data.auth_value ? { auth_value: data.auth_value } : {}),
      ...(data.auth_header_name ? { auth_header_name: data.auth_header_name } : {}),
      ...(data.auth_param_name ? { auth_param_name: data.auth_param_name } : {}),
      ...(data.base_url_override ? { base_url_override: data.base_url_override } : {}),
      ...(data.write_allowlist ? { write_allowlist: data.write_allowlist } : {}),
      display_name: data.display_name || snapshot.title,
      representation_mode: DEFAULT_REPRESENTATION_MODE,
      openapi_snapshot: snapshot,
    };
    const schema = parseConfigSchema(OPENAPI_GENERIC_CONFIG_SCHEMA);
    const encryptedConfig = encryptSecretFields(rawConfig, schema);

    // ── 5. Insert a fresh multi-instance datasource row ─────────────
    // Same UUID for `id` and `install_id` (mirrors the Twenty handler). Fresh
    // every submit — multi-instance, so no `(workspace_id, catalog_id)`
    // conflict. The `(workspace_id, catalog_id, install_id)` DO UPDATE is
    // belt-and-suspenders idempotency on the UUID (which never collides).
    // `status='draft'` matches the SQL-connection convention (#2177): the
    // pending-changes pill surfaces it and the admin publishes atomically.
    const installId = this.newId();
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
        [installId, workspaceId, OPENAPI_GENERIC_CATALOG_ID, JSON.stringify(encryptedConfig)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        log.error(
          { workspaceId, installId },
          "workspace_plugins upsert returned no id — Postgres invariant violation",
        );
        throw new Error(
          "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
        );
      }
      persistedId = returned;
    } catch (err) {
      log.error(
        { workspaceId, installId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist OpenAPI datasource install record — aborting install",
      );
      throw err;
    }

    log.info(
      {
        workspaceId,
        installId: persistedId,
        operationCount: snapshot.operationCount,
        specHost: safeHost(data.openapi_url),
      },
      "OpenAPI generic datasource install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: OPENAPI_GENERIC_SLUG },
      credentialWritten: data.auth_kind !== "none",
    };
  }
}

/** Best-effort host extraction for log breadcrumbs — never throws, never leaks the path. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // intentionally ignored: log breadcrumb only — the URL was already
    // validated by the zod refine above.
    return "<unparseable>";
  }
}
