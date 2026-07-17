"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Share2, Copy, Check, Link2Off, Globe, Lock, Loader2, RefreshCw, Code, Monitor, Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
import { friendlyError } from "@/ui/lib/fetch-error";
import type { ShareMode, ShareExpiryKey } from "@/ui/lib/types";
import { SHARE_EXPIRY_OPTIONS } from "@/ui/lib/types";
import { useAtlasConfig } from "@/ui/context";
import { deriveExpiryKey } from "./share-expiry";
import { buildEmbedSnippet, type EmbedThemeParam } from "./share-embed";

/** Embed-tab theme control: "system" emits no `?theme=` param (visitor's own
 *  preference drives the frame); "light"/"dark" force a fixed appearance. The
 *  tuple is the SSOT for the `EmbedThemeChoice` type and the `onValueChange`
 *  narrowing (`asEmbedThemeChoice`); the rendered `<ToggleGroupItem>` values are
 *  authored to match by hand. `satisfies` pins every member to a valid
 *  `"system" | EmbedThemeParam`. */
const EMBED_THEME_CHOICES = ["system", "light", "dark"] as const satisfies readonly (
  | "system"
  | EmbedThemeParam
)[];
type EmbedThemeChoice = (typeof EMBED_THEME_CHOICES)[number];

/** Narrow Radix's `string` back onto the choice union. Radix emits `""` when the
 *  active item is re-clicked (deselect); returning `undefined` there lets the
 *  caller keep the current selection rather than blanking it. */
