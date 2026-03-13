"use client";

import { useAtlasConfig } from "@/ui/context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { HealthBadge } from "@/ui/components/admin/health-badge";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { Cable, Loader2, Plus, Pencil, Trash2, Eye, EyeOff } from "lucide-react";
import { useAdminFetch, useInProgressSet, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  DB_TYPES,
  type ConnectionHealth,
  type ConnectionInfo,
  type ConnectionDetail,
} from "@/ui/lib/types";

// ── Helpers ───────────────────────────────────────────────────────

function mapHealthStatus(
  status?: ConnectionHealth["status"]
): "healthy" | "degraded" | "down" | "unknown" {
  if (!status) return "unknown";
  if (status === "unhealthy") return "down";
  return status;
}

// ── Connection Form Dialog ───────────────────────────────────────

interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editId?: string | null;
  editDetail?: ConnectionDetail | null;
  apiUrl: string;
  credentials: RequestCredentials;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

function ConnectionFormDialog({
  open,
  onOpenChange,
  editId,
  editDetail,
  apiUrl,
  credentials,
  onSuccess,
  onError,
}: ConnectionFormProps) {
  const isEdit = !!editId;
  const [id, setId] = useState("");
  const [dbType, setDbType] = useState("postgres");
  const [url, setUrl] = useState("");
  const [schema, setSchema] = useState("");
  const [description, setDescription] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset form when dialog opens
  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      if (isEdit && editDetail) {
        setId(editId!);
        setDbType(editDetail.dbType);
        setUrl(""); // URL is masked — user needs to re-enter if changing
        setSchema(editDetail.schema ?? "");
        setDescription(editDetail.description ?? "");
      } else {
        setId("");
        setDbType("postgres");
        setUrl("");
        setSchema("");
        setDescription("");
      }
      setShowUrl(false);
      setTesting(false);
      setTestResult(null);
      setSaving(false);
    }
    onOpenChange(nextOpen);
  }

  async function handleTest() {
    if (!url) {
      setTestResult({ ok: false, message: "Enter a connection URL first." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      // Use the dedicated test endpoint — works for both new and edit flows
      const res = await fetch(`${apiUrl}/api/v1/admin/connections/test`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, schema: schema || undefined }),
      });
      const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      if (res.ok) {
        setTestResult({
          ok: data.status === "healthy",
          message: data.status === "healthy"
            ? `Connected (${data.latencyMs}ms)`
            : data.message || "Connection unhealthy",
        });
      } else {
        setTestResult({ ok: false, message: data.message || `Test failed (HTTP ${res.status})` });
      }
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!isEdit && !id) {
      onError("Connection ID is required.");
      return;
    }
    if (!isEdit && !url) {
      onError("Connection URL is required.");
      return;
    }
    setSaving(true);
    try {
      const endpoint = isEdit
        ? `${apiUrl}/api/v1/admin/connections/${encodeURIComponent(editId!)}`
        : `${apiUrl}/api/v1/admin/connections`;
      const method = isEdit ? "PUT" : "POST";

      const body: Record<string, unknown> = {};
      if (!isEdit) {
        body.id = id;
        body.url = url;
        if (description) body.description = description;
        if (schema) body.schema = schema;
      } else {
        if (url) body.url = url;
        body.description = description;
        body.schema = schema || undefined;
      }

      const res = await fetch(endpoint, {
        method,
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        onError(data.message || `Save failed (HTTP ${res.status})`);
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  const showSchemaField = dbType === "postgres";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Connection" : "Add Connection"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the connection configuration. Leave URL empty to keep the current one."
              : "Add a new datasource connection."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {!isEdit && (
            <div className="grid gap-2">
              <Label htmlFor="conn-id">Connection ID</Label>
              <Input
                id="conn-id"
                placeholder="e.g. warehouse"
                value={id}
                onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, hyphens, underscores.
              </p>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="conn-type">Database Type</Label>
            <Select value={dbType} onValueChange={setDbType} disabled={isEdit}>
              <SelectTrigger id="conn-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DB_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="conn-url">Connection URL</Label>
            <div className="relative">
              <Input
                id="conn-url"
                type={showUrl ? "text" : "password"}
                placeholder={isEdit ? "(unchanged)" : "postgresql://user:pass@host:5432/dbname"}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3"
                onClick={() => setShowUrl(!showUrl)}
              >
                {showUrl ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
            {isEdit && editDetail?.maskedUrl && (
              <p className="text-xs text-muted-foreground font-mono">
                Current: {editDetail.maskedUrl}
              </p>
            )}
          </div>

          {showSchemaField && (
            <div className="grid gap-2">
              <Label htmlFor="conn-schema">Schema</Label>
              <Input
                id="conn-schema"
                placeholder="public"
                value={schema}
                onChange={(e) => setSchema(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                PostgreSQL schema (sets search_path). Leave empty for &quot;public&quot;.
              </p>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="conn-desc">Description</Label>
            <Textarea
              id="conn-desc"
              placeholder="Optional description shown in the agent system prompt"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          {testResult && (
            <div
              className={cn(
                "rounded-md px-3 py-2 text-sm",
                testResult.ok
                  ? "bg-green-500/10 text-green-700 dark:text-green-400"
                  : "bg-destructive/10 text-destructive"
              )}
            >
              {testResult.message}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={testing || !url}
          >
            {testing ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Test
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || (!isEdit && (!id || !url))}
          >
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {isEdit ? "Save Changes" : "Add Connection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Confirmation ──────────────────────────────────────────

interface DeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string | null;
  apiUrl: string;
  credentials: RequestCredentials;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

function DeleteConnectionDialog({
  open,
  onOpenChange,
  connectionId,
  apiUrl,
  credentials,
  onSuccess,
  onError,
}: DeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!connectionId) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/connections/${encodeURIComponent(connectionId)}`,
        { method: "DELETE", credentials }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        onError(data.message || `Delete failed (HTTP ${res.status})`);
        return;
      }
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Network error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Connection</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete the connection{" "}
            <span className="font-mono font-semibold">{connectionId}</span>?
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function ConnectionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const testing = useInProgressSet();
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDetail, setEditDetail] = useState<ConnectionDetail | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const { data: connections, loading, error, refetch } = useAdminFetch<ConnectionInfo[]>(
    "/api/v1/admin/connections",
    { transform: (json) => (json as { connections?: ConnectionInfo[] }).connections ?? [] },
  );

  const [localConnections, setLocalConnections] = useState<ConnectionInfo[] | null>(null);
  const displayConnections = localConnections ?? connections ?? [];

  if (connections && localConnections !== null && connections !== localConnections) {
    setLocalConnections(null);
  }

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
          <p className="text-sm text-muted-foreground">Manage datasource connections</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Connections" />
      </div>
    );
  }

  async function testConnection(id: string) {
    testing.start(id);
    setMutationError(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/connections/${encodeURIComponent(id)}/test`,
        { credentials, method: "POST" }
      );
      if (!res.ok) throw new Error(`Test failed (HTTP ${res.status})`);
      const result: ConnectionHealth = await res.json();
      setLocalConnections((prev) =>
        (prev ?? displayConnections).map((c) =>
          c.id === id ? { ...c, health: result } : c
        )
      );
    } catch (err) {
      setMutationError(
        `Connection test failed for "${id}": ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      testing.stop(id);
    }
  }

  function handleAdd() {
    setEditId(null);
    setEditDetail(null);
    setFormOpen(true);
  }

  async function handleEdit(id: string) {
    setMutationError(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/connections/${encodeURIComponent(id)}`,
        { credentials }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const detail: ConnectionDetail = await res.json();
      setEditId(id);
      setEditDetail(detail);
      setFormOpen(true);
    } catch (err) {
      setMutationError(
        `Failed to load connection details: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setLoadingDetail(false);
    }
  }

  function handleDelete(id: string) {
    setDeleteId(id);
    setDeleteOpen(true);
  }

  function handleMutationSuccess() {
    refetch();
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
          <p className="text-sm text-muted-foreground">Manage datasource connections</p>
        </div>
        <Button onClick={handleAdd} size="sm">
          <Plus className="mr-2 size-4" />
          Add Connection
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}
        {mutationError && <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />}

        {loading ? (
          <LoadingState message="Loading connections..." />
        ) : displayConnections.length === 0 && !error ? (
          <div className="p-6">
            <EmptyState
              icon={Cable}
              title="No datasource connections"
              description="Add a connection to start querying your data"
              action={{ label: "Add connection", onClick: handleAdd }}
            />
          </div>
        ) : displayConnections.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead className="w-[180px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayConnections.map((conn) => (
                <TableRow key={conn.id}>
                  <TableCell className="font-mono text-xs">{conn.id}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{conn.dbType}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {conn.description ?? "\u2014"}
                  </TableCell>
                  <TableCell>
                    <HealthBadge status={mapHealthStatus(conn.health?.status)} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {conn.health ? `${conn.health.latencyMs}ms` : "\u2014"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={testing.has(conn.id)}
                        onClick={() => testConnection(conn.id)}
                      >
                        {testing.has(conn.id) ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          "Test"
                        )}
                      </Button>
                      {conn.id !== "default" && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(conn.id)}
                            disabled={loadingDetail}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(conn.id)}
                          >
                            <Trash2 className="size-3.5 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </div>

      <ConnectionFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editId={editId}
        editDetail={editDetail}
        apiUrl={apiUrl}
        credentials={credentials}
        onSuccess={handleMutationSuccess}
        onError={setMutationError}
      />

      <DeleteConnectionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        connectionId={deleteId}
        apiUrl={apiUrl}
        credentials={credentials}
        onSuccess={handleMutationSuccess}
        onError={setMutationError}
      />
    </div>
  );
}
