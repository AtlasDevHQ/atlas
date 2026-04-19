"use client";

import { ErrorBanner } from "@/ui/components/admin/error-banner";
import {
  EnterpriseUpsell,
  FeatureGate,
} from "@/ui/components/admin/feature-disabled";
import { InlineError } from "@/ui/components/admin/compact";
import { friendlyError, type FetchError } from "@/ui/lib/fetch-error";

type Variant = "banner" | "inline";

export interface MutationErrorSurfaceProps {
  /** Structured error from `useAdminMutation().error`, or null to render nothing. */
  error: FetchError | null;
  /** Feature name used in EnterpriseUpsell / FeatureGate copy (e.g. "SSO", "SCIM"). */
  feature: string;
  /** Visual treatment — banner (default) mirrors ErrorBanner, inline mirrors InlineError. */
  variant?: Variant;
  /** Banner-only: wires the ErrorBanner retry button (usually a `clearError` callback). */
  onRetry?: () => void;
  /** Inline-only: bold prefix rendered before the message (e.g. "Save failed."). */
  inlinePrefix?: string;
}

/**
 * Write-path counterpart to `AdminContentWrapper`'s read-path feature-gate
 * routing. Mutation errors carry the same `FetchError` shape from
 * `useAdminMutation`, so a 403 + `code: "enterprise_required"` from POSTing
 * `/api/v1/admin/sso/enforcement` deserves the same `EnterpriseUpsell` the
 * GET would have triggered. Callers that previously wrote
 * `<ErrorBanner message={friendlyError(mutation.error)} />` flattened the
 * structured code into a string and lost the routing.
 *
 * Decision tree (banner variant — default):
 * - `null` → nothing
 * - `code === "enterprise_required"` → `EnterpriseUpsell` with server message
 * - `status` in {401, 403, 404, 503} → `FeatureGate`
 * - else → `ErrorBanner` with `friendlyError` copy
 *
 * Inline variant is for sites that can't host a full-page upsell (compact
 * rows, dialog bodies):
 * - `code === "enterprise_required"` → condensed `InlineError` with the
 *   same enterprise link, preserving the routing win without breaking
 *   the row's layout
 * - else → `InlineError` with optional bold prefix + friendly message
 *
 * Inline variant doesn't route the other 401/403/404/503 statuses through
 * `FeatureGate` — a full-page gate replacing a tiny inline error slot would
 * be more disruptive than useful, and the page-level `AdminContentWrapper`
 * already handles those on refresh.
 */
export function MutationErrorSurface({
  error,
  feature,
  variant = "banner",
  onRetry,
  inlinePrefix,
}: MutationErrorSurfaceProps) {
  if (!error) return null;

  const isEnterpriseRequired = error.code === "enterprise_required";

  if (variant === "inline") {
    if (isEnterpriseRequired) {
      return (
        <InlineError>
          <span className="font-semibold">
            {feature} requires Enterprise.
          </span>{" "}
          <a
            href="https://www.useatlas.dev/enterprise"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            Learn more
          </a>
        </InlineError>
      );
    }
    return (
      <InlineError>
        {inlinePrefix && (
          <>
            <span className="font-semibold">{inlinePrefix}</span>{" "}
          </>
        )}
        {friendlyError(error)}
      </InlineError>
    );
  }

  if (isEnterpriseRequired) {
    return <EnterpriseUpsell feature={feature} message={error.message} />;
  }

  if (error.status && [401, 403, 404, 503].includes(error.status)) {
    return (
      <FeatureGate
        status={error.status as 401 | 403 | 404 | 503}
        feature={feature}
      />
    );
  }

  return <ErrorBanner message={friendlyError(error)} onRetry={onRetry} />;
}
