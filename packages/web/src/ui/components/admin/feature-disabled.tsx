"use client";

import type { LucideIcon } from "lucide-react";
import { Ban, Cloud, DatabaseZap, ServerOff, ShieldCheck, ShieldX } from "lucide-react";
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
}: {
  feature: FeatureName;
  /** Optional override for the description text (usually the server message). */
  message?: string;
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
      </div>
    </div>
  );
}

/**
 * The shared body of every {@link FeatureGate} arm: icon, headline, one line
 * of description, and — when the response carried one — the correlation id.
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
        {requestId && (
          // A gate an operator did not expect (a 403 they believe they should
          // pass, a 404 on a feature they configured) is un-diagnosable
          // without this — `ErrorBanner` has appended it to every non-gated
          // error for as long as it has existed.
          <p
            data-testid="feature-gate-request-id"
            className="mt-2 font-mono text-[11px] text-muted-foreground/70"
          >
            Request ID: {requestId}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when an admin page gets a 401/403/404/503 status.
 *
 * Evaluation order (matches code):
 * - 503 → service unavailable (internal database missing, authz outage, …)
 * - 404 → feature not enabled (enterprise config)
 * - 401 → authentication required
 * - 403 → insufficient role
 *
 * Every arm prefers the server's own `message` over its canned copy: the
 * canned line is a guess at the cause from the status alone, and the server
 * knows. The canned copy remains the fallback for an empty response body —
 * which is why callers must pass `serverMessage(err)` rather than
 * `err.message` (see that helper: the latter is `HTTP {status}` on an empty
 * body, and rendering it would replace real guidance with a status echo).
 */
export function FeatureGate({
  status,
  feature,
  message,
  requestId,
}: {
  status: 401 | 403 | 404 | 503;
  feature: FeatureName;
  /** The server's description of *this* refusal. Pass `serverMessage(err)`. */
  message?: string;
  /** Correlation id from the response body, for log lookup. */
  requestId?: string;
}) {
  if (status === 503) {
    // Missing DATABASE_URL is one cause of a 503 here; `permissions_unavailable`
    // (the authz service being down) is another, and "Internal database not
    // configured" is simply false for it. So when the server explained itself
    // the headline drops its guess too — not just the description. With no
    // message the DATABASE_URL hint stays: it is still the likeliest cause and
    // the only actionable thing we can say.
    return message ? (
      <GateBody
        icon={ServerOff}
        title={`${feature} is unavailable`}
        description={message}
        requestId={requestId}
      />
    ) : (
      <GateBody
        icon={DatabaseZap}
        title="Internal database not configured"
        description={`Set DATABASE_URL to enable ${feature}.`}
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
          message ?? "Enable this feature in your server configuration to use this page."
        }
        requestId={requestId}
      />
    );
  }

  return (
    <GateBody
      icon={ShieldX}
      title={status === 401 ? "Authentication required" : "Access denied"}
      description={
        message ??
        (status === 401
          ? "Please sign in to access the admin console."
          : "You need the admin role to access this page.")
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
 */
export function MfaRequiredPlaceholder({ feature }: { feature: FeatureName }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <ShieldCheck className="mx-auto size-10 text-primary/70" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">Two-factor required</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Enroll an authenticator app or passkey to access {feature}.
        </p>
      </div>
    </div>
  );
}
