"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ShieldCheck,
  ShieldAlert,
  Clock,
  ChevronDown,
  Copy,
  Check,
  Pencil,
  Trash2,
  RefreshCw,
  Loader2,
} from "lucide-react";
import type { SSOProviderSummary } from "./sso-types";

interface ProviderCardProps {
  provider: SSOProviderSummary;
  onEdit: (provider: SSOProviderSummary) => void;
  onDelete: (provider: SSOProviderSummary) => void;
  onToggleEnabled: (provider: SSOProviderSummary, enabled: boolean) => void;
  onVerifyDomain: (provider: SSOProviderSummary) => void;
  isToggling: boolean;
  isVerifying: boolean;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.debug("Clipboard write failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={handleCopy}
      className="h-6 gap-1 text-muted-foreground"
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function VerificationBadge({ status }: { status: "pending" | "verified" | "failed" }) {
  switch (status) {
    case "verified":
      return (
        <Badge variant="default" className="gap-1 bg-emerald-600 text-[10px] hover:bg-emerald-600">
          <ShieldCheck className="size-3" />
          Verified
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="gap-1 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400">
          <Clock className="size-3" />
          Pending
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="gap-1 border-red-500/50 text-[10px] text-red-600 dark:text-red-400">
          <ShieldAlert className="size-3" />
          Failed
        </Badge>
      );
  }
}

export function ProviderCard({
  provider,
  onEdit,
  onDelete,
  onToggleEnabled,
  onVerifyDomain,
  isToggling,
  isVerifying,
}: ProviderCardProps) {
  const [spExpanded, setSpExpanded] = useState(false);
  const domainVerified = provider.domainVerificationStatus === "verified";

  // SP Metadata — Entity ID and ACS URL are derived from the app's base URL
  const spEntityId = `${typeof window !== "undefined" ? window.location.origin : ""}/api/auth/sso/${provider.type}/entity-id/${provider.id}`;
  const spAcsUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/api/auth/sso/${provider.type}/callback/${provider.id}`;

  return (
    <div className="rounded-lg border bg-card">
      {/* Main card content */}
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-2">
          {/* Type + Domain + Verification */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-[10px] uppercase font-mono">
              {provider.type}
            </Badge>
            <span className="text-sm font-semibold">{provider.domain}</span>
            <VerificationBadge status={provider.domainVerificationStatus} />
          </div>

          {/* Issuer */}
          <p className="truncate text-xs text-muted-foreground">
            {provider.issuer}
          </p>

          {/* DNS TXT record for pending/failed */}
          {!domainVerified && provider.verificationToken && (
            <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2">
              <code className="flex-1 truncate text-xs font-mono text-muted-foreground">
                TXT _atlas-verify.{provider.domain} = {provider.verificationToken}
              </code>
              <CopyButton
                value={provider.verificationToken}
                label="verification token"
              />
            </div>
          )}
        </div>

        {/* Right side controls */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Verify Domain button (only when not verified) */}
          {!domainVerified && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onVerifyDomain(provider)}
              disabled={isVerifying}
            >
              {isVerifying ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Verify
            </Button>
          )}

          {/* Enable/Disable toggle */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Switch
                    checked={provider.enabled}
                    onCheckedChange={(checked) => onToggleEnabled(provider, checked)}
                    disabled={isToggling || (!domainVerified && !provider.enabled)}
                    aria-label={provider.enabled ? "Disable provider" : "Enable provider"}
                  />
                </div>
              </TooltipTrigger>
              {!domainVerified && !provider.enabled && (
                <TooltipContent>
                  <p>Verify domain ownership before enabling this provider</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          {/* Edit + Delete */}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onEdit(provider)}
            aria-label="Edit provider"
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onDelete(provider)}
            className="text-destructive hover:text-destructive"
            aria-label="Delete provider"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      {/* SP Metadata collapsible */}
      {provider.type === "saml" && (
        <Collapsible open={spExpanded} onOpenChange={setSpExpanded}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-1 border-t px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50",
                spExpanded && "bg-muted/30",
              )}
            >
              <ChevronDown
                className={cn("size-3 transition-transform", spExpanded && "rotate-180")}
              />
              SP Metadata
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-2 border-t px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Entity ID</p>
                  <p className="truncate text-xs font-mono">{spEntityId}</p>
                </div>
                <CopyButton value={spEntityId} label="Entity ID" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">ACS URL</p>
                  <p className="truncate text-xs font-mono">{spAcsUrl}</p>
                </div>
                <CopyButton value={spAcsUrl} label="ACS URL" />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
