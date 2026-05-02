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
 * Resolution order (mirrors `sendEmail` paths #2–#4 only):
 *   1. Platform settings registry — must resolve to "resend".
 *   2. `ATLAS_SMTP_URL` env webhook — FAIL (could route anywhere).
 *   3. `RESEND_API_KEY` env-var fallback — OK (Resend by name).
 *   4. None of the above — FAIL (SaaS region with no transport is its own bug).
 *
 * The guard is wired into `buildAppLayer` via `DpaGuardLive`; throwing here
 * fails the boot Layer and exits the process, surfacing the misconfig before
 * any customer email is sent.
 */

import { Data } from "effect";
import { getPlatformEmailConfig } from "./delivery";

/**
 * Thrown when a SaaS region's platform email transport doesn't match the
 * DPA sub-processor table. Carries the resolved provider for diagnostics.
 */
export class DpaInconsistencyError extends Data.TaggedError("DpaInconsistencyError")<{
  readonly message: string;
  readonly resolvedProvider: string;
}> {}

/** Injectable dependencies — defaults read from process.env + the settings registry. */
export interface DpaGuardDeps {
  isSaas: () => boolean;
  /** Resolved platform email provider name, or null if no platform config is active. */
  getPlatformProvider: () => string | null;
  hasSmtpUrl: () => boolean;
  hasResendKey: () => boolean;
}

const defaultDeps: DpaGuardDeps = {
  isSaas: () => process.env.ATLAS_DEPLOY_MODE === "saas",
  getPlatformProvider: () => getPlatformEmailConfig()?.provider ?? null,
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
 */
export function assertSaasPlatformEmailIsResend(
  overrides: Partial<DpaGuardDeps> = {},
): void {
  const d: DpaGuardDeps = { ...defaultDeps, ...overrides };

  if (!d.isSaas()) return;

  const platformProvider = d.getPlatformProvider();
  if (platformProvider) {
    if (platformProvider !== "resend") {
      throw new DpaInconsistencyError({
        message:
          `SaaS DPA constraint violated: platform email provider resolved to "${platformProvider}", ` +
          `but the /dpa sub-processor table lists only Resend. ` +
          `Either revert ATLAS_EMAIL_PROVIDER to "resend" (preferred) or amend the DPA before changing vendors. ` +
          `See ${ISSUE_REF}.`,
        resolvedProvider: platformProvider,
      });
    }
    return;
  }

  if (d.hasSmtpUrl()) {
    throw new DpaInconsistencyError({
      message:
        `SaaS DPA constraint violated: ATLAS_SMTP_URL routes to an arbitrary webhook bridge ` +
        `whose downstream vendor cannot be assumed to be Resend. ` +
        `Remove ATLAS_SMTP_URL in SaaS regions, or amend the DPA to list the bridge's vendor. ` +
        `See ${ISSUE_REF}.`,
      resolvedProvider: "smtp-bridge",
    });
  }

  if (d.hasResendKey()) return;

  throw new DpaInconsistencyError({
    message:
      `SaaS region has no platform email transport configured. ` +
      `Set RESEND_API_KEY (matches the /dpa sub-processor table) or configure ATLAS_EMAIL_PROVIDER=resend. ` +
      `Per-org BYOC email installations don't satisfy this requirement — Atlas-originated mail ` +
      `(e.g. /forgot-password before a session exists) needs a platform-level transport. ` +
      `See ${ISSUE_REF}.`,
    resolvedProvider: "none",
  });
}
