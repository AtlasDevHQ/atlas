"use client";

import { useState, useEffect } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { SSOProviderSummary } from "./sso-types";

interface DeleteProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: SSOProviderSummary | null;
  /** True when this is the last enabled provider and SSO enforcement is active. */
  isLastEnabledWithEnforcement: boolean;
}

export function DeleteProviderDialog({
  open,
  onOpenChange,
  provider,
  isLastEnabledWithEnforcement,
}: DeleteProviderDialogProps) {
  const [confirmDomain, setConfirmDomain] = useState("");

  const { mutate: deleteProvider, saving, error: deleteError, clearError, reset: resetMutation } = useAdminMutation({
    method: "DELETE",
  });

  const { mutate: disableEnforcement, error: enforcementError } = useAdminMutation({
    path: "/api/v1/admin/sso/enforcement",
    method: "PUT",
  });

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setConfirmDomain("");
      resetMutation();
    }
  }, [open]);

  const domainMatches = provider
    ? confirmDomain.toLowerCase() === provider.domain.toLowerCase()
    : false;

  async function handleDelete() {
    if (!provider || !domainMatches) return;
    clearError();

    // If last enabled provider with enforcement, disable enforcement first
    if (isLastEnabledWithEnforcement) {
      const enfResult = await disableEnforcement({ body: { enforced: false } });
      if (!enfResult.ok) {
        // Enforcement disable failed — don't proceed with delete
        return;
      }
    }

    const result = await deleteProvider({
      path: `/api/v1/admin/sso/providers/${provider.id}`,
    });

    if (result.ok) {
      onOpenChange(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete SSO Provider</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently remove the SSO provider and all associated configuration.
            Users authenticating via this provider will need to use password login.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {(deleteError ?? enforcementError) && (
          <ErrorBanner message={deleteError ?? enforcementError ?? ""} onRetry={clearError} />
        )}

        {/* Provider details */}
        {provider && (
        <div className="rounded-md border px-4 py-3 space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px] uppercase font-mono">
              {provider.type}
            </Badge>
            <span className="text-sm font-semibold">{provider.domain}</span>
          </div>
          <p className="text-xs text-muted-foreground truncate">{provider.issuer}</p>
        </div>
        )}

        {/* Enforcement warning */}
        {isLastEnabledWithEnforcement && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
            <p className="text-sm text-red-700 dark:text-red-300">
              This is the last enabled provider and SSO enforcement is active.
              Deleting it will automatically disable enforcement, allowing password login for all members.
            </p>
          </div>
        )}

        {/* Domain confirmation */}
        {provider && (
        <div className="space-y-2">
          <p className="text-sm">
            Type <strong>{provider.domain}</strong> to confirm deletion:
          </p>
          <Input
            value={confirmDomain}
            onChange={(e) => setConfirmDomain(e.target.value)}
            placeholder={provider.domain}
            autoComplete="off"
          />
        </div>
        )}

        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!domainMatches || saving}
          >
            {saving && <Loader2 className="size-3 animate-spin" />}
            Delete Provider
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
