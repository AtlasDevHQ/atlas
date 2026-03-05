"use client";

import { Ban, ShieldX } from "lucide-react";

/**
 * Shown when an admin page gets a 403 (no admin role) or 404 (feature not enabled).
 */
export function FeatureGate({
  status,
  feature,
}: {
  status: 401 | 403 | 404;
  feature: string;
}) {
  if (status === 404) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Ban className="mx-auto size-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">{feature} not enabled</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Enable this feature in your server configuration to use this page.
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
