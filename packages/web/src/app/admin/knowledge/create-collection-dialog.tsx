"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FolderPlus, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InlineError } from "@/ui/components/admin/compact";
import { getApiUrl } from "@/lib/api-url";
import { extractApiError } from "@/ui/lib/extract-api-error";

/* ────────────────────────────────────────────────────────────────────────
 *  Create / edit collection — the explicit "install" flow for the Knowledge
 *  Base pillar (ADR-0028 §5). A collection is a form-install of a built-in
 *  knowledge catalog row, keyed by a slug (the reserved `__install_id__`
 *  field):
 *    - Upload (`okf-upload`): no credentials; ingest is a separate upload act.
 *    - Sync from endpoint (`bundle-sync`, #4211): config carries the bundle
 *      endpoint URL + auth scheme; the optional secret is encrypted at rest
 *      server-side (never echoed back). Atlas pulls the endpoint nightly and
 *      queues changes for review; "Sync now" runs a pull on demand.
 *
 *  Edit mode (`edit` prop) re-drives the SAME install pipeline with the
 *  existing slug — the server upserts the container config in place and
 *  rotates/deletes the credential row without touching the collection's
 *  documents. This is how a leaked sync secret rotates WITHOUT the
 *  uninstall-and-recreate dance (which would archive and un-publish every
 *  document in the collection).
 * ──────────────────────────────────────────────────────────────────────── */

/** Mirror of the server-side collection-slug rule (okf-upload-form-handler). */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;
const SLUG_MAX = 128;

type SourceKind = "upload" | "bundle-sync";
type AuthScheme = "none" | "bearer" | "basic";

/** Pre-fill for edit mode — the non-secret sync settings of an existing
 *  bundle-sync collection (the secret is never echoed, so it starts blank). */
export interface EditSyncSettings {
  readonly slug: string;
  readonly endpointUrl: string | null;
  readonly authScheme: AuthScheme | null;
  readonly description: string | null;
}

