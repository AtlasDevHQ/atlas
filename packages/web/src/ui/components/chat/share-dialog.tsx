"use client";

import { useState, useEffect } from "react";
import { Share2, Copy, Check, Link2Off, AlertCircle, Code, Globe, Building2 } from "lucide-react";
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
import type { ShareExpiry, ShareMode, ShareLink } from "../../lib/types";

const EXPIRY_OPTIONS: { value: ShareExpiry; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "never", label: "Never" },
];

interface ShareDialogProps {
  conversationId: string;
  onShare: (id: string, opts?: { expiresIn?: ShareExpiry; shareMode?: ShareMode }) => Promise<ShareLink | null>;
  onUnshare: (id: string) => Promise<boolean>;
}

export function ShareDialog({ conversationId, onShare, onUnshare }: ShareDialogProps) {
  const [open, setOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<ShareExpiry>("never");
  const [shareMode, setShareMode] = useState<ShareMode>("public");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<ShareMode>("public");

  // Reset state when conversation changes
  useEffect(() => {
    setShareUrl(null);
    setShared(false);
    setLoading(false);
    setCopied(false);
    setCopiedEmbed(false);
    setError(null);
    setOpen(false);
    setExpiresIn("never");
    setShareMode("public");
    setExpiresAt(null);
    setActiveMode("public");
  }, [conversationId]);

  async function handleShare() {
    setLoading(true);
    setError(null);
    try {
      const result = await onShare(conversationId, { expiresIn, shareMode });
      if (result) {
        setShareUrl(result.url);
        setShared(true);
        setExpiresAt(result.expiresAt);
        setActiveMode(result.shareMode);
      } else {
        setError("Failed to create share link. Please try again.");
      }
    } catch (err) {
      console.error("handleShare failed:", err);
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
        setExpiresAt(null);
        setActiveMode("public");
      } else {
        setError("Failed to remove share link. Please try again.");
      }
    } catch (err) {
      console.error("handleUnshare failed:", err);
      setError("Failed to remove share link. Please try again.");
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
    } catch {
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
      } catch {
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

  const modeDescription = activeMode === "org"
    ? "Only organization members with the link can view this conversation."
    : "Anyone with the link can view this conversation.";

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
            {shared ? modeDescription : "Create a link to share this conversation."}
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
              {expiresAt && !isNaN(new Date(expiresAt).getTime()) && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Expires{" "}
                  {new Date(expiresAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              )}
              <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                {activeMode === "org" ? (
                  <Building2 className="h-3.5 w-3.5" />
                ) : (
                  <Globe className="h-3.5 w-3.5" />
                )}
                <span>
                  {activeMode === "org" ? "Organization only" : "Anyone with link"}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyEmbed}
              >
                {copiedEmbed ? <Check className="h-4 w-4" /> : <Code className="h-4 w-4" />}
                <span className="ml-1">{copiedEmbed ? "Copied" : "Copy embed code"}</span>
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
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="share-expiry">Link expires after</Label>
                <Select value={expiresIn} onValueChange={(v) => setExpiresIn(v as ShareExpiry)}>
                  <SelectTrigger id="share-expiry" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="share-mode">Who can access</Label>
                <Select value={shareMode} onValueChange={(v) => setShareMode(v as ShareMode)}>
                  <SelectTrigger id="share-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">
                      <span className="flex items-center gap-2">
                        <Globe className="h-3.5 w-3.5" />
                        Anyone with link
                      </span>
                    </SelectItem>
                    <SelectItem value="org">
                      <span className="flex items-center gap-2">
                        <Building2 className="h-3.5 w-3.5" />
                        Organization only
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
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
