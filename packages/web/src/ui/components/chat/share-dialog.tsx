"use client";

import { useState, useEffect } from "react";
import { Share2, Copy, Check, Link2Off, AlertCircle, Code, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ShareStatus } from "../../lib/types";

interface ShareDialogProps {
  conversationId: string;
  onShare: (id: string) => Promise<{ token: string; url: string } | null>;
  onUnshare: (id: string) => Promise<boolean>;
  onGetShareStatus: (id: string) => Promise<ShareStatus | null>;
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
        if (status?.shared) {
          setShared(true);
          setShareUrl(status.url);
        } else {
          setShared(false);
          setShareUrl(null);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("getShareStatus: fetch failed", err);
          setError("Could not check existing share status. You can still create a new share link.");
        }
      } finally {
        if (!cancelled) setFetchingStatus(false);
      }
    }
    fetchStatus();

    return () => { cancelled = true; };
  }, [open, conversationId, onGetShareStatus]);

  async function handleShare() {
    setLoading(true);
    setError(null);
    try {
      const result = await onShare(conversationId);
      if (result) {
        setShareUrl(result.url);
        setShared(true);
      } else {
        setError("Failed to create share link. Please try again.");
      }
    } catch (err) {
      console.warn("handleShare error:", err);
      setError("Failed to create share link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnshare() {
    setLoading(true);
    setError(null);
    try {
      const ok = await onUnshare(conversationId);
      if (ok) {
        setShareUrl(null);
        setShared(false);
      } else {
        setError("Failed to remove share link. Please try again.");
      }
    } catch (err) {
      console.warn("handleUnshare error:", err);
      setError("Failed to remove share link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegenerate() {
    setLoading(true);
    setError(null);
    try {
      const result = await onShare(conversationId);
      if (result) {
        setShareUrl(result.url);
        setShared(true);
      } else {
        setError("Failed to regenerate share link. Please try again.");
      }
    } catch (err) {
      console.warn("handleRegenerate error:", err);
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
              ? "Anyone with the link can view this conversation."
              : "Create a public link to share this conversation."}
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
            <Button onClick={handleShare} disabled={loading}>
              <Share2 className="mr-2 h-4 w-4" />
              {loading ? "Creating link..." : "Create share link"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
