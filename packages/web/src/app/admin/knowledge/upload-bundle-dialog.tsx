"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Loader2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { InlineError } from "@/ui/components/admin/compact";
import { getApiUrl } from "@/lib/api-url";
import { KnowledgeIngestSummarySchema } from "@/ui/lib/admin-schemas";
import type { KnowledgeIngestSummary } from "@/ui/lib/types";

/* ────────────────────────────────────────────────────────────────────────
 *  Upload bundle — the ingest act for a collection (ADR-0028 §4/§5). Uploads a
 *  `.tar` / `.tar.gz` / `.zip` OKF bundle; documents land as content-mode
 *  DRAFTS (the review gate). The "Upload & publish" toggle (default OFF) runs
 *  the atomic workspace publish in the same request. Per-file rejections and
 *  the ingest summary are surfaced after the upload — nothing is silently
 *  skipped.
 * ──────────────────────────────────────────────────────────────────────── */

const ACCEPT = ".tar,.tar.gz,.tgz,.zip,application/zip,application/x-tar,application/gzip";

/**
 * What the summary panel renders: a successful ingest's counts, or a
 * rejected-files-only view synthesized from a whole-bundle 400 (`documents`
 * null). A dedicated view type — not `KnowledgeIngestSummary` — so the error
 * branch never has to fabricate wire fields (a made-up `format` would leak
 * into any future panel change).
 */
interface IngestSummaryView {
  readonly documents: KnowledgeIngestSummary["documents"] | null;
  readonly rejected: ReadonlyArray<{ path: string; reason: string }>;
  readonly skippedNonMarkdown: number;
}

export function UploadBundleDialog({
  collectionSlug,
  open,
  onOpenChange,
  onIngested,
}: {
  collectionSlug: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIngested: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [publish, setPublish] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<IngestSummaryView | null>(null);

  useEffect(() => {
    if (open) {
      setFile(null);
      setPublish(false);
      setError(null);
      setSummary(null);
    }
  }, [open, collectionSlug]);

  if (!collectionSlug) return null;

  async function handleSubmit() {
    if (!file || !collectionSlug) return;
    setSaving(true);
    setError(null);
    setSummary(null);

    try {
      const bytes = await file.arrayBuffer();
      const query = publish ? "?publish=true" : "";
      const res = await fetch(
        `${getApiUrl()}/api/v1/admin/knowledge/${encodeURIComponent(collectionSlug)}/ingest${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          credentials: "include",
          body: bytes,
        },
      );

      // intentionally ignored: a non-JSON / empty / truncated body → null; the
      // !res.ok branch falls back to a status-only message and the ok branch
      // re-validates via safeParse, so a parse blip never passes unnoticed.
      const json = (await res.json().catch(() => null)) as unknown;

      if (!res.ok) {
        const b = (json ?? {}) as {
          message?: string;
          requestId?: string;
          rejected?: ReadonlyArray<{ path: string; reason: string }>;
        };
        let message = b.message ?? `Ingest failed (${res.status}).`;
        if (b.requestId) message = `${message} (ref: ${b.requestId.slice(0, 8)})`;
        // A whole-bundle rejection (e.g. every file unsafe) can still carry
        // per-file reasons — surface them in a synthetic summary so the admin
        // sees exactly which files were refused.
        if (b.rejected && b.rejected.length > 0) {
          setSummary({ documents: null, rejected: b.rejected, skippedNonMarkdown: 0 });
        }
        setError(message);
        return;
      }

      const parsed = KnowledgeIngestSummarySchema.safeParse(json);
      if (!parsed.success) {
        setError("The server returned an unexpected ingest response.");
        return;
      }
      const data: KnowledgeIngestSummary = parsed.data;
      setSummary({
        documents: data.documents,
        rejected: data.rejected,
        skippedNonMarkdown: data.skippedNonMarkdown,
      });
      const { created, updated, demoted } = data.documents;
      toast.success(
        data.published
          ? `Ingested and published — ${created} new, ${updated} updated`
          : `Ingested ${created} new, ${updated} updated as drafts`,
      );
      if (demoted > 0) {
        toast.warning(`${demoted} previously-published document${demoted === 1 ? "" : "s"} moved back to draft`);
      }
      onIngested();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload to {collectionSlug}</DialogTitle>
          <DialogDescription>
            Upload a <code>.tar</code>, <code>.tar.gz</code>, or <code>.zip</code> OKF bundle.
            Documents ingest as drafts for review unless you publish immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bundle-file">Bundle file</Label>
            <input
              id="bundle-file"
              type="file"
              accept={ACCEPT}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setSummary(null);
                setError(null);
              }}
              disabled={saving}
              data-testid="bundle-file"
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/80"
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="publish-toggle" className="text-sm font-medium">
                Upload &amp; publish
              </Label>
              <p className="text-xs text-muted-foreground">
                Off (default): documents land as drafts for review. On: promote every pending draft
                in this workspace immediately via the atomic publish.
              </p>
            </div>
            <Switch
              id="publish-toggle"
              checked={publish}
              onCheckedChange={setPublish}
              disabled={saving}
              data-testid="publish-toggle"
            />
          </div>

          {error ? <InlineError>{error}</InlineError> : null}

          {summary ? <IngestSummaryPanel summary={summary} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {summary && !error ? "Done" : "Cancel"}
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !file} data-testid="upload-submit">
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1.5 size-3.5" />
            )}
            {publish ? "Upload & publish" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Post-ingest summary — document counts plus per-file rejections (AC #2). */
function IngestSummaryPanel({ summary }: { summary: IngestSummaryView }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
      {summary.documents && summary.documents.total > 0 ? (
        <div className="flex items-center gap-2 text-foreground">
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          <span>
            {summary.documents.created} new · {summary.documents.updated} updated ·{" "}
            {summary.documents.unchanged} unchanged
            {summary.documents.demoted > 0 ? ` · ${summary.documents.demoted} demoted` : ""}
          </span>
        </div>
      ) : null}
      {summary.skippedNonMarkdown > 0 ? (
        <p className="text-xs text-muted-foreground">
          {summary.skippedNonMarkdown} non-markdown file
          {summary.skippedNonMarkdown === 1 ? "" : "s"} skipped — only <code>.md</code> documents
          ingest.
        </p>
      ) : null}
      {summary.rejected.length > 0 ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
            <AlertCircle className="size-4" />
            {summary.rejected.length} file{summary.rejected.length === 1 ? "" : "s"} rejected
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {summary.rejected.map((r) => (
              <li key={r.path} className="rounded bg-background px-2 py-1 text-xs">
                <span className="font-mono">{r.path}</span>
                <span className="text-muted-foreground"> — {r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
