/**
 * SaaS-region platform email DPA guard (#1969).
 *
 * The DPA sub-processor table on /dpa lists Resend as Atlas's email vendor.
 * That's accurate for Atlas Cloud today because the platform falls back to
 * Resend via `RESEND_API_KEY`. The risk this guard locks down is a future
 * SaaS operator flipping `ATLAS_EMAIL_PROVIDER` (or `ATLAS_SMTP_URL`) at
 * the **platform** level without amending the DPA — the customer-facing
 * sub-processor list would then be silently inaccurate.
 *
 * IMPORTANT — what this guard does NOT consider: per-org `email_installations`
 * (BYOC). When a customer brings their own SendGrid / Postmark / SMTP creds
 * for their own org, Atlas isn't a party to that vendor relationship — the
 * customer is. The DPA correctly omits BYOC vendors from Atlas's sub-processor
 * list, so the guard intentionally never reads `getEmailTransport(orgId)` or
 * any per-org row.
 *
 * Two checks, in order — both must pass for SaaS to boot:
 *
 *   1. **Stated intent** (`ATLAS_EMAIL_PROVIDER` setting). Read via
 *      `getSetting()` so that DB-cache overrides from the admin UI count
 *      alongside env vars. Compared against the literal `"resend"` —
 *      anything else (including the legitimate registry default `"resend"`)
 *      is fine. Reading the raw setting (rather than `getPlatformEmailConfig`)
 *      is deliberate: an operator who flips `ATLAS_EMAIL_PROVIDER=sendgrid`
 *      without yet pasting `SENDGRID_API_KEY` still has *stated intent* that
 *      violates the DPA. Catching that at boot prevents a later "key paste"
 *      from silently flipping traffic to a vendor not on /dpa.
 *
 *   2. **Resolved transport**. `sendEmail`'s fallback order is platform-config
 *      → `ATLAS_SMTP_URL` → `RESEND_API_KEY` → log. The DPA-safe outcomes are
 *      "platform-resend with key" and "RESEND_API_KEY fallback" — both are
 *      recognised by `hasResendKey()` (the platform Resend config reads its
 *      key via `getSetting("RESEND_API_KEY")`, which itself falls through to
 *      env). If no Resend key exists, `ATLAS_SMTP_URL` would route through
 *      an arbitrary bridge → FAIL. If nothing is configured at all, mail is
 *      silently dropped → FAIL.
 *
 * The guard is wired into `buildAppLayer` via the `Layer.effectDiscard`
 * built from `assertSaasPlatformEmailIsResendEffect`; throwing here fails
 * the boot Layer and exits the process, surfacing the misconfig before any
 * customer email is sent.
 */

import { Data } from "effect";
import { getSetting } from "@atlas/api/lib/settings";
import { EMAIL_PROVIDERS, type EmailProvider } from "@atlas/api/lib/integrations/types";

/** Resolved-transport discriminator carried by `DpaInconsistencyError`. */
export type ResolvedProvider = EmailProvider | "smtp-bridge" | "none";

/**
 * Thrown when a SaaS region's platform email transport doesn't match the
 * DPA sub-processor table. Carries the resolved provider for diagnostics.
 */
export class DpaInconsistencyError extends Data.TaggedError("DpaInconsistencyError")<{
  readonly message: string;
  readonly resolvedProvider: ResolvedProvider;
}> {}

/**
 * Injectable dependencies. `isSaas` has no default — callers must pass it
 * matching the **resolved config's** `deployMode`, not the env var. The
 * env var and the resolved value can diverge (config-file overrides, deploy
 * mode `auto`, etc.) and this guard is too important to silently no-op on
 * that mismatch.
 */
export interface DpaGuardDeps {
  isSaas: () => boolean;
  /** Stated platform provider intent — raw `ATLAS_EMAIL_PROVIDER` setting, validated against `EMAIL_PROVIDERS`. */
  getPlatformProvider: () => EmailProvider | null;
  hasSmtpUrl: () => boolean;
  hasResendKey: () => boolean;
}

const PROVIDER_SET: ReadonlySet<string> = new Set(EMAIL_PROVIDERS);

const productionDeps: Omit<DpaGuardDeps, "isSaas"> = {
  getPlatformProvider: () => {
    const raw = getSetting("ATLAS_EMAIL_PROVIDER");
    if (!raw) return null;
    if (!PROVIDER_SET.has(raw)) return null;
    return raw as EmailProvider;
  },
  hasSmtpUrl: () => Boolean(process.env.ATLAS_SMTP_URL),
  hasResendKey: () => Boolean(process.env.RESEND_API_KEY),
};

const ISSUE_REF = "#1969";

/**
 * Enforce: in SaaS deploy mode, the platform email transport must be Resend.
 * Self-hosted is unaffected — operators retain full provider freedom.
 *
 * Throws `DpaInconsistencyError` on violation. Pure / synchronous so the
 * boot Layer can short-circuit before any plugin or HTTP listener starts.
 *
 * `isSaas` is required (no default). All other deps fall back to production
 * implementations that read from the settings registry and `process.env`.
 */
export function assertSaasPlatformEmailIsResend(
  deps: { isSaas: () => boolean } & Partial<Omit<DpaGuardDeps, "isSaas">>,
): void {
  const d: DpaGuardDeps = { ...productionDeps, ...deps };

  if (!d.isSaas()) return;

  // 1. Intent check — operator-explicit non-Resend is a DPA violation
  //    even when the corresponding API key isn't pasted yet.
  const intent = d.getPlatformProvider();
  if (intent && intent !== "resend") {
    throw new DpaInconsistencyError({
      message:
        `SaaS DPA constraint violated: ATLAS_EMAIL_PROVIDER is "${intent}", ` +
        `but the /dpa sub-processor table lists only Resend. ` +
        `Either revert ATLAS_EMAIL_PROVIDER to "resend" (preferred) or amend the DPA before changing vendors. ` +
        `See ${ISSUE_REF}.`,
      resolvedProvider: intent,
    });
  }

  // 2. Transport check — having a Resend key (env or settings) means the
  //    actual sender is Resend regardless of `ATLAS_SMTP_URL` (the platform
  //    config wins over the SMTP bridge in `sendEmail`).
  if (d.hasResendKey()) return;

  // No Resend key — SMTP bridge would be the actual transport. Anything
  // could be on the other end, so the DPA can't speak to it.
  if (d.hasSmtpUrl()) {
    throw new DpaInconsistencyError({
      message:
        `SaaS DPA constraint violated: ATLAS_SMTP_URL routes to an arbitrary webhook bridge ` +
        `whose downstream vendor cannot be assumed to be Resend. ` +
        `Set RESEND_API_KEY in addition (so platform config takes precedence) or remove ATLAS_SMTP_URL. ` +
        `See ${ISSUE_REF}.`,
      resolvedProvider: "smtp-bridge",
    });
  }

  // No transport at all — Atlas-originated mail (password reset, etc.)
  // would silently drop. Fail boot to surface the misconfig.
  throw new DpaInconsistencyError({
    message:
      `SaaS region has no platform email transport configured. ` +
      `Set RESEND_API_KEY (matches the /dpa sub-processor table). ` +
      `Per-org BYOC email installations don't satisfy this requirement — Atlas-originated mail ` +
      `(e.g. /forgot-password before a session exists) needs a platform-level transport. ` +
      `See ${ISSUE_REF}.`,
    resolvedProvider: "none",
  });
}
