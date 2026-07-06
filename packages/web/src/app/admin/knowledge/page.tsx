"use client";

import { useState } from "react";
import { useQueryStates } from "nuqs";
import { toast } from "sonner";
import { BookText, FileUp, FolderPlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
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
import type {
  KnowledgeCollection,
  KnowledgeCollectionListResponse,
  KnowledgeSyncRunResponse,
} from "@/ui/lib/types";
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
  const [editTarget, setEditTarget] = useState<KnowledgeCollection | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<KnowledgeCollection | null>(null);

  const uninstallMutation = useAdminMutation({ method: "DELETE" });
  const syncMutation = useAdminMutation<KnowledgeSyncRunResponse>({ method: "POST" });
  const [syncingSlug, setSyncingSlug] = useState<string | null>(null);

  const collections = data?.collections ?? [];
  // Hero readout: published-vs-total across every collection. The gap (total −
  // published) is the review backlog — surfacing it up top mirrors the way
  // Connections leads with its live/total count.
  const totalPublished = collections.reduce((n, c) => n + c.documents.published, 0);
  const totalDocuments = collections.reduce(
    (n, c) => n + c.documents.published + c.documents.draft,
    0,
  );

  async function handleSyncNow(slug: string) {
    setSyncingSlug(slug);
    try {
      const result = await syncMutation.mutate({
        path: `/api/v1/admin/knowledge/${encodeURIComponent(slug)}/sync`,
      });
      if (result.ok && result.data) {
        if (result.data.status === "success") {
          const d = result.data.documents;
          toast.success(
            `Synced "${slug}" — ${d ? `${d.created} new, ${d.updated + d.demoted} changed, ${d.unchanged} unchanged` : "done"}${
              result.data.archivedAbsent ? `, ${result.data.archivedAbsent} archived` : ""
            }`,
          );
        } else {
          // The attempt completed but the sync failed — surface the actionable
          // message; the card's status line shows it too after refetch.
          toast.error(result.data.error ?? `Sync of "${slug}" failed.`);
        }
        void refetch();
      } else if (result.ok) {
        // A 2xx with no parseable body shouldn't silently no-op — the sync may
        // still have run, so refetch to pick up the recorded state.
        toast.warning(`Sync of "${slug}" finished but returned no report — refreshing status.`);
        void refetch();
      }
      // On a transport/HTTP failure the surface below the list renders the error.
    } finally {
      setSyncingSlug(null);
    }
  }

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
    <div className="mx-auto max-w-4xl px-6 py-10">
      {/* Hero — the shared admin header shape (eyebrow · title · readout ·
          description · primary action), matching Connections and the other
          revamped admin surfaces. */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">Knowledge Base</h1>
          {totalDocuments > 0 ? (
            <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
              <span className={cn(totalPublished > 0 ? "text-primary" : "text-muted-foreground")}>
                {totalPublished}
              </span>
              <span className="opacity-50">{" / "}</span>
              {totalDocuments} published
            </p>
          ) : null}
        </div>
        <div className="flex items-end justify-between gap-6">
          <p className="max-w-xl text-sm text-muted-foreground">
            Host OKF knowledge collections the agent reads as descriptive context, never as
            queryable data. Uploads land as drafts for review before they reach the agent.
          </p>
          <Button onClick={() => setCreateOpen(true)} size="sm" data-testid="new-collection">
            <FolderPlus className="mr-1.5 size-4" />
            New collection
          </Button>
        </div>
      </header>

      <div className="space-y-6">
        {uninstallMutation.error ? (
          <MutationErrorSurface
            feature="Knowledge Base"
            error={uninstallMutation.error}
            variant="banner"
          />
        ) : null}
        {syncMutation.error ? (
          <MutationErrorSurface
            feature="Knowledge Base"
            error={syncMutation.error}
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
                  syncing={syncingSlug === collection.slug}
                  onView={() => void setParams({ collection: collection.slug })}
                  onUpload={() => setUploadTarget(collection.slug)}
                  onSync={() => void handleSyncNow(collection.slug)}
                  onEdit={() => setEditTarget(collection)}
                  onUninstall={() => setUninstallTarget(collection)}
                />
              ))}
            </div>
          </TooltipProvider>
        </AdminContentWrapper>
      </div>

      <CreateCollectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingSlugs={collections.map((c) => c.slug)}
        onCreated={(slug, source) => {
          setCreateOpen(false);
          void refetch();
          if (source !== "upload") {
            // Initial full ingest for any synced source (endpoint or connector):
            // kick the first pull right away rather than waiting for the
            // scheduled sync (daily by default).
            void handleSyncNow(slug);
          } else {
            setUploadTarget(slug);
          }
        }}
      />

      {/* Edit sync settings — re-drives the install pipeline with the existing
          slug: the container config upserts in place and the credential rotates
          without touching the collection's documents (the only other path is
          uninstall-and-recreate, which archives and un-publishes them all). */}
      <CreateCollectionDialog
        open={editTarget !== null}
        onOpenChange={(next) => !next && setEditTarget(null)}
        existingSlugs={[]}
        edit={
          editTarget
            ? {
                slug: editTarget.slug,
                endpointUrl: editTarget.endpointUrl,
                authScheme: editTarget.authScheme ?? "none",
                description: editTarget.description,
              }
            : null
        }
        onCreated={(slug) => {
          setEditTarget(null);
          void refetch();
          // Verify the new endpoint/secret immediately rather than waiting for
          // the nightly schedule — a failed rotation surfaces right away.
          void handleSyncNow(slug);
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
              {uninstallTarget && uninstallTarget.source !== "upload"
                ? "Documents are archived, never deleted — but re-installing this synced collection pulls its source again, which restores them as drafts for re-review."
                : "Documents are archived, never deleted — re-installing alone does not resurrect them; only re-uploading a bundle with the same paths brings them back, as drafts."}
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

/**
 * Classify a synced collection's footer state (the card renders the actual
 * line): `null` for upload collections, `"never-synced"` before the first
 * attempt, else the last attempt's outcome. Exported for tests.
 */
export function describeSync(collection: KnowledgeCollection): "synced" | "sync-failed" | "never-synced" | null {
  // Every non-upload source is synced (endpoint or connector) and carries
  // last-sync bookkeeping; only upload collections have no sync footer.
  if (collection.source === "upload") return null;
  if (!collection.sync) return "never-synced";
  return collection.sync.status === "success" ? "synced" : "sync-failed";
}

function CollectionCard({
  collection,
  syncing,
  onView,
  onUpload,
  onSync,
  onEdit,
  onUninstall,
}: {
  collection: KnowledgeCollection;
  syncing: boolean;
  onView: () => void;
  onUpload: () => void;
  onSync: () => void;
  onEdit: () => void;
  onUninstall: () => void;
}) {
  const { draft, published } = collection.documents;
  const isSynced = collection.source !== "upload";
  // Endpoint / auth are editable only for bundle-sync; a connector collection
  // (Notion) has a token, not an endpoint, so it gets "Sync now" but no
  // endpoint-edit dialog.
  const isEndpointEditable = collection.source === "bundle-sync";
  const syncState = describeSync(collection);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate font-mono text-base" title={collection.slug}>
            {collection.slug}
          </CardTitle>
          <div className="flex shrink-0 gap-1.5">
            {isSynced ? <Badge variant="outline">synced</Badge> : null}
            <Badge variant="default">{published} published</Badge>
            <Badge variant="secondary">{draft} draft</Badge>
          </div>
        </div>
        {collection.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{collection.description}</p>
        ) : null}
        {isSynced && collection.endpointUrl ? (
          <p className="truncate text-xs text-muted-foreground" title={collection.endpointUrl}>
            {collection.endpointUrl}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {syncState === "never-synced" ? (
            "Never synced"
          ) : syncState === "synced" && collection.sync ? (
            <>
              Synced <RelativeTimestamp iso={collection.sync.lastSyncAt} />
            </>
          ) : syncState === "sync-failed" && collection.sync ? (
            <span
              className="text-destructive"
              title={collection.sync.error ?? "The last sync failed."}
            >
              Sync failed <RelativeTimestamp iso={collection.sync.lastSyncAt} />
            </span>
          ) : collection.installedAt ? (
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
          {isSynced ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onSync}
                disabled={syncing}
                data-testid={`sync-${collection.slug}`}
              >
                <RefreshCw className={`mr-1 size-3.5 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing…" : "Sync now"}
              </Button>
              {isEndpointEditable && collection.authScheme !== undefined ? (
                // Endpoint/auth edit is bundle-sync-only (a connector has no
                // endpoint). Also hidden during a web-before-API deploy-overlap
                // window (an older API omits authScheme): pre-filling "None"
                // there would delete the stored credential on a routine save.
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onEdit}
                  aria-label={`Edit sync settings for ${collection.slug}`}
                  data-testid={`edit-${collection.slug}`}
                >
                  <Pencil className="size-3.5" />
                </Button>
              ) : null}
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={onUpload} data-testid={`upload-${collection.slug}`}>
              <FileUp className="mr-1 size-3.5" />
              Upload
            </Button>
          )}
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
