"use client";

import Link from "next/link";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { BillingStatusSchema } from "@/ui/lib/admin-schemas";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { Button } from "@/components/ui/button";
import {
  CompactRow,
  SectionHeading,
} from "@/ui/components/admin/compact";
import { Cpu, Lock, XCircle } from "lucide-react";
import { ModelProviderSection } from "@/ui/components/admin/model-provider-section";

// Partial by design — unknown model IDs fall back to the raw string so that
// a new platform model ships without a UI change. Keep in sync with
// `MODEL_OPTIONS` in `packages/web/src/app/admin/billing/page.tsx` only for
// the models you want humanized here. New entries should be added in both
// places at the same time.
const PLATFORM_MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "anthropic/claude-haiku-4.5": "Haiku 4.5",
  "anthropic/claude-sonnet-4.6": "Sonnet 4.6",
  "anthropic/claude-opus-4.6": "Opus 4.6",
  "anthropic/claude-opus-4.7": "Opus 4.7",
};

function platformModelLabel(value: string): string {
  return PLATFORM_MODEL_LABELS[value] ?? value;
}

export default function ModelConfigPage() {
  const { data: billing, error: billingError, refetch: refetchBilling } = useAdminFetch(
    "/api/v1/billing",
    { schema: BillingStatusSchema },
  );
  const billingMissing = billingError?.status === 404;
  // Distinguish a real upstream failure from the self-hosted no-billing case
  // so the platform-baseline row doesn't render a default-string fallback as
  // if billing had returned successfully — that would hide a 500/network
  // failure behind "Platform default" copy.
  const billingFailed = !!billingError && !billingMissing;
  const platformModel = billing?.currentModel ?? billing?.plan.defaultModel ?? null;
  // Free-tier workspaces with no ATLAS_MODEL setting fall through to the
  // `"user-configured"` placeholder from `plans.ts`. Render an actionable CTA
  // instead of leaking the placeholder string into the title.
  const freeTierUnconfigured =
    billing?.plan.tier === "free" && platformModel === "user-configured";

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">AI Provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Atlas routes every chat through the platform default model. Bring your own provider —
          Anthropic, OpenAI, Azure OpenAI, an OpenAI-compatible endpoint, or the Vercel AI Gateway
          catalog — to run requests against your own credentials or pick any gateway model on
          platform credits.
        </p>
      </div>

      <ErrorBoundary>
        <div className="mx-auto max-w-3xl space-y-8">
          <section>
            <SectionHeading
              title="Platform baseline"
              description="Shared Atlas default. Used when this workspace has no override."
            />
            {billingFailed ? (
              <CompactRow
                icon={XCircle}
                title="Can't load platform baseline"
                description={
                  billingError?.message ??
                  "Billing is temporarily unreachable. Retry, or try again shortly."
                }
                status="unavailable"
                action={
                  <Button type="button" size="sm" variant="outline" onClick={() => refetchBilling()}>
                    Retry
                  </Button>
                }
              />
            ) : freeTierUnconfigured ? (
              <CompactRow
                icon={Cpu}
                title="No default model configured"
                description="Set ATLAS_MODEL in your environment or pick a model below."
                status="disconnected"
              />
            ) : (
              <CompactRow
                icon={Cpu}
                title={platformModel ? platformModelLabel(platformModel) : "Platform default"}
                description={
                  billingMissing
                    ? "Managed via ATLAS_PROVIDER and ATLAS_MODEL settings."
                    : platformModel
                      ? `Every chat routes through ${platformModel} unless this workspace overrides it.`
                      : "Every chat routes through the platform default unless this workspace overrides it."
                }
                status="disconnected"
                action={
                  billingMissing ? (
                    <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      <Lock className="size-3" />
                      Locked
                    </span>
                  ) : (
                    <Link
                      href="/admin/billing"
                      className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
                    >
                      <Lock className="size-3" />
                      Managed on billing
                    </Link>
                  )
                }
              />
            )}
          </section>

          <section>
            <SectionHeading
              title="Workspace override"
              description="Your provider credentials. Applies to this workspace only."
            />
            <ModelProviderSection />
          </section>
        </div>
      </ErrorBoundary>
    </div>
  );
}
