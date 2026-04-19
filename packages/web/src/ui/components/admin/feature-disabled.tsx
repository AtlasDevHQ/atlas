"use client";

import { Ban, DatabaseZap, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Dedicated upsell shown when an admin page returns an
 * `enterprise_required` error (403 + `{ error: "enterprise_required" }`).
 *
 * Distinct from the generic `FeatureGate` 403 ("Access denied") so non-EE
 * admins see "this feature needs an enterprise plan" with a concrete next
 * step, rather than assuming their account lacks a role.
 */
export function EnterpriseUpsell({
  feature,
  message,
}: {
  feature: string;
  /** Optional override for the description text (usually the server message). */
  message?: string;
}) {
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
  feature: string;
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
