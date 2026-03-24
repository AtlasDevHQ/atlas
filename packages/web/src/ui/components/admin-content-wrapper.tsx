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
  feature: string;
  onRetry: () => void;
  loadingMessage?: string;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  emptyDescription?: string;
  emptyAction?: { label: string; onClick: () => void };
  hasFilters?: boolean;
  onClearFilters?: () => void;
  isEmpty: boolean;
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
  if (!loading && error?.status && [401, 403, 404, 503].includes(error.status)) {
    return <FeatureGate status={error.status as 401 | 403 | 404 | 503} feature={feature} />;
  }

  if (error) {
    return <ErrorBanner message={friendlyError(error)} onRetry={onRetry} />;
  }

  if (loading) {
    return <LoadingState message={loadingMessage} />;
  }

  if (isEmpty && !hasFilters) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  if (isEmpty && hasFilters) {
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

  return <>{children}</>;
}
