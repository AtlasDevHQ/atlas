"use client";

import { Ban, Cloud, DatabaseZap, ShieldCheck, ShieldX } from "lucide-react";
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
 * Shown when an admin page gets a 401/403/404/503 status.
 *
 * Evaluation order (matches code):
 * - 503 → internal database not configured (DATABASE_URL missing)
 * - 404 → feature not enabled (enterprise config)
 * - 401 → authentication required
 * - 403 → insufficient role
 */
export function FeatureGate({
  status,
  feature,
  message,
}: {
  status: 401 | 403 | 404 | 503;
  feature: FeatureName;
  /** Optional override for the description text. */
  message?: string;
}) {
  if (status === 503) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <DatabaseZap className="mx-auto size-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">Internal database not configured</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Set DATABASE_URL to enable {feature}.
          </p>
        </div>
      </div>
    );
  }

  if (status === 404) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Ban className="mx-auto size-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">{feature} not enabled</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {message ?? "Enable this feature in your server configuration to use this page."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <ShieldX className="mx-auto size-10 text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium">
          {status === 401 ? "Authentication required" : "Access denied"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {status === 401
            ? "Please sign in to access the admin console."
            : "You need the admin role to access this page."}
        </p>
      </div>
    </div>
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
