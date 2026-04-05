"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Share2, Copy, Check, Link2Off, Globe, Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import type { ShareMode, ShareExpiryKey } from "@/ui/lib/types";
import { SHARE_EXPIRY_OPTIONS } from "@/ui/lib/types";
import { useAtlasConfig } from "@/ui/context";

const EXPIRY_LABELS: Record<ShareExpiryKey, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  never: "Never",
};

interface ShareStatus {
  shared: boolean;
  token: string | null;
  expiresAt: string | null;
  shareMode: ShareMode;
}

interface DashboardShareDialogProps {
  dashboardId: string;
}

export function DashboardShareDialog({ dashboardId }: DashboardShareDialogProps) {
  const [open, setOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<ShareExpiryKey>("7d");
  const [shareMode, setShareMode] = useState<ShareMode>("public");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [fetchingStatus, setFetchingStatus] = useState(false);
  const inFlightRef = useRef(false);

  const { apiUrl, isCrossOrigin } = useAtlasConfig();

  const { mutate: shareMutate, saving: sharing } = useAdminMutation<{
    token: string;
    expiresAt: string | null;
    shareMode: ShareMode;
  }>();
  const { mutate: unshareMutate, saving: unsharing } = useAdminMutation({});

  // Fetch share status only when dialog opens (not on mount)
  const fetchShareStatus = useCallback(async () => {
    setFetchingStatus(true);
    try {
      const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
      const res = await fetch(`${apiUrl}/api/v1/dashboards/${dashboardId}/share`, { credentials });
      if (!res.ok) {
        setError("Could not check share status. You can still create a new link.");
        return;
      }
      const status: ShareStatus = await res.json();
      setShared(status.shared);
      if (status.shared && status.token) {
        setShareUrl(`${window.location.origin}/shared/dashboard/${status.token}`);
        setExpiresAt(status.expiresAt);
        setShareMode(status.shareMode);
      } else {
        setShareUrl(null);
        setExpiresAt(null);
      }
    } catch {
      setError("Could not check share status. You can still create a new link.");
    } finally {
      setFetchingStatus(false);
    }
  }, [apiUrl, isCrossOrigin, dashboardId]);

  useEffect(() => {
    if (open) {
      setError(null);
      setCopied(false);
      fetchShareStatus();
    }
  }, [open, fetchShareStatus]);

  async function handleShare() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    try {
      const result = await shareMutate({
        path: `/api/v1/dashboards/${dashboardId}/share`,
        method: "POST",
        body: { expiresIn, shareMode },
      });
      if (!result.ok) {
        setError(result.error ?? "Failed to create share link.");
        return;
      }
      setShared(true);
      if (result.data) {
        setShareUrl(`${window.location.origin}/shared/dashboard/${(result.data as { token: string }).token}`);
        setExpiresAt((result.data as { expiresAt: string | null }).expiresAt);
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  async function handleUnshare() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    try {
      const result = await unshareMutate({
        path: `/api/v1/dashboards/${dashboardId}/share`,
        method: "DELETE",
      });
      if (!result.ok) {
        setError(result.error ?? "Failed to revoke share link.");
        return;
      }
      setShared(false);
      setShareUrl(null);
      setExpiresAt(null);
    } finally {
      inFlightRef.current = false;
    }
  }

  async function handleCopy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts (non-HTTPS iframes, embedded widgets)
      try {
        const input = document.createElement("input");
        input.value = shareUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // intentionally ignored: clipboard unavailable — user can select and copy manually
        setError("Could not copy to clipboard. Please select and copy the link manually.");
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2 className="mr-1.5 size-3.5" />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share Dashboard</DialogTitle>
          <DialogDescription>
            {shared
              ? "Anyone with the link can view this dashboard's cached results."
              : "Create a public link to share this dashboard."}
          </DialogDescription>
        </DialogHeader>

        {fetchingStatus ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Checking share status...
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            {shared && shareUrl ? (
              <>
                <div className="flex gap-2">
                  <Input value={shareUrl} readOnly className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={handleCopy} title="Copy link">
                    {copied ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
                  </Button>
                </div>

                <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                  {shareMode === "public" ? (
                    <span className="inline-flex items-center gap-1">
                      <Globe className="size-3" /> Public
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Lock className="size-3" /> Org only
                    </span>
                  )}
                  {expiresAt ? (
                    <span>
                      Expires {new Date(expiresAt).toLocaleDateString(undefined, {
                        month: "short", day: "numeric", year: "numeric",
                      })}
                    </span>
                  ) : (
                    <span>No expiry</span>
                  )}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUnshare}
                  disabled={unsharing}
                  className="text-red-500 hover:text-red-600 dark:text-red-400"
                >
                  <Link2Off className="mr-1.5 size-3.5" />
                  Revoke Link
                </Button>
              </>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label>Link expires</Label>
                  <Select value={expiresIn} onValueChange={(v) => setExpiresIn(v as ShareExpiryKey)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SHARE_EXPIRY_OPTIONS) as ShareExpiryKey[]).map((key) => (
                        <SelectItem key={key} value={key}>
                          {EXPIRY_LABELS[key]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label>Visibility</Label>
                  <Select value={shareMode} onValueChange={(v) => setShareMode(v as ShareMode)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">
                        <span className="inline-flex items-center gap-1.5">
                          <Globe className="size-3" /> Public — anyone with the link
                        </span>
                      </SelectItem>
                      <SelectItem value="org">
                        <span className="inline-flex items-center gap-1.5">
                          <Lock className="size-3" /> Organization — requires login
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button onClick={handleShare} disabled={sharing}>
                  {sharing ? "Creating..." : "Create Share Link"}
                </Button>
              </>
            )}

            {error && (
              <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
