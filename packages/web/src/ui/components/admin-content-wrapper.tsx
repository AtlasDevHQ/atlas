"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { friendlyError, type FetchError } from "@/ui/hooks/use-admin-fetch";

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
  if (feature && !loading && error?.status && [401, 403, 404, 503].includes(error.status)) {
    // Enterprise-required errors come back as 403 but are config issues, not
    // role issues. Show them as feature-not-enabled (404 style) so the admin
    // sees "not enabled" + the actual message instead of "Access denied".
    const isEnterpriseRequired = error.status === 403 && error.message.includes("Enterprise features");
    const gateStatus = isEnterpriseRequired ? 404 : error.status;
    const gateMessage = isEnterpriseRequired ? error.message : undefined;
    return <FeatureGate status={gateStatus as 401 | 403 | 404 | 503} feature={feature} message={gateMessage} />;
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