function asEmbedThemeChoice(value: string): EmbedThemeChoice | undefined {
  return (EMBED_THEME_CHOICES as readonly string[]).includes(value)
    ? (value as EmbedThemeChoice)
    : undefined;
}

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
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  // Embed appearance the snippet bakes in. Default "system" = no `?theme=` param
  // so the frame follows the visitor's own light/dark preference (#4686).
  const [embedTheme, setEmbedTheme] = useState<EmbedThemeChoice>("system");
  const [error, setError] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<ShareExpiryKey>("7d");
  const [shareMode, setShareMode] = useState<ShareMode>("public");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [fetchingStatus, setFetchingStatus] = useState(false);
  // Explicit, warned token rotation (#4317). Editing expiry/visibility on a
  // live share preserves the token; regenerating (which kills prior links) is a
  // separate, confirmed action.
  const [confirmingRotate, setConfirmingRotate] = useState(false);
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
        // Sync the "Link expires" control to the share's real lifetime so a
        // visibility-only edit can't reset expiry (#4536). See deriveExpiryKey
        // (share-expiry.ts) for the bucket-rounding rationale.
        setExpiresIn(deriveExpiryKey(status.expiresAt));
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
      setCopiedEmbed(false);
      setConfirmingRotate(false);
      // fire-and-forget: refresh share status on dialog open; component state updates on resolve
      void fetchShareStatus();
    }
  }, [open, fetchShareStatus]);

  // POST the share config. `rotate` is opt-in: absent/false PRESERVES the token
  // (editing expiry/visibility), true mints a new one and kills prior links.
  async function submitShare(rotate: boolean) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    try {
      const result = await shareMutate({
        path: `/api/v1/dashboards/${dashboardId}/share`,
        method: "POST",
        body: { expiresIn, shareMode, rotate },
      });
      if (!result.ok) {
        setError(friendlyError(result.error));
        return;
      }
      setShared(true);
      setConfirmingRotate(false);
      if (result.data) {
        setShareUrl(`${window.location.origin}/shared/dashboard/${(result.data as { token: string }).token}`);
        setExpiresAt((result.data as { expiresAt: string | null }).expiresAt);
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  // Create a brand-new share (first time) — no token to preserve.
  const handleShare = () => submitShare(false);
  // Edit a live share's expiry/visibility WITHOUT rotating the token.
  const handleUpdateSettings = () => submitShare(false);
  // Explicit, confirmed rotation — prior links stop working.
  const handleRotate = () => submitShare(true);

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
        setError(friendlyError(result.error));
        return;
      }
      setShared(false);
      setShareUrl(null);
      setExpiresAt(null);
    } finally {
      inFlightRef.current = false;
    }
  }

  // The iframe snippet for the Embed tab — points at the SAME share token's
  // framable `/embed` route (#4564), so revoking the link kills the embed too.
  // Built by the pure `buildEmbedSnippet` helper (escaping pinned in its test).
  const embedCode = shareUrl
    ? buildEmbedSnippet(shareUrl, embedTheme === "system" ? undefined : embedTheme)
    : "";

  async function copyText(text: string, flash: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      flash(true);
      setTimeout(() => flash(false), 2000);
    } catch (err) {
      // Fallback for insecure contexts (non-HTTPS iframes, embedded widgets).
      // Log why the primary path failed so a "copy doesn't work" report has a
      // signal (permissions-policy vs insecure-context vs focus).
      console.debug(
        "[dashboard-share] clipboard.writeText failed, falling back to execCommand:",
        err instanceof Error ? err.message : String(err),
      );
      try {
        const input = document.createElement("textarea");
        input.value = text;
        document.body.appendChild(input);
        input.select();
        // execCommand signals failure by returning false WITHOUT throwing — so a
        // silent false here would flash a false "Copied". Route it to the same
        // manual-copy hint as a thrown error.
        const ok = document.execCommand("copy");
        document.body.removeChild(input);
        if (!ok) throw new Error("execCommand('copy') returned false");
        flash(true);
        setTimeout(() => flash(false), 2000);
      } catch {
        // clipboard unavailable — surface a manual-copy hint (not a silent swallow)
        setError("Could not copy to clipboard. Please select and copy it manually.");
      }
    }
  }

  const handleCopy = () => (shareUrl ? copyText(shareUrl, setCopied) : undefined);
  const handleCopyEmbed = () => (embedCode ? copyText(embedCode, setCopiedEmbed) : undefined);

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
              ? shareMode === "org"
                ? "Only authenticated members of your organization can view this dashboard's cached results."
                : "Anyone with the link can view this dashboard's cached results."
              : "Create a link to share this dashboard."}
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
              <Tabs defaultValue="link">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="link">Link</TabsTrigger>
                  <TabsTrigger value="embed">Embed</TabsTrigger>
                </TabsList>
                <TabsContent value="link" className="mt-4 grid gap-4">
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

                {/* Edit expiry/visibility WITHOUT rotating the token — prior
                    links keep working (#4317). */}
                <div className="grid gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
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

                  <Button variant="secondary" size="sm" onClick={handleUpdateSettings} disabled={sharing}>
                    {sharing ? "Saving..." : "Update settings"}
                  </Button>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Updating settings keeps the same link. To invalidate it, generate a new link below.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
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
                  {!confirmingRotate && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmingRotate(true)}
                      disabled={sharing}
                    >
                      <RefreshCw className="mr-1.5 size-3.5" />
                      Generate new link
                    </Button>
                  )}
                </div>

                {confirmingRotate && (
                  <div className="grid gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800/60 dark:bg-amber-950/30">
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                      Generating a new link invalidates the current one. Anyone still using the old link will lose access.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="destructive" size="sm" onClick={handleRotate} disabled={sharing}>
                        {sharing ? "Generating..." : "Generate new link"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingRotate(false)} disabled={sharing}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                </TabsContent>

                <TabsContent value="embed" className="mt-4 grid gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="dashboard-embed-theme">Appearance</Label>
                    <ToggleGroup
                      id="dashboard-embed-theme"
                      type="single"
                      variant="outline"
                      size="sm"
                      value={embedTheme}
                      // Empty deselect value is ignored — see asEmbedThemeChoice.
                      onValueChange={(v) => {
                        const next = asEmbedThemeChoice(v);
                        if (next) setEmbedTheme(next);
                      }}
                      className="w-full"
                      aria-label="Embed appearance"
                    >
                      <ToggleGroupItem value="system" className="flex-1 gap-1.5">
                        <Monitor className="size-3.5" /> System
                      </ToggleGroupItem>
                      <ToggleGroupItem value="light" className="flex-1 gap-1.5">
                        <Sun className="size-3.5" /> Light
                      </ToggleGroupItem>
                      <ToggleGroupItem value="dark" className="flex-1 gap-1.5">
                        <Moon className="size-3.5" /> Dark
                      </ToggleGroupItem>
                    </ToggleGroup>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      {embedTheme === "system"
                        ? "Follows each viewer's own light/dark setting."
                        : `Always renders in ${embedTheme} mode, regardless of the viewer's setting.`}
                    </p>
                  </div>
                  <Label htmlFor="dashboard-embed-code">Embed snippet</Label>
                  <Textarea
                    id="dashboard-embed-code"
                    value={embedCode}
                    readOnly
                    rows={3}
                    className="resize-none font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button variant="outline" size="sm" onClick={handleCopyEmbed} className="justify-self-start">
                    {copiedEmbed ? (
                      <Check className="mr-1.5 size-3.5 text-green-500" />
                    ) : (
                      <Code className="mr-1.5 size-3.5" />
                    )}
                    {copiedEmbed ? "Copied" : "Copy embed code"}
                  </Button>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {shareMode === "org"
                      ? "Viewers must be signed in to your organization for this embed to load."
                      : "Anyone who can load the host page can view this embedded dashboard."}
                  </p>
                </TabsContent>
              </Tabs>
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