export function CreateCollectionDialog({
  open,
  onOpenChange,
  onCreated,
  existingSlugs,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `source` lets the caller decide the follow-up act (upload vs first sync). */
  onCreated: (slug: string, source: SourceKind) => void;
  existingSlugs: ReadonlyArray<string>;
  /** When set, the dialog edits this synced collection's settings in place. */
  edit?: EditSyncSettings | null;
}) {
  const isEdit = edit !== null;
  const [source, setSource] = useState<SourceKind>("upload");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [authScheme, setAuthScheme] = useState<AuthScheme>("none");
  const [authSecret, setAuthSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSource(edit ? "bundle-sync" : "upload");
      setSlug(edit ? edit.slug : "");
      setDescription(edit?.description ?? "");
      setEndpointUrl(edit?.endpointUrl ?? "");
      setAuthScheme(edit?.authScheme ?? "none");
      setAuthSecret("");
      setError(null);
    }
  }, [open, edit]);

  const trimmedSlug = slug.trim();
  const slugValid = trimmedSlug.length > 0 && trimmedSlug.length <= SLUG_MAX && SLUG_PATTERN.test(trimmedSlug);
  // Editing targets an existing slug by design; only creation rejects dupes.
  const isDuplicate = !isEdit && existingSlugs.includes(trimmedSlug);
  const isSync = source === "bundle-sync";
  const endpointValid = !isSync || endpointUrl.trim().length > 0;
  const secretValid = !isSync || authScheme === "none" || authSecret.trim().length > 0;

  async function handleSubmit() {
    if (!slugValid) {
      setError("Collection id may contain only letters, digits, dots, dashes, and underscores.");
      return;
    }
    if (isDuplicate) {
      setError(`A collection named "${trimmedSlug}" already exists.`);
      return;
    }
    if (isSync && !endpointValid) {
      setError("Endpoint URL is required for a synced collection.");
      return;
    }
    if (isSync && !secretValid) {
      setError("An auth secret is required for bearer/basic authentication.");
      return;
    }
    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = { __install_id__: trimmedSlug };
    if (description.trim()) body.description = description.trim();
    if (isSync) {
      body.endpoint_url = endpointUrl.trim();
      body.auth_scheme = authScheme;
      if (authScheme !== "none") body.auth_secret = authSecret.trim();
    }
    const catalogSlug = isSync ? "bundle-sync" : "okf-upload";

    try {
      const res = await fetch(`${getApiUrl()}/api/v1/integrations/${catalogSlug}/install-form`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(
          await extractApiError(
            res,
            isEdit ? "Could not update the sync settings" : "Could not create the collection",
          ),
        );
        return;
      }
      toast.success(
        isEdit ? `Sync settings for "${trimmedSlug}" updated` : `Collection "${trimmedSlug}" created`,
      );
      onCreated(trimmedSlug, source);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isEdit
            ? "Could not update the sync settings."
            : "Could not create the collection.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit sync settings — ${edit.slug}` : "New collection"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Change the endpoint or rotate the auth secret without reinstalling — the collection's documents are untouched."
              : "A collection is a named knowledge corpus — one hosted OKF tree the agent can read as descriptive context. Upload bundles yourself, or point it at an endpoint Atlas syncs nightly."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!isEdit ? (
            <Tabs value={source} onValueChange={(v) => setSource(v === "bundle-sync" ? "bundle-sync" : "upload")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="upload" data-testid="source-upload">
                  Upload
                </TabsTrigger>
                <TabsTrigger value="bundle-sync" data-testid="source-bundle-sync">
                  Sync from endpoint
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}

          {!isEdit ? (
            <div className="space-y-1.5">
              <Label htmlFor="collection-slug">Collection id</Label>
              <Input
                id="collection-slug"
                placeholder="runbooks"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                autoFocus
                data-testid="collection-slug"
              />
              <p className="text-xs text-muted-foreground">
                Letters, digits, dots, dashes, and underscores. Becomes the collection&apos;s URL and
                cannot be changed later.
              </p>
              {trimmedSlug.length > 0 && !slugValid ? (
                <p className="text-xs text-destructive">
                  Only letters, digits, dots, dashes, and underscores (max {SLUG_MAX}).
                </p>
              ) : isDuplicate ? (
                <p className="text-xs text-destructive">That collection already exists.</p>
              ) : null}
            </div>
          ) : null}

          {isSync ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="collection-endpoint">Endpoint URL</Label>
                <Input
                  id="collection-endpoint"
                  placeholder="https://github.com/acme/kb/archive/refs/heads/main.tar.gz"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  data-testid="collection-endpoint"
                />
                <p className="text-xs text-muted-foreground">
                  An HTTPS URL serving your bundle as .tar, .tar.gz, or .zip — a git-forge archive
                  URL works. Synced changes always land as drafts for review.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="collection-auth">Authentication</Label>
                <Select value={authScheme} onValueChange={(v) => setAuthScheme(v as AuthScheme)}>
                  <SelectTrigger id="collection-auth" data-testid="collection-auth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (public endpoint)</SelectItem>
                    <SelectItem value="bearer">Bearer token</SelectItem>
                    <SelectItem value="basic">Basic (user:password)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {authScheme !== "none" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="collection-secret">
                    {authScheme === "bearer" ? "Bearer token" : "User:password"}
                  </Label>
                  <Input
                    id="collection-secret"
                    type="password"
                    autoComplete="off"
                    value={authSecret}
                    onChange={(e) => setAuthSecret(e.target.value)}
                    data-testid="collection-secret"
                  />
                  <p className="text-xs text-muted-foreground">
                    {isEdit
                      ? "Enter the (new) secret — the stored one is never shown; saving replaces it."
                      : "Stored encrypted; never shown again."}
                  </p>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="collection-description">Description (optional)</Label>
            <Textarea
              id="collection-description"
              placeholder="What this corpus covers — e.g. on-call runbooks and incident playbooks."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          {error ? <InlineError>{error}</InlineError> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={saving || !slugValid || isDuplicate || !endpointValid || !secretValid}
            data-testid="create-collection-submit"
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <FolderPlus className="mr-1.5 size-3.5" />
            )}
            {isEdit ? "Save sync settings" : "Create collection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
