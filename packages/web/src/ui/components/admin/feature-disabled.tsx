"use client";

import type { LucideIcon } from "lucide-react";
import { Ban, Cloud, ServerOff, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  isSaasExclusiveFeature,
  type FeatureName,
} from "@/ui/components/admin/feature-registry";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";

/**
 * Dedicated upsell shown when an admin page returns an
 * `enterprise_required` error (403 + `{ error: "enterprise_required" }`).
 *
 * Distinct from the generic `FeatureGate` 403 ("Access denied") so non-EE
 * admins see "this feature needs an enterprise plan" with a concrete next
 * step, rather than assuming their account lacks a role.
 *
 * Hosted-SaaS-only features (e.g. proactive monitoring, #3999) reuse the same
 * `enterprise_required` envelope but are denied on every self-hosted
 * deployment *including self-hosted enterprise* — no plan upgrade unlocks them
 * locally. On self-hosted we therefore swap to hosted-only copy + an Atlas
 * Cloud CTA instead of the "upgrade / contact sales" line, which would be
 * misleading there. (On SaaS the denial is a real per-tier gate, so the
 * upgrade copy stays.) Deploy mode here is a cosmetic-only branch, so
 * rendering from `useDeployMode`'s hostname guess before the settings fetch
 * resolves is acceptable per its contract.
 */
export function EnterpriseUpsell({
  feature,
  message,
  requestId,
}: {
  feature: FeatureName;
  /** The server's description of this refusal. Pass `serverMessage(err)`. */
  message?: string;
  /** Correlation id from the response body, for log lookup. */
  requestId?: string;
}) {
  // Only SaaS-exclusive features need the authoritative deploy mode; for every
  // other feature `hostedOnly` is false regardless, so skip the settings fetch
  // (`enabled: false` → host guess, which we then ignore).
  const isSaasExclusive = isSaasExclusiveFeature(feature);
  const { deployMode } = useDeployMode({ enabled: isSaasExclusive });
  const hostedOnly = isSaasExclusive && deployMode === "self-hosted";

  if (hostedOnly) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center">
          <Cloud className="mx-auto size-10 text-primary/70" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium">
            {feature} is an Atlas Cloud feature
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {message ||
              `${feature} is available only on Atlas Cloud (the hosted SaaS) and can't be enabled on a self-hosted deployment.`}
          </p>
          <div className="mt-4 flex justify-center">
            <Button asChild size="sm" variant="outline">
              <a
                href="https://www.useatlas.dev"
                target="_blank"
                rel="noreferrer noopener"
              >
                Learn about Atlas Cloud
              </a>
            </Button>
          </div>
          <GateRequestId requestId={requestId} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <ShieldCheck
          className="mx-auto size-10 text-primary/70"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm font-medium">
          {feature} requires an enterprise plan
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {message ||
            `${feature} is part of Atlas Enterprise. Upgrade your plan or contact sales to enable it for your workspace.`}
        </p>
        <div className="mt-4 flex justify-center">
          <Button asChild size="sm" variant="outline">
            <a
              href="https://www.useatlas.dev/enterprise"
              target="_blank"
              rel="noreferrer noopener"
            >
              Learn about Atlas Enterprise
            </a>
          </Button>
        </div>
        <GateRequestId requestId={requestId} />
      </div>
    </div>
  );
}

/**
 * The statuses that route to {@link FeatureGate} rather than a red error
 * banner: a refusal the operator is meant to act on, not a fault.
 *
 * One definition, because the set was previously written out at each call
 * site next to an `as 401 | 403 | 404 | 503` cast that TypeScript was told to
 * trust. Widening the union without touching every `includes` list compiled
 * and silently gated nothing new. `isGateStatus` narrows, so the casts are
 * gone and the two can no longer disagree.
 */
export const GATE_STATUSES = [401, 403, 404, 503] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export function isGateStatus(status: number | undefined): status is GateStatus {
  return status !== undefined && (GATE_STATUSES as readonly number[]).includes(status);
}

/**
 * The correlation id, rendered under whichever gated placeholder is showing.
 *
 * A gate an operator did not expect — a 403 they believe they should pass, a
 * 404 on a feature they configured, an entitlement that should be live — is
 * un-diagnosable without this, and `ErrorBanner` has appended it to every
 * *non*-gated error for as long as it has existed. All three placeholders on
 * the gated path render it (#5068), so which branch an operator lands on
 * never decides whether they get a log handle.
 */
export function GateRequestId({ requestId }: { requestId?: string }) {
  if (!requestId) return null;
  return (
    <p
      data-testid="feature-gate-request-id"
      className="mt-2 font-mono text-[11px] text-muted-foreground/70"
    >
      Request ID: {requestId}
    </p>
  );
}

/**
 * The shared body of every {@link FeatureGate} arm: icon, headline, one line
 * of description, and the correlation id.
 *
 * Extracted so the id renders identically on all four statuses. Before #5068
 * each arm was its own copy of this markup and the id had nowhere to go.
 */
