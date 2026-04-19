"use client";

import { useState } from "react";
import { z } from "zod";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ListApiKeysResponseSchema } from "@/ui/lib/admin-schemas";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  CompactRow,
  DetailList,
  DetailRow,
  SectionHeading,
  Shell,
  type StatusKind,
} from "@/ui/components/admin/compact";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import { formatDate, formatDateTime } from "@/lib/format";
import { KeyRound, Plus, Copy, Check, Loader2, Trash2 } from "lucide-react";

// -- Types --

interface CreateApiKeyResponse {
  key: string;
  id: string;
  name: string;
}

// Subset of the Better Auth API key list response we render in the UI.
interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastRequest: string | null;
}

// -- Schema --

const createKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name must be 100 characters or fewer"),
});

// -- Helpers --

function maskedKey(prefix: string | null, start: string | null): string {
  const p = prefix ?? "key";
  const s = start ? `${start}...` : "...";
  return `${p}_${s}`;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

// -- Component --

export default function ApiKeysPage() {
  // List API keys
  const {
    data: listData,
    loading,
    error,
    refetch,
  } = useAdminFetch("/api/auth/api-key/list", { schema: ListApiKeysResponseSchema });
  const apiKeys: ApiKeyRow[] = listData?.apiKeys ?? [];

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
        if (!data) return;
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

  function requestRevoke(apiKey: ApiKeyRow) {
    deleteMutation.reset();
    setRevokeTarget(apiKey);
  }

  // Hero stat: "NN key(s) active" — active = not expired.
  const activeCount = apiKeys.filter((k) => !isExpired(k.expiresAt)).length;
  const totalCount = apiKeys.length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Hero */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">API keys</h1>
          <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
            <span className={cn(activeCount > 0 ? "text-primary" : "text-muted-foreground")}>
              {String(activeCount).padStart(2, "0")}
            </span>
            <span className="opacity-50">{" / "}</span>
            {String(totalCount).padStart(2, "0")} active
          </p>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          Create and manage API keys for programmatic access to the Atlas API.
        </p>
      </header>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="API Keys"
          onRetry={refetch}
          loadingMessage="Loading API keys..."
          isEmpty={false}
        >
          {deleteMutation.error && (
            <div className="mb-4">
              <ErrorBanner message={deleteMutation.error} onRetry={deleteMutation.clearError} />
            </div>
          )}

          <section>
            <SectionHeading
              title="Keys"
              description="Each key is shown with its prefix, creation date, and last-used timestamp"
            />
            <div className="space-y-2">
              {apiKeys.map((apiKey) => (
                <ApiKeyShell
                  key={apiKey.id}
                  apiKey={apiKey}
                  onRevoke={requestRevoke}
                />
              ))}

              <CompactRow
                icon={Plus}
                title={apiKeys.length === 0 ? "Create your first API key" : "Create another API key"}
                description={
                  apiKeys.length === 0
                    ? "Generate a scoped token for CLI, CI, or SDK access"
                    : "Mint another scoped token for programmatic access"
                }
                status="disconnected"
                action={
                  <Button size="sm" onClick={openCreateDialog}>
                    <Plus className="mr-1.5 size-3.5" />
                    New API key
                  </Button>
                }
              />
            </div>
          </section>
        </AdminContentWrapper>
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
                <KeyRound className="mt-0.5 size-4 text-amber-600 dark:text-amber-400" />
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

// ── Key row (Shell per key) ──────────────────────────────────────

function ApiKeyShell({
  apiKey,
  onRevoke,
}: {
  apiKey: ApiKeyRow;
  onRevoke: (apiKey: ApiKeyRow) => void;
}) {
  const expired = isExpired(apiKey.expiresAt);
  const status: StatusKind = expired ? "unavailable" : "connected";
  const displayName = apiKey.name ?? "Unnamed key";

  return (
    <Shell
      icon={KeyRound}
      title={displayName}
      description={
        expired
          ? "Expired — revoke to remove from the list"
          : apiKey.lastRequest
            ? `Last used ${formatDateTime(apiKey.lastRequest)}`
            : "Never used"
      }
      status={status}
      titleBadge={
        expired ? (
          <Badge variant="outline" className="shrink-0 border-destructive/30 text-[10px] text-destructive">
            Expired
          </Badge>
        ) : undefined
      }
      actions={
        <Button
          variant="outline"
          size="xs"
          onClick={() => onRevoke(apiKey)}
          className="text-destructive hover:text-destructive"
          aria-label={`Revoke ${displayName}`}
        >
          <Trash2 className="mr-1.5 size-3" />
          Revoke
        </Button>
      }
    >
      <DetailList>
        <DetailRow
          label="Key"
          value={maskedKey(apiKey.prefix, apiKey.start)}
          mono
          truncate
        />
        <DetailRow label="Created" value={formatDate(apiKey.createdAt)} />
        <DetailRow
          label="Last used"
          value={apiKey.lastRequest ? formatDateTime(apiKey.lastRequest) : "Never"}
        />
        {apiKey.expiresAt && (
          <DetailRow label="Expires" value={formatDate(apiKey.expiresAt)} />
        )}
      </DetailList>
    </Shell>
  );
}
