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
import { InlineError } from "@/ui/components/admin/compact";
import { getApiUrl } from "@/lib/api-url";

/* ────────────────────────────────────────────────────────────────────────
 *  Create collection — the explicit "install" flow for the Knowledge Base
 *  pillar (ADR-0028 §5). A collection is a degenerate form-install of the
 *  built-in `okf-upload` catalog row: no credentials, just a slug (carried in
 *  the reserved `__install_id__` field) and an optional description. Ingest is
 *  a separate act; installing only creates the named container.
 * ──────────────────────────────────────────────────────────────────────── */

/** Mirror of the server-side collection-slug rule (okf-upload-form-handler). */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;
const SLUG_MAX = 128;

export function CreateCollectionDialog({
  open,
  onOpenChange,
  onCreated,
  existingSlugs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
  existingSlugs: ReadonlyArray<string>;
}) {
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSlug("");
      setDescription("");
      setError(null);
    }
  }, [open]);

  const trimmedSlug = slug.trim();
  const slugValid = trimmedSlug.length > 0 && trimmedSlug.length <= SLUG_MAX && SLUG_PATTERN.test(trimmedSlug);
  const isDuplicate = existingSlugs.includes(trimmedSlug);

  async function handleSubmit() {
    if (!slugValid) {
      setError("Collection id may contain only letters, digits, dots, dashes, and underscores.");
      return;
    }
    if (isDuplicate) {
      setError(`A collection named "${trimmedSlug}" already exists.`);
      return;
    }
    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = { __install_id__: trimmedSlug };
    if (description.trim()) body.description = description.trim();

    try {
      const res = await fetch(`${getApiUrl()}/api/v1/integrations/okf-upload/install-form`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = `Could not create the collection (${res.status}).`;
        try {
          const b = (await res.json()) as {
            message?: string;
            fieldErrors?: Record<string, string[] | undefined>;
            requestId?: string;
          };
          const firstField = b.fieldErrors ? Object.keys(b.fieldErrors)[0] : undefined;
          const firstErr = firstField ? b.fieldErrors?.[firstField]?.[0] : undefined;
          if (firstErr) message = firstErr;
          else if (b.message) message = b.message;
          if (b.requestId) message = `${message} (ref: ${b.requestId.slice(0, 8)})`;
        } catch {
          // intentionally ignored: non-JSON body → keep the status-only message.
        }
        setError(message);
        return;
      }
      toast.success(`Collection "${trimmedSlug}" created`);
      onCreated(trimmedSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the collection.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New collection</DialogTitle>
          <DialogDescription>
            A collection is a named knowledge corpus — one hosted OKF tree the agent can read as
            descriptive context. Upload documents into it after it&apos;s created.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
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
            disabled={saving || !slugValid || isDuplicate}
            data-testid="create-collection-submit"
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <FolderPlus className="mr-1.5 size-3.5" />
            )}
            Create collection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
