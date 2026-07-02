"use client";

import { FileText } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { KnowledgeDocumentListResponseSchema } from "@/ui/lib/admin-schemas";
import type { KnowledgeDocumentListResponse } from "@/ui/lib/types";

/* ────────────────────────────────────────────────────────────────────────
 *  Documents drawer — per-collection document review (AC #3). Lists a
 *  collection's documents by path with their content-mode status so an admin
 *  can see what a bundle ingested and which documents are still pending
 *  publish. Promotion happens through the global Publish flow (the atomic
 *  publish endpoint) — this drawer is review-only.
 * ──────────────────────────────────────────────────────────────────────── */

export function DocumentsSheet({
  collectionSlug,
  onOpenChange,
}: {
  collectionSlug: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = collectionSlug !== null;
  const { data, loading, error, refetch } = useAdminFetch<KnowledgeDocumentListResponse>(
    collectionSlug ? `/api/v1/admin/knowledge/${encodeURIComponent(collectionSlug)}/documents` : "",
    { schema: KnowledgeDocumentListResponseSchema, enabled: open },
  );

  const documents = data?.documents ?? [];

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{collectionSlug ?? "Documents"}</SheetTitle>
          <SheetDescription>
            Documents in this collection. Drafts are visible only to admins (and to the agent in
            developer mode) until published.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 px-1">
          <AdminContentWrapper
            feature="Knowledge Base"
            loading={loading}
            error={error}
            onRetry={refetch}
            isEmpty={documents.length === 0}
            emptyIcon={FileText}
            emptyTitle="No documents yet"
            emptyDescription="Upload an OKF bundle to add documents to this collection."
          >
            <ul className="divide-y rounded-md border">
              {documents.map((docItem) => (
                <li key={docItem.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                  <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium" title={docItem.title ?? docItem.path}>
                      {docItem.title ?? docItem.path}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground" title={docItem.path}>
                      {docItem.path}
                    </div>
                  </div>
                  <Badge variant={docItem.status === "published" ? "default" : "secondary"}>
                    {docItem.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </AdminContentWrapper>
        </div>
      </SheetContent>
    </Sheet>
  );
}
