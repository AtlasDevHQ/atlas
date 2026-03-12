"use client";

import { useState, useEffect } from "react";
import { Share2, Copy, Check, Link2Off, AlertCircle } from "lucide-react";
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

interface ShareDialogProps {
  conversationId: string;
  onShare: (id: string) => Promise<{ token: string; url: string } | null>;
  onUnshare: (id: string) => Promise<boolean>;
}

export function ShareDialog({ conversationId, onShare, onUnshare }: ShareDialogProps) {
  const [open, setOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when conversation changes
  useEffect(() => {
    setShareUrl(null);
    setShared(false);
    setLoading(false);
    setCopied(false);
    setError(null);
    setOpen(false);
  }, [conversationId]);

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
    } catch {
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
    } catch {
      setError("Failed to remove share link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts
      const input = document.createElement("input");
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(input);
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setCopied(false);
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
          {shared && shareUrl ? (
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
                variant="ghost"
                size="sm"
                onClick={handleUnshare}
                disabled={loading}
                className="text-red-500 hover:text-red-600 dark:text-red-400"
              >
                <Link2Off className="mr-1 h-4 w-4" />
                Remove share link
              </Button>
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
