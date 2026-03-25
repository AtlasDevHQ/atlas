"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { z } from "zod";
import type { ColumnDef } from "@tanstack/react-table";
import type { PromptCollection, PromptItem } from "@/ui/lib/types";
import { PROMPT_INDUSTRIES } from "@/ui/lib/types";
import { promptsSearchParams } from "./search-params";
import { getPromptCollectionColumns, industryBadge } from "./columns";
import { useAtlasConfig } from "@/ui/context";
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/form-dialog";
import type { FetchError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  BookOpen,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
  MessageSquare,
  Calendar,
  Tag,
} from "lucide-react";

// -- Constants ----------------------------------------------------------------

const LIMIT = 50;
const INDUSTRY_TABS = ["", ...PROMPT_INDUSTRIES] as const;
const INDUSTRY_LABELS: Record<string, string> = {
  "": "All",
  saas: "SaaS",
  ecommerce: "E-commerce",
  cybersecurity: "Cybersecurity",
};

const collectionSchema = z.object({
  name: z.string().min(1, "Name is required"),
  industry: z.string().min(1, "Industry is required"),
  description: z.string(),
});

// -- Page ---------------------------------------------------------------------

export default function PromptsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin
    ? "include"
    : "same-origin";

  const [collections, setCollections] = useState<PromptCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  const [params, setParams] = useQueryStates(promptsSearchParams);

  // Item counts per collection
  const [itemCounts, setItemCounts] = useState<Map<string, number>>(new Map());

  // Detail sheet
  const [detailCollection, setDetailCollection] =
    useState<PromptCollection | null>(null);
  const [detailItems, setDetailItems] = useState<PromptItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Create / edit collection dialog
  const [collectionDialog, setCollectionDialog] = useState<{
    open: boolean;
    mode: "create" | "edit";
    collection?: PromptCollection;
  }>({ open: false, mode: "create" });

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<PromptCollection | null>(
    null,
  );

  // Add item form
  const [addItemQuestion, setAddItemQuestion] = useState("");
  const [addItemDescription, setAddItemDescription] = useState("");

  // Delete item confirmation
  const [deleteItemTarget, setDeleteItemTarget] = useState<PromptItem | null>(
    null,
  );

  // Mutation hooks
  const collectionMutation = useAdminMutation<PromptCollection>({
    invalidates: () => setFetchKey((k) => k + 1),
  });
  const deleteCollectionMutation = useAdminMutation({
    method: "DELETE",
    invalidates: () => setFetchKey((k) => k + 1),
  });
  const addItemMutation = useAdminMutation<PromptItem>({ method: "POST" });
  const deleteItemMutation = useAdminMutation({ method: "DELETE" });

  // -- Fetch collections ------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function fetchCollections() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/prompts`, {
          credentials,
        });
        if (!res.ok) {
          if (!cancelled) {
            let msg = `HTTP ${res.status}`;
            try {
              msg = (await res.json()).message ?? msg;
            } catch {
              /* intentionally ignored: response may not be JSON */
            }
            setError({ message: msg, status: res.status });
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setCollections(data.collections ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError({
            message:
              err instanceof Error ? err.message : "Failed to load collections",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchCollections();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, credentials, fetchKey]);

  // -- Fetch item counts for all collections ----------------------------------

  useEffect(() => {
    if (collections.length === 0) return;
    let cancelled = false;

    async function fetchCounts() {
      try {
        const results = await Promise.all(
          collections.map(async (c) => {
            try {
              const res = await fetch(`${apiUrl}/api/v1/prompts/${c.id}`, {
                credentials,
              });
              if (!res.ok) {
                console.debug(`Failed to fetch item count for collection ${c.id}: HTTP ${res.status}`);
                return { id: c.id, count: 0 };
              }
              const data = await res.json();
              return {
                id: c.id,
                count: (data.items as PromptItem[] | undefined)?.length ?? 0,
              };
            } catch (err) {
              // Non-critical — just show 0
              console.debug(`Failed to fetch item count for collection ${c.id}:`, err instanceof Error ? err.message : String(err));
              return { id: c.id, count: 0 };
            }
          }),
        );
        if (!cancelled) {
          const map = new Map<string, number>();
          for (const r of results) {
            map.set(r.id, r.count);
          }
          setItemCounts(map);
        }
      } catch (err) {
        console.debug("Failed to fetch item counts:", err instanceof Error ? err.message : String(err));
      }
    }

    fetchCounts();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, credentials, collections]);

  // -- Fetch detail items when sheet opens ------------------------------------

  useEffect(() => {
    if (!detailCollection) {
      setDetailItems([]);
      return;
    }
    let cancelled = false;

    async function fetchItems() {
      setDetailLoading(true);
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/prompts/${detailCollection!.id}`,
          { credentials },
        );
        if (!res.ok) {
          console.debug(`Failed to fetch items for collection: HTTP ${res.status}`);
          if (!cancelled) setDetailItems([]);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setDetailItems(data.items ?? []);
        }
      } catch (err) {
        console.debug(
          "Failed to fetch collection items:",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    fetchItems();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, credentials, detailCollection]);

  // -- Filter collections by industry -----------------------------------------

  const filtered = params.industry
    ? collections.filter((c) => c.industry === params.industry)
    : collections;

  // -- Actions ----------------------------------------------------------------

  function openCreateDialog() {
    setCollectionDialog({ open: true, mode: "create" });
  }

  function openEditDialog(collection: PromptCollection) {
    setCollectionDialog({ open: true, mode: "edit", collection });
  }

  async function submitCollectionForm(values: z.infer<typeof collectionSchema>) {
    const isEdit = collectionDialog.mode === "edit";
    const path = isEdit
      ? `/api/v1/admin/prompts/${collectionDialog.collection!.id}`
      : `/api/v1/admin/prompts`;

    await collectionMutation.mutate({
      path,
      method: isEdit ? "PATCH" : "POST",
      body: {
        name: values.name,
        industry: values.industry,
        description: values.description,
      },
      onSuccess: (updated) => {
        if (detailCollection?.id === updated.id) {
          setDetailCollection(updated);
        }
        setCollectionDialog({ open: false, mode: "create" });
      },
    });
  }

  async function deleteCollection(id: string) {
    await deleteCollectionMutation.mutate({
      path: `/api/v1/admin/prompts/${id}`,
      itemId: id,
      onSuccess: () => {
        if (detailCollection?.id === id) setDetailCollection(null);
      },
    });
    setDeleteTarget(null);
  }

  async function addItem() {
    if (!detailCollection || !addItemQuestion.trim()) return;

    await addItemMutation.mutate({
      path: `/api/v1/admin/prompts/${detailCollection.id}/items`,
      body: {
        question: addItemQuestion.trim(),
        description: addItemDescription.trim() || null,
      },
      onSuccess: (newItem) => {
        setDetailItems((prev) => [...prev, newItem]);
        setItemCounts((prev) => {
          const next = new Map(prev);
          next.set(detailCollection.id, (next.get(detailCollection.id) ?? 0) + 1);
          return next;
        });
        setAddItemQuestion("");
        setAddItemDescription("");
      },
    });
  }

  async function deleteItem(item: PromptItem) {
    if (!detailCollection) return;

    await deleteItemMutation.mutate({
      path: `/api/v1/admin/prompts/${detailCollection.id}/items/${item.id}`,
      itemId: item.id,
      onSuccess: () => {
        setDetailItems((prev) => prev.filter((i) => i.id !== item.id));
        setItemCounts((prev) => {
          const next = new Map(prev);
          const current = next.get(detailCollection.id) ?? 1;
          next.set(detailCollection.id, Math.max(0, current - 1));
          return next;
        });
      },
    });
    setDeleteItemTarget(null);
  }

  // -- Column definitions with actions ----------------------------------------

  const columns: ColumnDef<PromptCollection>[] = (() => {
    const base = getPromptCollectionColumns(itemCounts);
    const actionsCol: ColumnDef<PromptCollection> = {
      id: "actions",
      header: () => null,
      cell: ({ row }) => {
        const collection = row.original;
        if (collection.isBuiltin) return null;
        const busy = deleteCollectionMutation.isMutating(collection.id);
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                disabled={busy}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEditDialog(collection)}>
                <Pencil className="mr-2 size-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setDeleteTarget(collection)}
              >
                <Trash2 className="mr-2 size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
      enableSorting: false,
      enableHiding: false,
      size: 64,
    };
    return [...base, actionsCol];
  })();

  // -- Data table -------------------------------------------------------------

  const pageCount = Math.max(1, Math.ceil(filtered.length / LIMIT));
  const paginatedData = filtered.slice(
    (params.page - 1) * LIMIT,
    params.page * LIMIT,
  );

  const { table } = useDataTable({
    data: paginatedData,
    columns,
    pageCount,
    initialState: {
      sorting: [{ id: "createdAt", desc: true }],
      pagination: { pageIndex: 0, pageSize: LIMIT },
    },
    getRowId: (row) => row.id,
  });

  // -- Stats ------------------------------------------------------------------

  const stats = {
    total: collections.length,
    builtin: collections.filter((c) => c.isBuiltin).length,
    custom: collections.filter((c) => !c.isBuiltin).length,
    totalItems: Array.from(itemCounts.values()).reduce((a, b) => a + b, 0),
  };

  const hasFilters = !!params.industry;

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Prompt Library</h1>
          <p className="text-sm text-muted-foreground">
            Manage prompt collections and starter questions
          </p>
        </div>
        <Button size="sm" onClick={openCreateDialog}>
          <Plus className="mr-1.5 size-3.5" />
          New Collection
        </Button>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {/* Stats */}
          {!loading && (
            <div className="grid gap-4 sm:grid-cols-4">
              <StatCard
                title="Total Collections"
                value={stats.total.toLocaleString()}
                icon={<BookOpen className="size-4" />}
              />
              <StatCard
                title="Built-in"
                value={stats.builtin.toLocaleString()}
                icon={<Tag className="size-4" />}
              />
              <StatCard
                title="Custom"
                value={stats.custom.toLocaleString()}
                icon={<Pencil className="size-4" />}
              />
              <StatCard
                title="Total Items"
                value={stats.totalItems.toLocaleString()}
                icon={<MessageSquare className="size-4" />}
              />
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Industry
              </label>
              <Tabs
                value={params.industry}
                onValueChange={(v) => {
                  table.setPageIndex(0);
                  setParams({ industry: v, page: 1 });
                }}
              >
                <TabsList>
                  {INDUSTRY_TABS.map((s) => (
                    <TabsTrigger key={s || "all"} value={s}>
                      {INDUSTRY_LABELS[s] ?? s}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => {
                  table.setPageIndex(0);
                  setParams({ industry: "", page: 1 });
                }}
              >
                <X className="mr-1.5 size-3.5" />
                Clear filters
              </Button>
            )}
          </div>

          {/* Content */}
          {collectionMutation.error && <ErrorBanner message={collectionMutation.error} onRetry={collectionMutation.clearError} />}
          {deleteCollectionMutation.error && <ErrorBanner message={deleteCollectionMutation.error} onRetry={deleteCollectionMutation.clearError} />}
          {addItemMutation.error && <ErrorBanner message={addItemMutation.error} onRetry={addItemMutation.clearError} />}
          {deleteItemMutation.error && <ErrorBanner message={deleteItemMutation.error} onRetry={deleteItemMutation.clearError} />}

          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Prompt Library"
            onRetry={() => setFetchKey((k) => k + 1)}
            loadingMessage="Loading prompt collections..."
            emptyIcon={BookOpen}
            emptyTitle="No prompt collections"
            emptyDescription="Create a collection to add starter questions for your users."
            emptyAction={{ label: "Create collection", onClick: openCreateDialog }}
            isEmpty={filtered.length === 0}
            hasFilters={hasFilters}
            onClearFilters={() => setParams({ industry: "", page: 1 })}
          >
            <DataTable
              table={table}
              onRowClick={(row, e) => {
                if (
                  (e.target as HTMLElement).closest(
                    '[role="checkbox"], button',
                  )
                )
                  return;
                setDetailCollection(row.original);
              }}
            >
              <DataTableToolbar table={table}>
                <DataTableSortList table={table} />
              </DataTableToolbar>
            </DataTable>
          </AdminContentWrapper>
        </div>
      </ErrorBoundary>

      {/* Detail Sheet */}
      <Sheet
        open={!!detailCollection}
        onOpenChange={(open) => {
          if (!open) setDetailCollection(null);
        }}
      >
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          {detailCollection && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {detailCollection.name}
                  {detailCollection.isBuiltin && (
                    <Badge
                      variant="outline"
                      className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400"
                    >
                      Built-in
                    </Badge>
                  )}
                </SheetTitle>
                <SheetDescription>
                  {detailCollection.description || "No description"}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                {/* Metadata */}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Tag className="size-3" /> Industry
                    </span>
                    <div>
                      {(() => {
                        const badge =
                          industryBadge[detailCollection.industry] ?? {
                            variant: "outline" as const,
                            className:
                              "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-400",
                            label: detailCollection.industry,
                          };
                        return (
                          <Badge
                            variant={badge.variant}
                            className={badge.className}
                          >
                            {badge.label}
                          </Badge>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Calendar className="size-3" /> Created
                    </span>
                    <p className="text-xs">
                      {new Date(detailCollection.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>

                {/* Items list */}
                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">
                      Items ({detailItems.length})
                    </h3>
                  </div>

                  {detailLoading ? (
                    <div className="flex h-20 items-center justify-center">
                      <LoadingState message="Loading items..." />
                    </div>
                  ) : detailItems.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-4 text-center">
                      No items in this collection.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {detailItems.map((item) => (
                        <div
                          key={item.id}
                          className="group flex items-start gap-2 rounded-md border p-3"
                        >
                          <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm">{item.question}</p>
                            {item.description && (
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {item.description}
                              </p>
                            )}
                          </div>
                          {!detailCollection.isBuiltin && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-7 p-0 opacity-0 group-hover:opacity-100 shrink-0"
                              onClick={() => setDeleteItemTarget(item)}
                              disabled={deleteItemMutation.isMutating(item.id)}
                            >
                              <Trash2 className="size-3.5 text-destructive" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add item form — only for non-built-in collections */}
                  {!detailCollection.isBuiltin && (
                    <div className="space-y-2 border-t pt-4">
                      <h4 className="text-xs font-medium text-muted-foreground">
                        Add Item
                      </h4>
                      <Input
                        placeholder="Question..."
                        value={addItemQuestion}
                        onChange={(e) => setAddItemQuestion(e.target.value)}
                      />
                      <Input
                        placeholder="Description (optional)"
                        value={addItemDescription}
                        onChange={(e) => setAddItemDescription(e.target.value)}
                      />
                      <Button
                        size="sm"
                        onClick={addItem}
                        disabled={addItemMutation.saving || !addItemQuestion.trim()}
                      >
                        <Plus className="mr-1.5 size-3.5" />
                        Add
                      </Button>
                    </div>
                  )}
                </div>

                {/* Actions for non-built-in */}
                {!detailCollection.isBuiltin && (
                  <div className="flex gap-2 border-t pt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEditDialog(detailCollection)}
                    >
                      <Pencil className="mr-1.5 size-3.5" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setDetailCollection(null);
                        setDeleteTarget(detailCollection);
                      }}
                      disabled={deleteCollectionMutation.isMutating(detailCollection.id)}
                    >
                      <Trash2 className="mr-1.5 size-3.5" />
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Create / Edit Collection Dialog */}
      <FormDialog
        open={collectionDialog.open}
        onOpenChange={(open) => {
          if (!open) setCollectionDialog({ open: false, mode: "create" });
        }}
        title={collectionDialog.mode === "edit" ? "Edit Collection" : "New Collection"}
        description={
          collectionDialog.mode === "edit"
            ? "Update the collection details."
            : "Create a new prompt collection with starter questions."
        }
        schema={collectionSchema}
        defaultValues={
          collectionDialog.mode === "edit" && collectionDialog.collection
            ? { name: collectionDialog.collection.name, industry: collectionDialog.collection.industry, description: collectionDialog.collection.description }
            : { name: "", industry: "", description: "" }
        }
        onSubmit={submitCollectionForm}
        submitLabel={collectionDialog.mode === "edit" ? "Save Changes" : "Create"}
        saving={collectionMutation.saving}
        serverError={collectionMutation.error}
      >
        {(form) => (
          <>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Revenue Analysis" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="industry"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Industry</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select an industry" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PROMPT_INDUSTRIES.map((ind) => (
                        <SelectItem key={ind} value={ind}>
                          {INDUSTRY_LABELS[ind] ?? ind}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What this collection is about..."
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </>
        )}
      </FormDialog>

      {/* Delete collection confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete collection?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.name}&rdquo;
              and all its items. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) deleteCollection(deleteTarget.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete item confirmation */}
      <AlertDialog
        open={!!deleteItemTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteItemTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete item?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this prompt item. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteItemTarget) deleteItem(deleteItemTarget);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