function GateBody({
  icon: Icon,
  title,
  description,
  requestId,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  requestId?: string;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-sm text-center">
        <Icon className="mx-auto size-10 text-muted-foreground/50" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        <GateRequestId requestId={requestId} />
      </div>
    </div>
  );
}

/**
 * Shown when an admin page gets a 401/403/404/503 status.
 *
 * Evaluation order (matches code):
 * - 503 → unavailable (authz outage, billing check, restarting service, …)
 * - 404 → feature not enabled (enterprise config, no internal database)
 * - 401 → authentication required
 * - 403 → insufficient role
 *
 * Each arm prefers the server's own `message` over its canned copy, because
 * the canned line is a guess at the cause from the status alone and the
 * server knows. The canned copy is the fallback for an empty response body —
 * which is why callers must pass `serverMessage(err)` and never `err.message`
 * (see that helper: the latter is a synthesized placeholder on an empty body,
 * and rendering it replaces real guidance with a status echo).
 *
 * 401 is the exception: its canned line is the *affordance*, not a guess, so
 * the server's message is appended to it rather than displacing it.
 *
 * ⚠️ This makes the `message` field of every gated 401/403/404/503 response
 * user-facing prose on ~60 admin pages. It was rendered nowhere before #5068.
 * A route that interpolates a driver error, a connection string, or a caught
 * `err.message` into a gated status now puts it on an admin's screen — see
 * CLAUDE.md § "No secrets in responses".
 */
export function FeatureGate({
  status,
  feature,
  message,
  requestId,
}: {
  status: GateStatus;
  feature: FeatureName;
  /** The server's description of *this* refusal. Pass `serverMessage(err)`. */
  message?: string;
  /** Correlation id from the response body, for log lookup. */
  requestId?: string;
}) {
  if (status === 503) {
    // This arm used to assert one cause — "Internal database not configured /
    // Set DATABASE_URL" — on every 503. No route emits that: a missing
    // internal DB answers 404 `not_available` (`requireOrgContext`), and the
    // 503s that exist are things like `permissions_unavailable`, an authz
    // outage the database line is simply false for. (The stale `503:
    // "Internal database not configured"` entries in several routers'
    // OpenAPI blocks describe handlers that return 404.)
    //
    // What actually reaches the no-message branch is an infrastructure 503
    // with an HTML body — a restarting service, an unhealthy proxy — where
    // `extractFetchError` finds no message at all. Sending that operator to
    // set a variable which is already set is the misdirection, not the
    // absence of a guess.
    return (
      <GateBody
        icon={ServerOff}
        title={`${feature} is unavailable`}
        description={
          message ||
          "The server returned 503 with no explanation — it may be restarting or behind an unhealthy proxy. Retry in a moment; if it persists, check the API service logs."
        }
        requestId={requestId}
      />
    );
  }

  if (status === 404) {
    return (
      <GateBody
        icon={Ban}
        title={`${feature} not enabled`}
        description={
          message || "Enable this feature in your server configuration to use this page."
        }
        requestId={requestId}
      />
    );
  }

  const SIGN_IN = "Please sign in to access the admin console.";
  return (
    <GateBody
      icon={ShieldX}
      title={status === 401 ? "Authentication required" : "Access denied"}
      description={
        status === 401
          ? // 401 is the one status whose canned line is not a guess at the
            // cause but the *affordance* — it stays true whatever the server
            // said, so it is appended rather than displaced. Otherwise a
            // server that answers "No user ID in session." leaves the user
            // with an accurate diagnosis and no next step.
            message
            ? `${message} ${SIGN_IN}`
            : SIGN_IN
          : message || "You need the admin role to access this page."
      }
      requestId={requestId}
    />
  );
}

/**
 * Inline placeholder shown when an admin page fetch returns 403 with
 * `error: "mfa_enrollment_required"` (#2486). Without this carve-out the
 * generic FeatureGate would render "You need the admin role to access
 * this page." — which is misleading copy for an MFA-not-yet-enrolled
 * admin (the role check passed; only the second-factor check failed).
 *
 * On most routes the admin layout's full-screen gate covers this
 * placeholder before the user sees it; the inline copy is the carve-out
 * for the enrollment page itself (`/admin/account-security`), which the
 * layout intentionally leaves un-gated so the user can finish setup.
 *
 * The copy stays fixed on purpose — the server's 403 message is the generic
 * two-factor line and the enrollment CTA is the whole value here, so #5068's
 * "prefer the server's words" does NOT apply. The correlation id does: an
 * admin who *has* enrolled and still hits this needs something to hand an
 * operator.
 */
export function MfaRequiredPlaceholder({
  feature,
  requestId,
}: {
  feature: FeatureName;
  /** Correlation id from the response body, for log lookup. */
  requestId?: string;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-sm text-center">
        <ShieldCheck className="mx-auto size-10 text-primary/70" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">Two-factor required</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Enroll an authenticator app or passkey to access {feature}.
        </p>
        <GateRequestId requestId={requestId} />
      </div>
    </div>
  );
}
