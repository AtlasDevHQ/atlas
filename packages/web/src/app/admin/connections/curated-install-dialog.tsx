"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2 } from "lucide-react";
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
import { InlineError } from "@/ui/components/admin/compact";
import { getApiUrl } from "@/lib/api-url";

/* ────────────────────────────────────────────────────────────────────────
 *  Curated REST datasource install — the one-credential form for a built-in
 *  "data candidate" (Stripe, Notion, …). The spec URL + auth kind are
 *  pre-wired server-side; the admin only pastes the secret. POSTs the slim
 *  `{ auth_value, display_name? }` body to the candidate's `install-form`
 *  handler (mirrors {@link DataCandidateFormDataSchema} on the API).
 * ──────────────────────────────────────────────────────────────────────── */

export interface CuratedCandidate {
  slug: string;
  name: string;
  description: string | null;
}

/** Per-vendor copy for the single credential field. Falls back to a generic
 *  label for any candidate not enumerated here. */
const SECRET_FIELD: Record<string, { label: string; placeholder: string; help: string }> = {
  "stripe-data": {
    label: "Stripe secret key",
    placeholder: "sk_live_…",
    help: "Find it in Stripe Dashboard → Developers → API keys. Used read-only; encrypted at rest.",
  },
  "notion-data": {
    label: "Notion integration token",
    placeholder: "ntn_…",
    help: "Create an internal integration at notion.so/my-integrations and share the pages you want Atlas to read.",
  },
};

export function CuratedInstallDialog({
  candidate,
  open,
  onOpenChange,
  onInstalled,
}: {
  candidate: CuratedCandidate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  const [authValue, setAuthValue] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever a different candidate opens the dialog so a
  // previous vendor's pasted secret never leaks into the next install.
  useEffect(() => {
    if (open) {
      setAuthValue("");
      setDisplayName("");
      setError(null);
    }
  }, [open, candidate?.slug]);

  if (!candidate) return null;
  const field = SECRET_FIELD[candidate.slug] ?? {
    label: "API key / token",
    placeholder: "",
    help: "Used read-only; encrypted at rest.",
  };

  async function handleSubmit() {
    if (!candidate) return;
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { auth_value: authValue };
    if (displayName.trim()) body.display_name = displayName.trim();

    try {
      const res = await fetch(
        `${getApiUrl()}/api/v1/integrations/${encodeURIComponent(candidate.slug)}/install-form`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        let message = `Install failed (${res.status})`;
        try {
          const b = (await res.json()) as {
            message?: string;
            fieldErrors?: Record<string, string[] | undefined>;
            requestId?: string;
          };
          const firstField = b.fieldErrors ? Object.keys(b.fieldErrors)[0] : undefined;
          const firstErr = firstField ? b.fieldErrors?.[firstField]?.[0] : undefined;
          if (firstField && firstErr) message = `${firstField}: ${firstErr}`;
          else if (b.message) message = b.message;
          if (b.requestId) message = `${message} (ref: ${b.requestId.slice(0, 8)})`;
        } catch {
          // intentionally ignored: non-JSON body → keep the status-only message.
        }
        setError(message);
        return;
      }
      toast.success(`${candidate.name} connected`);
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {candidate.name}</DialogTitle>
          <DialogDescription>
            {candidate.description ??
              `Query ${candidate.name} as a read-only REST datasource. The spec is pre-wired — just paste your credential.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="curated-auth-value">{field.label}</Label>
            <Input
              id="curated-auth-value"
              type="password"
              placeholder={field.placeholder}
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              data-testid="curated-auth-value"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">{field.help}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="curated-display-name">Display name (optional)</Label>
            <Input
              id="curated-display-name"
              placeholder={candidate.name}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
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
            disabled={saving || authValue.trim().length === 0}
            data-testid="curated-install-submit"
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <ExternalLink className="mr-1.5 size-3.5" />
            )}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
