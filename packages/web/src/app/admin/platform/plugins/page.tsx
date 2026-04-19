"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import {
  PlatformCatalogResponseSchema,
  type CatalogEntry,
} from "@/ui/lib/admin-schemas";
import { PLAN_TIERS } from "@/ui/lib/types";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import {
  Puzzle,
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from "lucide-react";

// ── Constants ────────────────────────────────────────────────────

const PLUGIN_TYPES = ["datasource", "context", "interaction", "action", "sandbox"] as const;

const TYPE_LABELS: Record<string, string> = {
  datasource: "Datasource",
  context: "Context",
  interaction: "Interaction",
  action: "Action",
  sandbox: "Sandbox",
};

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  trial: "Trial",
  team: "Team",
  enterprise: "Enterprise",
};

// ── Form Schema ──────────────────────────────────────────────────

const catalogFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Lowercase alphanumeric with hyphens only"),
  description: z.string().max(2000).optional().or(z.literal("")),
  type: z.enum(PLUGIN_TYPES),
  npmPackage: z.string().max(200).optional().or(z.literal("")),
  iconUrl: z.string().url("Must be a valid URL").max(500).optional().or(z.literal("")),
  configSchema: z.string().optional().or(z.literal("")),
  minPlan: z.enum(PLAN_TIERS),
  enabled: z.boolean(),
});

type CatalogFormValues = z.infer<typeof catalogFormSchema>;

// ── Catalog Form Dialog ──────────────────────────────────────────

