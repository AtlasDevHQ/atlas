/**
 * `DataCandidateFormInstallHandler` — admin install flow for a built-in vendor
 * `*-data` REST datasource (v0.0.2 slice 6a, #3028; Stripe today, Notion #3029 /
 * GitHub #3030 next).
 *
 * The "thin wrapper" the slice exists to prove: this handler owns NO install
 * logic of its own. It parses a SLIM form (just the credential + optional
 * overrides — no `openapi_url`, no `auth_kind` field, because those are pre-filled
 * from the {@link DataCandidate} registry), then delegates to the SAME
 * {@link persistOpenApiDatasourceInstall} core the generic OpenAPI handler uses
 * (probe → snapshot → schema-driven encryption → multi-instance INSERT). The only
 * per-candidate inputs are the registry's `openapiUrl` / `authKind` / `catalogId`
 * / `slug` — there is no forked probe, encryption, or persistence path.
 *
 * One handler instance per candidate (constructed with its {@link DataCandidate}),
 * registered under the candidate's slug in `register.ts`. The admin installs
 * "Stripe" by pasting only their secret key — the spec URL is locked.
 */

import crypto from "crypto";
import { z } from "zod";
import type { WorkspaceId } from "@useatlas/types";
import {
  DATA_CANDIDATE_CONFIG_SCHEMA,
  type FormDataCandidate,
} from "@atlas/api/lib/openapi/data-candidates";
import { FormInstallValidationError } from "./email-form-handler";
import {
  persistOpenApiDatasourceInstall,
  type OpenApiGenericFormInstallHandlerOptions,
} from "./openapi-generic-form-handler";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

/** Defensive upper bound on the credential — guards against pathological pastes. */
const AUTH_VALUE_MAX = 8192;

/**
 * A URL's hostname, normalized for comparison: lowercased (redundant — the URL
 * parser already lowercases the hostname — but explicit) with any trailing FQDN
 * dot(s) stripped. Mirrors the egress guard's hostname normalization (see
 * `sandbox/validate.ts`) so the spec-host check below can't be slipped by an
 * equivalent fully-qualified form: WHATWG `URL.host` KEEPS the trailing dot, so
 * `raw.githubusercontent.com.` would not equal `raw.githubusercontent.com`, yet
 * DNS resolves them to the same host (Codex review, PR #3040). Compares the
 * hostname only (no port): the candidate's spec host is never a legitimate API
 * host for it on ANY port, so a port-varied form must be rejected too.
 *
 * THROWS (does not swallow) on an unparseable URL — the spec-host check is a
 * security gate, so it must fail CLOSED. A `catch { return null }` here would be
 * the "false negative on a security check" anti-pattern CLAUDE.md forbids: an
 * unparseable override would read as "no match" and slip the gate. In practice
 * neither input can throw — `base_url_override` is already validated as a
 * well-formed http(s) URL by {@link OptionalUrlSchema}, and the spec URL is a
 * static candidate-registry constant — so this is defense-in-depth: if either
 * ever became unparseable the install aborts loudly (500) rather than proceeding.
 */
function normalizedHostname(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
}

/**
 * True iff `overrideUrl` resolves to the same host as the candidate's locked
 * `specUrl` (#3039) — used to reject a `base_url_override` that re-points at the
 * candidate's spec host. Both hostnames are normalized via
 * {@link normalizedHostname} so a trailing-dot / case-varied form can't bypass
 * the gate; an unparseable URL on either side throws (fail closed), never a
 * silent "no match".
 */
function sharesHost(overrideUrl: string, specUrl: string): boolean {
  return normalizedHostname(overrideUrl) === normalizedHostname(specUrl);
}

const OptionalUrlSchema = z
  .string()
  .transform((raw) => raw.trim())
  .refine((raw) => {
    if (raw.length === 0) return true;
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      // intentionally ignored: URL-constructor throw is the negative signal.
      return false;
    }
  }, "base_url_override must be a well-formed http(s) URL")
  .optional();

/**
 * The slim candidate install form. Mirrors {@link DATA_CANDIDATE_CONFIG_SCHEMA}:
 * the admin supplies only the credential (+ optional overrides). `openapi_url` and
 * `auth_kind` are DELIBERATELY absent — pre-filled from the candidate so an
 * install can never re-point the locked spec URL or change the auth scheme.
 */
export const DataCandidateFormDataSchema = z
  .object({
    auth_value: z
      .string()
      // Trim BEFORE min/max so a whitespace-only paste (e.g. "   ") is rejected by
      // .min(1) rather than passing the length check and trimming to "" downstream.
      .trim()
      .min(1, "auth_value is required")
      .max(AUTH_VALUE_MAX, `auth_value must be ${AUTH_VALUE_MAX} characters or fewer`),
    base_url_override: OptionalUrlSchema,
    display_name: z.string().trim().max(256).optional(),
  })
  .strict();

export type DataCandidateFormData = z.infer<typeof DataCandidateFormDataSchema>;

export class DataCandidateFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly candidate: FormDataCandidate;
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(candidate: FormDataCandidate, options: OpenApiGenericFormInstallHandlerOptions = {}) {
    this.candidate = candidate;
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.fetchImpl = options.fetchImpl;
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{ readonly installRecord: InstallRecord; readonly credentialWritten: boolean }> {
    const parsed = DataCandidateFormDataSchema.safeParse(formData);
    if (!parsed.success) {
      throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
    }
    const data = parsed.data;

    // Harden the #3034 host-match credential gate (#3039). A candidate's spec URL
    // is LOCKED (raw.githubusercontent.com), and `persistOpenApiDatasourceInstall`
    // resolves the gate's API host as `baseUrlOverride ?? apiBaseUrl`. So an admin
    // who sets `base_url_override` to the candidate's OWN spec host would make
    // specHost === apiHost — re-attaching the customer credential (e.g. sk_live_…)
    // to the public spec-CDN fetch, defeating #3034 for this path. The candidate's
    // spec host is a static spec location, never a legitimate API host for it (the
    // executable API lives at `apiBaseUrl`), and an override pointed there would
    // also misroute query-time requests — so reject it outright. The generic
    // openapi-generic path has no locked spec, so this guard is candidate-only.
    if (data.base_url_override && sharesHost(data.base_url_override, this.candidate.openapiUrl)) {
      throw FormInstallValidationError.fromZodFlatten({
        fieldErrors: {
          base_url_override: [
            "Base URL override cannot point at this datasource's spec host — that is a static " +
              "spec location, not an API host. Leave it blank to use the spec's declared API " +
              "server, or set it to the real API host.",
          ],
        },
        formErrors: [],
      });
    }

    // Delegate to the shared core, pre-filling the locked spec URL + auth kind
    // from the candidate registry. No forked install logic — same probe / encrypt
    // / insert path the generic handler runs.
    return persistOpenApiDatasourceInstall({
      workspaceId,
      catalogId: this.candidate.catalogId,
      catalogSlug: this.candidate.slug,
      configSchema: DATA_CANDIDATE_CONFIG_SCHEMA,
      openapiUrl: this.candidate.openapiUrl,
      authKind: this.candidate.authKind,
      authValue: data.auth_value,
      // The candidate's real API host — gates the probe credential (#3034) so the
      // customer key never reaches the public spec host (raw.githubusercontent.com).
      apiBaseUrl: this.candidate.apiBaseUrl,
      ...(data.base_url_override ? { baseUrlOverride: data.base_url_override } : {}),
      ...(data.display_name ? { displayName: data.display_name } : {}),
      newId: this.newId,
      now: this.now,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }
}
