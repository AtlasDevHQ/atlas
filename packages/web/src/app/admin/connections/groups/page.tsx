"use client";

/**
 * Admin surface for connection groups — UI calls these "environments".
 * One group bundles connections that share a logical schema, e.g.
 * `us-int + eu + apac` for a multi-region prod deployment.
 *
 * Ships create / rename / delete and a member roster. Moving connections
 * into / out of a group happens here too so admins don't have to bounce
 * between two pages. Content-table scoping (entities, dashboards,
 * scheduled tasks, approvals, PII classifications) belongs to separate
 * admin surfaces.
 */

import { useState } from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { Loader2, Plus, Pencil, Trash2, Layers } from "lucide-react";
import type { ConnectionGroup } from "@/ui/lib/types";

const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const GroupListSchema = z.object({
  groups: z.array(GroupSchema),
});

const ConnectionListSchema = z.object({
  connections: z.array(
    z.object({
      id: z.string(),
      dbType: z.string().optional(),
      description: z.string().nullable().optional(),
      groupId: z.string().nullable().optional(),
    }),
  ),
});

export default function ConnectionGroupsPage() {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/connection-groups",
    { schema: GroupListSchema },
  );
  const {
    data: connList,
    refetch: refetchConnections,
  } = useAdminFetch("/api/v1/admin/connections", {
    schema: ConnectionListSchema,
  });
  const groups = data?.groups ?? [];
  const connections = connList?.connections ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ConnectionGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionGroup | null>(null);

  return (
    <AdminContentWrapper loading={loading} error={error} onRetry={refetch}>
      <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <Layers className="size-5" /> Environments
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-prose">
              Bundle connections that share a schema (e.g. multi-region replicas)
              so semantic entities, dashboards, and scheduled tasks are defined
              once and apply everywhere. In code these are called{" "}
              <code className="text-xs">connection groups</code>.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)} data-testid="env-create">
            <Plus className="size-4" /> New environment
          </Button>
        </header>

        {groups.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
              <Layers className="size-8 opacity-50" />
              <p>No environments yet. Create one to group your connections.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                connections={connections}
                refetchGroups={refetch}
                refetchConnections={refetchConnections}
                onRename={() => setRenameTarget(group)}
                onDelete={() => setDeleteTarget(group)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={refetch}
      />
      {renameTarget ? (
        <RenameGroupDialog
          group={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={refetch}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteGroupDialog
          group={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={refetch}
        />
      ) : null}
    </AdminContentWrapper>
  );
}

// ---------------------------------------------------------------------------
// Group card
// ---------------------------------------------------------------------------

function GroupCard({
  group,
  connections,
  refetchGroups,
  refetchConnections,
  onRename,
  onDelete,
}: {
  group: ConnectionGroup;
  connections: Array<{ id: string; groupId?: string | null; dbType?: string; description?: string | null }>;
  refetchGroups: () => void;
  refetchConnections: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const members = connections.filter((c) => c.groupId === group.id);
  const ungrouped = connections.filter((c) => !c.groupId || c.groupId === null);

  const assignMutation = useAdminMutation<{ connectionId: string; groupId: string | null }>({
    path: `/api/v1/admin/connection-groups/${group.id}/members`,
    method: "POST",
    invalidates: [refetchGroups, refetchConnections],
  });

  const handleAdd = async (connectionId: string) => {
    if (!connectionId) return;
    await assignMutation.mutate({
      body: { connectionId },
      itemId: connectionId,
    });
  };

  const handleRemove = async (connectionId: string) => {
    await assignMutation.mutate({
      body: { connectionId, unassign: true },
      itemId: connectionId,
    });
  };

  return (
    <Card data-testid={`env-card-${group.id}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">{group.name}</CardTitle>
          <CardDescription className="text-xs font-mono">{group.id}</CardDescription>
        </div>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={onRename}
            data-testid={`env-rename-${group.id}`}
            aria-label={`Rename ${group.name}`}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            data-testid={`env-delete-${group.id}`}
            aria-label={`Delete ${group.name}`}
            disabled={members.length > 0}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {members.length === 0 ? (
            <span className="text-xs text-muted-foreground">No connections yet.</span>
          ) : (
            members.map((c) => (
              <Badge
                key={c.id}
                variant="secondary"
                className="flex items-center gap-1"
                data-testid={`env-member-${group.id}-${c.id}`}
              >
                {c.id}
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-4 -mr-1"
                  onClick={() => handleRemove(c.id)}
                  aria-label={`Remove ${c.id} from ${group.name}`}
                >
                  ×
                </Button>
              </Badge>
            ))
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value=""
            onValueChange={handleAdd}
            disabled={ungrouped.length === 0}
          >
            <SelectTrigger
              className="h-8 w-[220px] text-xs"
              data-testid={`env-add-trigger-${group.id}`}
            >
              <SelectValue placeholder={ungrouped.length === 0 ? "No ungrouped connections" : "Add a connection…"} />
            </SelectTrigger>
            <SelectContent>
              {ungrouped.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {assignMutation.saving ? <Loader2 className="size-4 animate-spin" /> : null}
        </div>
        <MutationErrorSurface
          error={assignMutation.error}
          feature="Environments"
          onRetry={assignMutation.clearError}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function CreateGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const create = useAdminMutation<ConnectionGroup>({
    path: "/api/v1/admin/connection-groups",
    method: "POST",
    invalidates: onCreated,
  });

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const result = await create.mutate({ body: { name: trimmed } });
    if (result.ok) {
      setName("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New environment</DialogTitle>
          <DialogDescription>
            Give it a name like <span className="font-mono">prod</span>,{" "}
            <span className="font-mono">staging</span>, or{" "}
            <span className="font-mono">eu-prod</span>. You can rename it later.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Environment name"
          autoFocus
          data-testid="env-create-name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <MutationErrorSurface
          error={create.error}
          feature="Environments"
          onRetry={create.clearError}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={create.saving || !name.trim()}
            data-testid="env-create-submit"
          >
            {create.saving ? <Loader2 className="size-4 animate-spin" /> : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameGroupDialog({
  group,
  onClose,
  onRenamed,
}: {
  group: ConnectionGroup;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(group.name);
  const rename = useAdminMutation<ConnectionGroup>({
    path: `/api/v1/admin/connection-groups/${group.id}`,
    method: "PATCH",
    invalidates: onRenamed,
  });

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) {
      onClose();
      return;
    }
    const result = await rename.mutate({ body: { name: trimmed } });
    if (result.ok) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename environment</DialogTitle>
          <DialogDescription>
            Display label only. References to this group don't change.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          data-testid="env-rename-input"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <MutationErrorSurface
          error={rename.error}
          feature="Environments"
          onRetry={rename.clearError}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={rename.saving || !name.trim()}
            data-testid="env-rename-submit"
          >
            {rename.saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteGroupDialog({
  group,
  onClose,
  onDeleted,
}: {
  group: ConnectionGroup;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const del = useAdminMutation({
    path: `/api/v1/admin/connection-groups/${group.id}`,
    method: "DELETE",
    invalidates: onDeleted,
  });

  const confirm = async () => {
    const result = await del.mutate();
    if (result.ok) onClose();
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete environment "{group.name}"?</AlertDialogTitle>
          <AlertDialogDescription>
            The environment must be empty. Move every connection out first — the
            connections themselves aren't touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <MutationErrorSurface
          error={del.error}
          feature="Environments"
          onRetry={del.clearError}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirm}
            disabled={del.saving}
            data-testid="env-delete-confirm"
          >
            {del.saving ? <Loader2 className="size-4 animate-spin" /> : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