function CatalogFormDialog({
  entry,
  open,
  onOpenChange,
  onSaved,
}: {
  entry: CatalogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const isEdit = entry !== null;

  const form = useForm<CatalogFormValues>({
    resolver: zodResolver(catalogFormSchema as z.ZodType<CatalogFormValues, CatalogFormValues>),
    defaultValues: {
      name: entry?.name ?? "",
      slug: entry?.slug ?? "",
      description: entry?.description ?? "",
      type: (entry?.type as CatalogFormValues["type"]) ?? "datasource",
      npmPackage: entry?.npmPackage ?? "",
      iconUrl: entry?.iconUrl ?? "",
      configSchema: (() => {
        if (!entry?.configSchema) return "";
        try {
          return JSON.stringify(entry.configSchema, null, 2);
        } catch (err) {
          console.warn("Failed to serialize configSchema:", err instanceof Error ? err.message : String(err));
          return String(entry.configSchema);
        }
      })(),
      minPlan: (PLAN_TIERS as readonly string[]).includes(entry?.minPlan ?? "")
        ? (entry!.minPlan as CatalogFormValues["minPlan"])
        : "starter",
      enabled: entry?.enabled ?? true,
    },
  });

  const createMutation = useAdminMutation({ method: "POST" });
  const updateMutation = useAdminMutation({ method: "PUT" });
  const mutation = isEdit ? updateMutation : createMutation;

  function handleOpenChange(next: boolean) {
    if (!next) {
      form.reset();
      createMutation.reset();
      updateMutation.reset();
    }
    onOpenChange(next);
  }

  async function onSubmit(values: CatalogFormValues) {
    const body: Record<string, unknown> = {
      name: values.name,
      type: values.type,
      minPlan: values.minPlan,
      enabled: values.enabled,
    };

    if (!isEdit) body.slug = values.slug;
    if (values.description) body.description = values.description;
    if (values.npmPackage) body.npmPackage = values.npmPackage;
    if (values.iconUrl) body.iconUrl = values.iconUrl;
    if (values.configSchema) {
      try {
        body.configSchema = JSON.parse(values.configSchema);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        form.setError("configSchema", { message: `Invalid JSON: ${detail}` });
        return;
      }
    }

    const path = isEdit
      ? `/api/v1/platform/plugins/catalog/${encodeURIComponent(entry.id)}`
      : "/api/v1/platform/plugins/catalog";

    const result = await mutation.mutate({ path, body });
    if (result.ok) {
      onSaved();
      handleOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Catalog Entry" : "Add Plugin to Catalog"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this catalog entry. Changes affect workspace visibility."
              : "Add a new plugin to the catalog. Workspaces can install it based on their plan."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="My Plugin" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="my-plugin"
                        disabled={isEdit}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {isEdit ? "Cannot be changed after creation" : "Unique identifier"}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What this plugin does..."
                      rows={2}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PLUGIN_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {TYPE_LABELS[t]}
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
                name="minPlan"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Minimum Plan</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PLAN_TIERS.map((t) => (
                          <SelectItem key={t} value={t}>
                            {PLAN_LABELS[t] ?? t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="npmPackage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>npm Package</FormLabel>
                  <FormControl>
                    <Input placeholder="@useatlas/plugin-example" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="iconUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Icon URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="configSchema"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Config Schema (JSON)</FormLabel>
                  <FormControl>
                    <Textarea
                      className="font-mono text-xs"
                      placeholder='{"properties": { ... }}'
                      rows={4}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    JSON Schema for plugin configuration fields
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex items-center gap-3 space-y-0">
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormLabel className="font-normal">
                    Enabled — visible to workspaces
                  </FormLabel>
                </FormItem>
              )}
            />

            {mutation.error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {mutation.error}
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.saving}>
                {mutation.saving && <Loader2 className="mr-1 size-3 animate-spin" />}
                {isEdit ? "Save Changes" : "Add to Catalog"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ────────────────────────────────────────────────────

export default function PlatformPluginCatalogPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return <LoadingState message="Checking permissions..." />;
  return (
    <ErrorBoundary>
      <PlatformPluginCatalogPageContent />
    </ErrorBoundary>
  );
}

function PlatformPluginCatalogPageContent() {
  const [editEntry, setEditEntry] = useState<CatalogEntry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CatalogEntry | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const toggleMutation = useAdminMutation({ method: "PUT" });
  const deleteMutation = useAdminMutation({ method: "DELETE" });

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/platform/plugins/catalog",
    { schema: PlatformCatalogResponseSchema },
  );

  const entries = data?.entries ?? [];

  function handleAdd() {
    setEditEntry(null);
    setFormOpen(true);
  }

  function handleEdit(entry: CatalogEntry) {
    setEditEntry(entry);
    setFormOpen(true);
  }

  async function handleToggle(entry: CatalogEntry) {
    setMutationError(null);
    const result = await toggleMutation.mutate({
      path: `/api/v1/platform/plugins/catalog/${encodeURIComponent(entry.id)}`,
      body: { enabled: !entry.enabled },
      itemId: entry.id,
    });
    if (result.ok) {
      refetch();
    } else {
      setMutationError(`Failed to ${entry.enabled ? "disable" : "enable"} "${entry.name}": ${friendlyError(result.error)}`);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setMutationError(null);
    const result = await deleteMutation.mutate({
      path: `/api/v1/platform/plugins/catalog/${encodeURIComponent(deleteTarget.id)}`,
    });
    if (result.ok) {
      refetch();
    } else {
      setMutationError(`Failed to delete "${deleteTarget.name}": ${friendlyError(result.error)}`);
    }
    setDeleteTarget(null);
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Plugin Catalog</h1>
          <p className="text-sm text-muted-foreground">
            Manage the global plugin catalog. Workspaces install plugins from this list.
          </p>
        </div>
        <Button onClick={handleAdd}>
          <Plus className="mr-1 size-4" />
          Add Plugin
        </Button>
      </div>

      <>
        {mutationError && (
          <div className="mb-4">
            <ErrorBanner message={mutationError} onRetry={refetch} />
          </div>
        )}

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Plugin Catalog"
          onRetry={refetch}
          loadingMessage="Loading catalog..."
          emptyIcon={Puzzle}
          emptyTitle="No plugins in catalog"
          emptyDescription="Add plugins to the catalog so workspaces can discover and install them."
          emptyAction={{ label: "Add Plugin", onClick: handleAdd }}
          isEmpty={entries.length === 0}
        >
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plugin</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Min Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[100px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow
                    key={entry.id}
                    className={cn(!entry.enabled && "opacity-60")}
                  >
                    <TableCell>
                      <div>
                        <div className="font-medium">{entry.name}</div>
                        <div className="text-xs text-muted-foreground">{entry.slug}</div>
                        {entry.description && (
                          <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                            {entry.description}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {TYPE_LABELS[entry.type] ?? entry.type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {PLAN_LABELS[entry.minPlan] ?? entry.minPlan}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Switch
                        size="sm"
                        checked={entry.enabled}
                        onCheckedChange={() => handleToggle(entry)}
                        disabled={toggleMutation.isMutating(entry.id)}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(entry.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={() => handleEdit(entry)}
                          title="Edit"
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(entry)}
                          title="Delete"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </AdminContentWrapper>

        {/* Add/Edit dialog — key forces remount so useForm picks up new defaultValues */}
        <CatalogFormDialog
          key={editEntry?.id ?? "new"}
          entry={editEntry}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={refetch}
        />

        {/* Delete confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove the plugin from the catalog and <strong>automatically uninstall it
                from all workspaces</strong> that currently have it. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleteMutation.saving && <Loader2 className="mr-1 size-3 animate-spin" />}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    </div>
  );
}
