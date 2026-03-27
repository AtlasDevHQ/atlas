"use client";

import { useState } from "react";
import { z } from "zod";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
import { getApiKeyColumns, type ApiKeyRow } from "./columns";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Key, Plus, Copy, Check, Loader2 } from "lucide-react";

// -- Types --

interface ListApiKeysResponse {
  apiKeys: ApiKeyRow[];
  total: number;
}

interface CreateApiKeyResponse {
  key: string;
  id: string;
  name: string;
}

// -- Schema --

const createKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name must be 100 characters or fewer"),
});

// -- Component --

export default function ApiKeysPage() {
  // List API keys
  const {
    data: listData,
    loading,
    error,
    refetch,
  } = useAdminFetch<ListApiKeysResponse>("/api/auth/api-key/list");
  const apiKeys = listData?.apiKeys ?? [];

  // Create mutation — no invalidates here because onSuccess captures
  // the key for display before triggering refetch manually.
  const createMutation = useAdminMutation<CreateApiKeyResponse>({
    path: "/api/auth/api-key/create",
    method: "POST",
  });

  // Delete mutation
  const deleteMutation = useAdminMutation<{ success: boolean }>({
    path: "/api/auth/api-key/delete",
    method: "POST",
    invalidates: refetch,
  });

  // -- Dialog state --
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);

  // -- Data table --
  const columns = getApiKeyColumns({
    onRevoke: (apiKey) => { deleteMutation.reset(); setRevokeTarget(apiKey); },
  });

  const { table } = useDataTable({
    data: apiKeys,
    columns,
    pageCount: 1,
    initialState: {
      sorting: [{ id: "createdAt", desc: true }],
      pagination: { pageIndex: 0, pageSize: 100 },
    },
    getRowId: (row) => row.id,
  });

  // -- Handlers --

  function openCreateDialog() {
    createMutation.reset();
    setCreatedKey(null);
    setCopied(false);
    setCreateOpen(true);
  }

  async function handleCreate(values: z.infer<typeof createKeySchema>) {
    await createMutation.mutate({
      body: { name: values.name },
      onSuccess: (data) => {
        setCreatedKey({ key: data.key, name: data.name ?? values.name });
        refetch();
      },
    });
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // intentionally ignored: clipboard API not available — user can select and copy manually
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    const result = await deleteMutation.mutate({
      body: { keyId: revokeTarget.id },
    });
    if (result.ok) {
      setRevokeTarget(null);
    }
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground">
            Create and manage API keys for programmatic access
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="mr-1.5 size-4" />
          Create API Key
        </Button>
      </div>

      <ErrorBoundary>
        <div className="space-y-6">
          {deleteMutation.error && (
            <ErrorBanner message={deleteMutation.error} onRetry={deleteMutation.clearError} />
          )}

          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="API Keys"
            onRetry={refetch}
            loadingMessage="Loading API keys..."
            emptyIcon={Key}
            emptyTitle="No API keys"
            emptyDescription="Create an API key for programmatic access to the Atlas API."
            emptyAction={{ label: "Create API Key", onClick: openCreateDialog }}
            isEmpty={apiKeys.length === 0}
          >
            <DataTable table={table}>
              <DataTableToolbar table={table}>
                <DataTableSortList table={table} />
              </DataTableToolbar>
            </DataTable>
          </AdminContentWrapper>
        </div>
      </ErrorBoundary>

      {/* Create dialog — result phase (show full key) */}
      {createdKey && (
        <Dialog
          open={createOpen && !!createdKey}
          onOpenChange={(open) => { if (!open) setCreateOpen(false); }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                Copy your API key now. You will not be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>API Key</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={createdKey.key}
                    className="h-9 font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0"
                    onClick={() => handleCopy(createdKey.key)}
                  >
                    {copied ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                <Key className="mt-0.5 size-4 text-amber-600 dark:text-amber-400" />
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Store this key securely. It will only be displayed once.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setCreateOpen(false)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Create dialog — form phase */}
      {!createdKey && (
        <FormDialog
          open={createOpen && !createdKey}
          onOpenChange={(open) => { if (!open) setCreateOpen(false); }}
          title="Create API key"
          description="Create a new API key for programmatic access. The key will be scoped to your current organization."
          schema={createKeySchema}
          defaultValues={{ name: "" }}
          onSubmit={handleCreate}
          submitLabel="Create"
          saving={createMutation.saving}
          serverError={createMutation.error}
          className="sm:max-w-md"
        >
          {(form) => (
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Production API"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </FormDialog>
      )}

      {/* Revoke confirmation dialog — uses Dialog (not AlertDialog) so we
          control open/close manually and can show inline errors on failure. */}
      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open && !deleteMutation.saving) setRevokeTarget(null); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              This will permanently revoke{" "}
              <strong>{revokeTarget?.name ?? "this API key"}</strong>.
              Any applications using this key will immediately lose access. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteMutation.error}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={deleteMutation.saving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={deleteMutation.saving}
            >
              {deleteMutation.saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
