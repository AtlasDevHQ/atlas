"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/form-dialog";
import { z } from "zod";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { Shield, Plus, Trash2, Loader2, AlertTriangle, Globe } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface IPAllowlistEntry {
  id: string;
  orgId: string;
  cidr: string;
  description: string | null;
  createdAt: string;
  createdBy: string | null;
}

interface IPAllowlistResponse {
  entries: IPAllowlistEntry[];
  total: number;
  callerIP: string | null;
}

// ── Add Entry Dialog ──────────────────────────────────────────────

const ipEntrySchema = z.object({
  cidr: z.string().min(1, "CIDR range is required"),
  description: z.string(),
});

function AddEntryDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const saveMutation = useAdminMutation({
    path: "/api/v1/admin/ip-allowlist",
    method: "POST",
    invalidates: onAdded,
  });

  async function handleSubmit(values: z.infer<typeof ipEntrySchema>) {
    const result = await saveMutation.mutate({
      body: {
        cidr: values.cidr.trim(),
        ...(values.description.trim() && { description: values.description.trim() }),
      },
    });
    if (result !== undefined) {
      onOpenChange(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add IP Allowlist Entry"
      description="Add a CIDR range to restrict workspace access. Both IPv4 (e.g. 10.0.0.0/8) and IPv6 (e.g. 2001:db8::/32) are supported."
      schema={ipEntrySchema}
      defaultValues={{ cidr: "", description: "" }}
      onSubmit={handleSubmit}
      submitLabel="Add Entry"
      saving={saveMutation.saving}
      serverError={saveMutation.error}
      className="max-w-md"
    >
      {() => (
        <>
          <FormField
            name="cidr"
            render={({ field }) => (
              <FormItem>
                <FormLabel>CIDR Range</FormLabel>
                <FormControl>
                  <Input placeholder="10.0.0.0/8" autoFocus {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description (optional)</FormLabel>
                <FormControl>
                  <Input placeholder="Office network" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}
    </FormDialog>
  );
}

// ── Delete Confirmation Dialog ────────────────────────────────────

function DeleteEntryDialog({
  entry,
  open,
  onOpenChange,
  onDeleted,
  callerIP,
  entries,
}: {
  entry: IPAllowlistEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  callerIP: string | null;
  entries: IPAllowlistEntry[];
}) {
  const { mutate, saving: deleting, error, reset } = useAdminMutation({
    method: "DELETE",
    invalidates: onDeleted,
  });

  // Check if removing this entry would leave only entries that don't contain the caller's IP
  const wouldBlockCaller = entry && callerIP && entries.length > 0 && (() => {
    const remaining = entries.filter((e) => e.id !== entry.id);
    // If removing this entry leaves 0 entries, allowlist becomes disabled (no block)
    if (remaining.length === 0) return false;
    // If there are remaining entries but we can't verify the caller's IP, warn
    return true; // Conservative: always warn when removing an entry while others exist
  })();

  function handleOpen(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleDelete() {
    if (!entry) return;
    const result = await mutate({
      path: `/api/v1/admin/ip-allowlist/${encodeURIComponent(entry.id)}`,
    });
    if (result !== undefined) {
      handleOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove IP Allowlist Entry</DialogTitle>
          <DialogDescription>
            Are you sure you want to remove this CIDR range from the allowlist?
          </DialogDescription>
        </DialogHeader>

        {entry && (
          <div className="space-y-3 py-2">
            <div className="rounded-md bg-muted p-3">
              <p className="font-mono text-sm">{entry.cidr}</p>
              {entry.description && (
                <p className="mt-1 text-xs text-muted-foreground">{entry.description}</p>
              )}
            </div>

            {wouldBlockCaller && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Removing this entry may affect your access. Your current IP is{" "}
                  <code className="rounded bg-amber-500/10 px-1 font-mono">{callerIP}</code>.
                  Verify that your IP is covered by a remaining allowlist entry.
                </p>
              </div>
            )}

            {error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2 className="mr-1 size-3 animate-spin" />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function IPAllowlistPage() {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteEntry, setDeleteEntry] = useState<IPAllowlistEntry | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<IPAllowlistResponse>(
    "/api/v1/admin/ip-allowlist",
    {
      transform: (json) => json as IPAllowlistResponse,
    },
  );

  const entries = data?.entries ?? [];
  const callerIP = data?.callerIP ?? null;

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">IP Allowlist</h1>
          <p className="text-sm text-muted-foreground">
            Restrict workspace access by IP address
          </p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="IP Allowlist" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">IP Allowlist</h1>
          <p className="text-sm text-muted-foreground">
            Restrict workspace access by IP address (enterprise)
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)} size="sm">
          <Plus className="mr-1 size-3.5" />
          Add Entry
        </Button>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6">
          {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}

          {callerIP && (
            <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Globe className="size-3.5" />
              Your current IP: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{callerIP}</code>
            </div>
          )}

          {loading ? (
            <LoadingState message="Loading IP allowlist..." />
          ) : entries.length > 0 ? (
            <Card className="shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Shield className="size-4" />
                  Allowlist Entries
                </CardTitle>
                <CardDescription>
                  When entries are configured, only requests from these CIDR ranges can access the workspace.
                  Remove all entries to disable the allowlist.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>CIDR Range</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Created By</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="w-[60px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="font-mono text-sm">
                          {entry.cidr}
                          {entry.cidr.includes(":") ? (
                            <Badge variant="outline" className="ml-2 text-[10px]">IPv6</Badge>
                          ) : (
                            <Badge variant="outline" className="ml-2 text-[10px]">IPv4</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {entry.description || "-"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {entry.createdBy || "-"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(entry.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteEntry(entry)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : !error ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Shield className="mb-3 size-10 text-muted-foreground/50" />
              <p className="text-sm font-medium">No IP restrictions configured</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                The workspace is accessible from any IP address. Add CIDR ranges to restrict access to specific networks.
              </p>
              <Button
                className="mt-4"
                size="sm"
                onClick={() => setAddDialogOpen(true)}
              >
                <Plus className="mr-1 size-3.5" />
                Add First Entry
              </Button>
            </div>
          ) : null}
        </div>
      </ErrorBoundary>

      <AddEntryDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdded={refetch}
      />

      <DeleteEntryDialog
        entry={deleteEntry}
        open={!!deleteEntry}
        onOpenChange={(open) => !open && setDeleteEntry(null)}
        onDeleted={refetch}
        callerIP={callerIP}
        entries={entries}
      />
    </div>
  );
}
