"use client";

import { useState, useEffect } from "react";
import { Share2, Copy, Check, Link2Off, AlertCircle, Code, RefreshCw, Globe, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import type { ShareStatus, ShareMode, ShareExpiryKey } from "../../lib/types";
import { SHARE_EXPIRY_OPTIONS } from "../../lib/types";

const EXPIRY_LABELS: Record<ShareExpiryKey, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  never: "Never",
};

interface ShareDialogProps {
  conversationId: string;
  onShare: (id: string, opts?: { expiresIn?: ShareExpiryKey; shareMode?: ShareMode }) => Promise<{ token: string; url: string }>;
  onUnshare: (id: string) => Promise<void>;
  onGetShareStatus: (id: string) => Promise<ShareStatus>;
}

export function ShareDialog({ conversationId, onShare, onUnshare, onGetShareStatus }: ShareDialogProps) {
  const [open, setOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingStatus, setFetchingStatus] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<ShareExpiryKey>("7d");
  const [shareMode, setShareMode] = useState<ShareMode>("public");
  const [currentShareMode, setCurrentShareMode] = useState<ShareMode>("public");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  // Reset state when conversation changes
  useEffect(() => {
    setShareUrl(null);
    setShared(false);
    setLoading(false);
    setFetchingStatus(false);
    setCopied(false);
    setCopiedEmbed(false);
    setError(null);
    setOpen(false);
    setExpiresIn("7d");
    setShareMode("public");
    setCurrentShareMode("public");
    setExpiresAt(null);
  }, [conversationId]);

  // Fetch share status when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function fetchStatus() {
      setFetchingStatus(true);
      setError(null);
      try {
        const status = await onGetShareStatus(conversationId);
        if (cancelled) return;
        if (status.shared) {
          setShared(true);
          setShareUrl(status.url);
          setCurrentShareMode(status.shareMode);
          setExpiresAt(status.expiresAt);
        } else {
          setShared(false);
          setShareUrl(null);
          setExpiresAt(null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          console.warn("getShareStatus: fetch failed", err instanceof Error ? err.message : String(err));
          setError("Could not check existing share status. You can still create a new share link.");
        }
      } finally {
        if (!cancelled) setFetchingStatus(false);
      }
    }
    fetchStatus();

    return () => { cancelled = true; };
  }, [open, conversationId, onGetShareStatus]);

  function computeDisplayExpiry(key: ShareExpiryKey): string | null {
    const seconds = SHARE_EXPIRY_OPTIONS[key];
    if (seconds === null) return null;
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  async function handleShare() {
    setLoading(true);
    setError(null);
    try {
      const result = await onShare(conversationId, { expiresIn, shareMode });
      setShareUrl(result.url);
      setShared(true);
      setCurrentShareMode(shareMode);
      setExpiresAt(computeDisplayExpiry(expiresIn));
    } catch (err: unknown) {
      console.warn("handleShare error:", err instanceof Error ? err.message : String(err));
      setError("Failed to create share link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnshare() {
    setLoading(true);
    setError(null);
    try {
      await onUnshare(conversationId);
      setShareUrl(null);
      setShared(false);
      setExpiresAt(null);
    } catch (err: unknown) {
      console.warn("handleUnshare error:", err instanceof Error ? err.message : String(err));
      setError("Failed to remove share link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegenerate() {
    setLoading(true);
    setError(null);
    try {
      const result = await onShare(conversationId, { expiresIn, shareMode });
      setShareUrl(result.url);
      setShared(true);
      setCurrentShareMode(shareMode);
      setExpiresAt(computeDisplayExpiry(expiresIn));
    } catch (err: unknown) {
      console.warn("handleRegenerate error:", err instanceof Error ? err.message : String(err));
      setError("Failed to regenerate share link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function copyToClipboard(
    text: string,
    onSuccess: () => void,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      onSuccess();
    } catch (clipErr) {
      // Fallback for insecure contexts (e.g. non-HTTPS iframes)
      try {
        const input = document.createElement("input");
        input.value = text;
        document.body.appendChild(input);
        input.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(input);
        if (ok) {
          onSuccess();
        } else {
          setError("Could not copy to clipboard. Please select and copy manually.");
        }
      } catch (fallbackErr) {
        console.warn("copyToClipboard: both methods failed", clipErr, fallbackErr);
        setError("Could not copy to clipboard. Please select and copy manually.");
      }
    }
  }

  function flashCopied(setter: (v: boolean) => void): void {
    setter(true);
    setTimeout(() => setter(false), 2000);
  }

  async function handleCopy(): Promise<void> {
    if (!shareUrl) return;
    await copyToClipboard(shareUrl, () => flashCopied(setCopied));
  }

  async function handleCopyEmbed(): Promise<void> {
    if (!shareUrl) return;
    const escaped = shareUrl.replace(/"/g, "&quot;");
    const code = `<iframe src="${escaped}/embed" width="100%" height="500" frameborder="0" style="border:0;border-radius:8px"></iframe>`;
    await copyToClipboard(code, () => flashCopied(setCopiedEmbed));
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setCopied(false);
      setCopiedEmbed(false);
      setError(null);
    }
  }

  function formatExpiresAt(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    if (diffMs <= 0) return "Expired";
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    if (hours < 1) return `${Math.ceil(diffMs / (1000 * 60))}m remaining`;
    if (hours < 24) return `${hours}h remaining`;
    const days = Math.floor(hours / 24);
    return `${days}d remaining`;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={
            shared
              ? "text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
              : "text-zinc-400 hover:text-blue-500 dark:text-zinc-500 dark:hover:text-blue-400"
          }
          aria-label={shared ? "Manage share link" : "Share conversation"}
        >
          <Share2 className="h-3.5 w-3.5" />
          <span>{shared ? "Shared" : "Share"}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share conversation</DialogTitle>
          <DialogDescription>
            {shared
              ? currentShareMode === "org"
                ? "Only authenticated users in your organization can view this conversation."
                : "Anyone with the link can view this conversation."
              : "Create a link to share this conversation."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {fetchingStatus ? (
            <div className="flex items-center justify-center py-4 text-sm text-zinc-500">
              Loading share status...
            </div>
          ) : shared && shareUrl ? (
            <>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={shareUrl}
                  className="flex-1"
                />
                <Button size="sm" variant="outline" onClick={handleCopy}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <div className="flex items-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
                <span className="flex items-center gap-1">
                  {currentShareMode === "org" ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
                  {currentShareMode === "org" ? "Organization only" : "Public"}
                </span>
                {expiresAt && (
                  <span className="text-zinc-400 dark:text-zinc-500">
                    {formatExpiresAt(expiresAt)}
                  </span>
                )}
                {!expiresAt && (
                  <span className="text-zinc-400 dark:text-zinc-500">
                    No expiry
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyEmbed}
              >
                {copiedEmbed ? <Check className="h-4 w-4" /> : <Code className="h-4 w-4" />}
                <span className="ml-1">{copiedEmbed ? "Copied" : "Copy embed code"}</span>
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={loading}
                  className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  <RefreshCw className="mr-1 h-4 w-4" />
                  {loading ? "Regenerating..." : "Regenerate link"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleUnshare}
                  disabled={loading}
                  className="text-red-500 hover:text-red-600 dark:text-red-400"
                >
                  <Link2Off className="mr-1 h-4 w-4" />
                  Remove share link
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <Label htmlFor="share-expiry" className="text-sm font-medium">
                      Link expires
                    </Label>
                    <Select value={expiresIn} onValueChange={(v) => setExpiresIn(v as ShareExpiryKey)}>
                      <SelectTrigger id="share-expiry" className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(EXPIRY_LABELS) as ShareExpiryKey[]).map((key) => (
                          <SelectItem key={key} value={key}>{EXPIRY_LABELS[key]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {shareMode === "org" ? <Lock className="h-4 w-4 text-zinc-500" /> : <Globe className="h-4 w-4 text-zinc-500" />}
                    <Label htmlFor="share-mode" className="text-sm font-medium">
                      {shareMode === "org" ? "Organization only" : "Public link"}
                    </Label>
                  </div>
                  <Switch
                    id="share-mode"
                    checked={shareMode === "org"}
                    onCheckedChange={(checked) => setShareMode(checked ? "org" : "public")}
                  />
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {shareMode === "org"
                    ? "Only authenticated users can view this shared conversation."
                    : "Anyone with the link can view this shared conversation."}
                </p>
              </div>
              <Button onClick={handleShare} disabled={loading}>
                <Share2 className="mr-2 h-4 w-4" />
                {loading ? "Creating link..." : "Create share link"}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
