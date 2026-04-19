"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { EnterpriseUpsell, FeatureGate } from "@/ui/components/admin/feature-disabled";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { friendlyError, type FetchError } from "@/ui/hooks/use-admin-fetch";

/**
 * Detect an `EnterpriseError` that was serialized over HTTP.
 *
 * The API encodes the typed error as `{ error: "enterprise_required", ... }`
 * with status 403 — that code lives in `FetchError.code`. Match only on the
 * machine-readable code so unrelated 403s whose message happens to mention
 * "Enterprise features" (e.g. future billing copy) don't misroute into the
 * upsell surface.
 */
function isEnterpriseRequired(error: FetchError): boolean {
  return error.code === "enterprise_required";
}

export interface AdminContentWrapperProps {
  loading: boolean;
  error: FetchError | null;
  feature?: string;
  onRetry?: () => void;
  loadingMessage?: string;
  emptyIcon?: LucideIcon;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: { label: string; onClick: () => void };
  hasFilters?: boolean;
  onClearFilters?: () => void;
  isEmpty?: boolean;
  children: ReactNode;
}

export function AdminContentWrapper({
  loading,
  error,
  feature,
  onRetry,
  loadingMessage,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  emptyAction,
  hasFilters = false,
  onClearFilters,
  isEmpty,
  children,
}: AdminContentWrapperProps) {
  if (feature && !loading && error) {
    // Enterprise-required errors arrive as 403 + { error: "enterprise_required" }.
    // Render a distinct upsell so non-EE admins see "this feature needs an
    // enterprise plan" rather than a generic "Access denied" or error banner.
    if (isEnterpriseRequired(error)) {
      return <EnterpriseUpsell feature={feature} message={error.message} />;
    }
    if (error.status && [401, 403, 404, 503].includes(error.status)) {
      return <FeatureGate status={error.status as 401 | 403 | 404 | 503} feature={feature} />;
    }
  }

  if (error) {
    return <ErrorBanner message={friendlyError(error)} onRetry={onRetry} />;
  }

  if (loading) {
    return <LoadingState message={loadingMessage} />;
  }

  if (isEmpty && emptyIcon && emptyTitle) {
    if (hasFilters) {
      return (
        <EmptyState
          icon={Search}
          title="No matches"
          description="Try adjusting your filters."
          action={
            onClearFilters
              ? { label: "Clear filters", onClick: onClearFilters }
              : undefined
          }
        />
      );
    }
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  return <>{children}</>;
}
