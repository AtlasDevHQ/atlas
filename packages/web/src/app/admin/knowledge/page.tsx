"use client";

import { useState } from "react";
import { useQueryStates } from "nuqs";
import { toast } from "sonner";
import { BookText, FileUp, FolderPlus, Library, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { KnowledgeCollectionListResponseSchema } from "@/ui/lib/admin-schemas";
import type { KnowledgeCollection, KnowledgeCollectionListResponse } from "@/ui/lib/types";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { knowledgeSearchParams } from "./search-params";
import { CreateCollectionDialog } from "./create-collection-dialog";
import { UploadBundleDialog } from "./upload-bundle-dialog";
import { DocumentsSheet } from "./documents-sheet";

/**
 * `/admin/knowledge` — the Knowledge Base pillar's admin surface (#4209,
 * ADR-0028). Lists hosted-OKF collections with per-status document counts;
 * create is an explicit install, upload ingests a bundle (drafts by default),
 * uninstall archives. Documents promote to published only through the global
 * atomic publish flow.
 */
export default function KnowledgePage() {
  const { data, loading, error, refetch } = useAdminFetch<KnowledgeCollectionListResponse>(
    "/api/v1/admin/knowledge",
    { schema: KnowledgeCollectionListResponseSchema },
  );

  const [params, setParams] = useQueryStates(knowledgeSearchParams);
  const [createOpen, setCreateOpen] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<KnowledgeCollection | null>(null);

  const uninstallMutation = useAdminMutation({ method: "DELETE" });

  const collections = data?.collections ?? [];

  async function handleUninstall() {
    if (!uninstallTarget) return;
    const slug = uninstallTarget.slug;
    const result = await uninstallMutation.mutate({
      path: `/api/v1/admin/knowledge/${encodeURIComponent(slug)}`,
    });
    if (result.ok) {
      toast.success(`Collection "${slug}" archived`);
      setUninstallTarget(null);
      if (params.collection === slug) void setParams({ collection: null });
    }
    // On failure the surface below the list renders the error.
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Library className="size-6 text-muted-foreground" aria-hidden />
            Knowledge Base
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Host OKF knowledge collections the agent reads as descriptive context. Content is never
            queried as data or treated as authoritative — uploads land as drafts for review before
            they reach the agent.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-testid="new-collection">
          <FolderPlus className="mr-1.5 size-4" />
          New collection
        </Button>
      </div>

      {uninstallMutation.error ? (
        <MutationErrorSurface
          feature="Knowledge Base"
          error={uninstallMutation.error}
          variant="banner"
        />
      ) : null}

      <AdminContentWrapper
        feature="Knowledge Base"
        loading={loading}
        error={error}
        onRetry={refetch}
        isEmpty={collections.length === 0}
        emptyIcon={BookText}
        emptyTitle="No collections yet"
        emptyDescription="Create a collection, then upload an OKF bundle to give the agent descriptive context."
        emptyAction={{ label: "New collection", onClick: () => setCreateOpen(true) }}
      >
        <TooltipProvider delayDuration={250}>
          <div className="grid gap-4 sm:grid-cols-2">
            {collections.map((collection) => (
              <CollectionCard
                key={collection.slug}
                collection={collection}
                onView={() => void setParams({ collection: collection.slug })}
                onUpload={() => setUploadTarget(collection.slug)}
                onUninstall={() => setUninstallTarget(collection)}
              />
            ))}
          </div>
        </TooltipProvider>
      </AdminContentWrapper>

      <CreateCollectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingSlugs={collections.map((c) => c.slug)}
        onCreated={(slug) => {
          setCreateOpen(false);
          void refetch();
          setUploadTarget(slug);
        }}
      />

      <UploadBundleDialog
        collectionSlug={uploadTarget}
        open={uploadTarget !== null}
        onOpenChange={(next) => !next && setUploadTarget(null)}
        onIngested={() => void refetch()}
      />

      <DocumentsSheet
        collectionSlug={params.collection}
        onOpenChange={(next) => !next && setParams({ collection: null })}
      />

      <AlertDialog
        open={uninstallTarget !== null}
        onOpenChange={(next) => !next && setUninstallTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall &ldquo;{uninstallTarget?.slug}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              {uninstallTarget
                ? describeArchive(uninstallTarget)
                : ""}{" "}
              Documents are archived, never deleted — re-installing does not resurrect them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uninstallMutation.saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleUninstall();
              }}
              disabled={uninstallMutation.saving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="confirm-uninstall"
            >
              {uninstallMutation.saving ? "Archiving…" : "Uninstall"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Human sentence for what an uninstall will archive (AC #1). Exported for tests. */
export function describeArchive(collection: KnowledgeCollection): string {
  const active = collection.documents.draft + collection.documents.published;
  if (active === 0) return "This collection has no active documents.";
  const parts: string[] = [];
  if (collection.documents.published > 0) {
    parts.push(`${collection.documents.published} published`);
  }
  if (collection.documents.draft > 0) {
    parts.push(`${collection.documents.draft} draft`);
  }
  return `This will archive ${active} document${active === 1 ? "" : "s"} (${parts.join(", ")}).`;
}

function CollectionCard({
  collection,
  onView,
  onUpload,
  onUninstall,
}: {
  collection: KnowledgeCollection;
  onView: () => void;
  onUpload: () => void;
  onUninstall: () => void;
}) {
  const { draft, published } = collection.documents;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate font-mono text-base" title={collection.slug}>
            {collection.slug}
          </CardTitle>
          <div className="flex shrink-0 gap-1.5">
            <Badge variant="default">{published} published</Badge>
            <Badge variant="secondary">{draft} draft</Badge>
          </div>
        </div>
        {collection.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{collection.description}</p>
        ) : null}
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {collection.installedAt ? (
            <>
              Created <RelativeTimestamp iso={collection.installedAt} />
            </>
          ) : null}
        </span>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={onView} data-testid={`view-${collection.slug}`}>
            <BookText className="mr-1 size-3.5" />
            Documents
          </Button>
          <Button variant="outline" size="sm" onClick={onUpload} data-testid={`upload-${collection.slug}`}>
            <FileUp className="mr-1 size-3.5" />
            Upload
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onUninstall}
            aria-label={`Uninstall ${collection.slug}`}
            data-testid={`uninstall-${collection.slug}`}
          >
            <Trash2 className="size-3.5 text-destructive" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
