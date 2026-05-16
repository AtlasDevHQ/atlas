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
import { Loader2, Plus, Pencil, Trash2, Layers, GitMerge, Archive } from "lucide-react";
import {
  CONNECTION_GROUP_STATUSES,
  type ConnectionGroup,
  type GroupArchiveCounts,
} from "@/ui/lib/types";
import {
  stripGroupPrefix,
  isAutoBackfilledSingleton,
} from "@/ui/lib/strip-group-prefix";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";

const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  // `default("active")` keeps decode tolerant of a deploy-skew window —
  // an older API surface without a status field still decodes.
  status: z.enum(CONNECTION_GROUP_STATUSES).default("active"),
  memberCount: z.number().int().nonnegative(),
  primaryConnectionId: z.string().nullable().optional(),
  resolvedConnectionId: z.string().nullable().optional(),
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
  const [mergeOpen, setMergeOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ConnectionGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionGroup | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ConnectionGroup | null>(null);
  const [showAutoDetected, setShowAutoDetected] = useState(false);
  // Archived groups are hidden by default — they're read-only tombstones
  // and would otherwise pad the list during normal admin work. The
  // toggle is opt-in per session (no nuqs state — the surface is small
  // and there's no deep-link need).
  const [showArchived, setShowArchived] = useState(false);

  // Filter by lifecycle FIRST so the auto-detected counts below reflect
  // only the visible (active) population — otherwise a workspace with
  // mostly archived singletons would surface a misleading "Show 12
  // auto-detected singletons" line while none of them render.
  const liveGroups = showArchived ? groups : groups.filter((g) => g.status !== "archived");
  const archivedGroups = groups.filter((g) => g.status === "archived");
  const autoDetectedGroups = liveGroups.filter(isAutoBackfilledSingleton);
  const curatedGroups = liveGroups.filter((g) => !isAutoBackfilledSingleton(g));
  const visibleGroups = showAutoDetected ? liveGroups : curatedGroups;
  const hasAutoDetected = autoDetectedGroups.length > 0;
  const hasArchived = archivedGroups.length > 0;

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
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setMergeOpen(true)}
                data-testid="env-merge-open"
                disabled={connections.length < 2}
              >
                <GitMerge className="size-4" /> Merge connections
              </Button>
              <Button onClick={() => setCreateOpen(true)} data-testid="env-create">
                <Plus className="size-4" /> New environment
              </Button>
            </div>
            {hasAutoDetected ? (
              <Label
                className="flex items-center gap-2 text-xs text-muted-foreground"
                htmlFor="env-show-auto-detected"
              >
                <Switch
                  id="env-show-auto-detected"
                  checked={showAutoDetected}
                  onCheckedChange={setShowAutoDetected}
                  data-testid="env-show-auto-detected"
                />
                Show {autoDetectedGroups.length} auto-detected singleton
                {autoDetectedGroups.length === 1 ? "" : "s"}
              </Label>
            ) : null}
            {hasArchived ? (
              <Label
                className="flex items-center gap-2 text-xs text-muted-foreground"
                htmlFor="env-show-archived"
              >
                <Switch
                  id="env-show-archived"
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                  data-testid="env-show-archived"
                />
                Show {archivedGroups.length} archived
              </Label>
            ) : null}
          </div>
        </header>

        {visibleGroups.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
              <Layers className="size-8 opacity-50" />
              <p>
                {hasAutoDetected
                  ? "No multi-connection environments yet. Use \"Merge connections\" to group connections together."
                  : "No environments yet. Create one to group your connections."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {visibleGroups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                connections={connections}
                refetchGroups={refetch}
                refetchConnections={refetchConnections}
                onRename={() => setRenameTarget(group)}
                onDelete={() => setDeleteTarget(group)}
                onArchive={() => setArchiveTarget(group)}
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
      <MergeGroupsDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        connections={connections}
        groups={groups}
        onMerged={() => {
          refetch();
          refetchConnections();
        }}
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
      {archiveTarget ? (
        <ArchiveGroupDialog
          group={archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onArchived={refetch}
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
  onArchive,
}: {
  group: ConnectionGroup;
  connections: Array<{ id: string; groupId?: string | null; dbType?: string; description?: string | null }>;
  refetchGroups: () => void;
  refetchConnections: () => void;
  onRename: () => void;
  onDelete: () => void;
  onArchive: () => void;
}) {
  const isArchived = group.status === "archived";
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

  const displayName = stripGroupPrefix(group.name);
  // Hide the raw `g_<connId>` / `g_<random>` id from the description line —
  // it's an implementation detail and admins routinely confused the
  // backfilled `g_warehouse` id with a renameable label (#2409). The full
  // id remains accessible via the rename dialog title for support flows.
  const showRawId = !group.id.startsWith("g_");

  return (
    <Card
      data-testid={`env-card-${group.id}`}
      data-status={group.status}
      className={isArchived ? "opacity-70 border-dashed" : undefined}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{displayName}</CardTitle>
            {isArchived ? (
              <Badge
                variant="outline"
                className="text-[10px] uppercase tracking-wide text-muted-foreground"
                data-testid={`env-archived-badge-${group.id}`}
              >
                Archived
              </Badge>
            ) : null}
          </div>
          {showRawId ? (
            <CardDescription className="text-xs font-mono">{group.id}</CardDescription>
          ) : null}
        </div>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={onRename}
            data-testid={`env-rename-${group.id}`}
            aria-label={`Rename ${displayName}`}
            // Renames flip a label users see — refused on an archived
            // tombstone so the audit log's "renamed to X" history can't
            // contradict the archived snapshot.
            disabled={isArchived}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onArchive}
            data-testid={`env-archive-${group.id}`}
            aria-label={`Archive ${displayName}`}
            // Archive is the all-content retirement path — only enabled
            // for active groups, since re-archiving is a no-op the
            // server refuses with 409.
            disabled={isArchived}
          >
            <Archive className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            data-testid={`env-delete-${group.id}`}
            aria-label={`Delete ${displayName}`}
            // Delete only fires on empty groups (member_count = 0); the
            // route returns 409 otherwise. Archived groups may still
            // carry members, so delete stays disabled there too.
            disabled={members.length > 0 || isArchived}
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
                {isArchived ? null : (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-4 -mr-1"
                    onClick={() => handleRemove(c.id)}
                    aria-label={`Remove ${c.id} from ${displayName}`}
                  >
                    ×
                  </Button>
                )}
              </Badge>
            ))
          )}
        </div>
        {isArchived ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`env-archived-notice-${group.id}`}
          >
            This environment is archived. Content scoped to it has been
            retired and member assignments are read-only.
          </p>
        ) : (
          <>
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
          </>
        )}
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
  // Seed the input with the user-visible label (stripped) rather than the
  // raw stored value — otherwise an admin renaming an auto-backfilled
  // `g_warehouse`-named group sees `g_warehouse` in the input and has to
  // manually delete the prefix that they never asked to see.
  const [name, setName] = useState(stripGroupPrefix(group.name));
  const rename = useAdminMutation<ConnectionGroup>({
    path: `/api/v1/admin/connection-groups/${group.id}`,
    method: "PATCH",
    invalidates: onRenamed,
  });

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === stripGroupPrefix(group.name)) {
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
          <AlertDialogTitle>Delete environment "{stripGroupPrefix(group.name)}"?</AlertDialogTitle>
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

// ---------------------------------------------------------------------------
// Archive group (cascade)
// ---------------------------------------------------------------------------

interface ArchiveResponse {
  archivedCounts: GroupArchiveCounts;
}

/**
 * Two-step archive: a count preview, then the confirmation. The server
 * runs the cascade in one transaction, so a confirm click is the only
 * destructive moment; if it fails, nothing flipped and the dialog
 * surfaces the error inline.
 */
function ArchiveGroupDialog({
  group,
  onClose,
  onArchived,
}: {
  group: ConnectionGroup;
  onClose: () => void;
  onArchived: () => void;
}) {
  const [archived, setArchived] = useState<ArchiveResponse | null>(null);
  const archive = useAdminMutation<ArchiveResponse>({
    path: `/api/v1/admin/connection-groups/${group.id}/archive`,
    method: "POST",
    invalidates: onArchived,
  });

  const displayName = stripGroupPrefix(group.name);

  const confirm = async () => {
    const result = await archive.mutate();
    if (result.ok && result.data) {
      setArchived(result.data);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {archived ? `Archived "${displayName}"` : `Archive "${displayName}"?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {archived
              ? "The cascade completed. The environment and its content are now read-only."
              : "This retires the environment and the content scoped to it. The action runs in one transaction — every step succeeds or rolls back together."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {archived ? (
          <ul
            className="rounded-md border bg-muted/30 p-3 text-sm flex flex-col gap-1"
            data-testid={`env-archive-result-${group.id}`}
          >
            <li>
              <strong>{archived.archivedCounts.entities}</strong> semantic
              entit{archived.archivedCounts.entities === 1 ? "y" : "ies"}{" "}
              archived.
            </li>
            <li>
              <strong>{archived.archivedCounts.tasks}</strong> scheduled task
              {archived.archivedCounts.tasks === 1 ? "" : "s"} disabled.
            </li>
            <li>
              <strong>{archived.archivedCounts.approvals}</strong> pending
              approval{archived.archivedCounts.approvals === 1 ? "" : "s"}{" "}
              expired.
            </li>
          </ul>
        ) : (
          <ul className="rounded-md border bg-muted/30 p-3 text-sm flex flex-col gap-1">
            <li>Semantic entities scoped to this environment will archive.</li>
            <li>Scheduled tasks scoped to this environment will stop firing.</li>
            <li>Pending approval requests for this environment will expire.</li>
            <li>
              Dashboard cards scoped to this environment are NOT touched
              automatically — they'll keep rendering against the archived
              environment until you edit or remove them.
            </li>
          </ul>
        )}

        <MutationErrorSurface
          error={archive.error}
          feature="Environments"
          onRetry={archive.clearError}
        />

        <AlertDialogFooter>
          {archived ? (
            <AlertDialogAction
              onClick={onClose}
              data-testid={`env-archive-close-${group.id}`}
            >
              Done
            </AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel data-testid={`env-archive-cancel-${group.id}`}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirm}
                disabled={archive.saving}
                data-testid={`env-archive-confirm-${group.id}`}
              >
                {archive.saving ? <Loader2 className="size-4 animate-spin" /> : "Archive"}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Merge wizard (#2409)
// ---------------------------------------------------------------------------

interface MergeConnection {
  id: string;
  dbType?: string;
  description?: string | null;
  groupId?: string | null;
}

interface MergeResponse {
  target: ConnectionGroup & { created: boolean };
  movedConnectionIds: string[];
  deletedGroupIds: string[];
  skippedGroupIds: string[];
}

/**
 * Multi-step merge wizard. Surfaces the preview as the second step so the
 * admin can see what cleanup will happen (e.g. "3 auto-detected
 * environments will be deleted") before committing. The atomic merge runs
 * server-side in a single CTE — there's no partial-success state to
 * recover from.
 */
function MergeGroupsDialog({
  open,
  onOpenChange,
  connections,
  groups,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ReadonlyArray<MergeConnection>;
  groups: ReadonlyArray<ConnectionGroup>;
  onMerged: (result: MergeResponse) => void;
}) {
  const [step, setStep] = useState<"select" | "name" | "preview">("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [targetName, setTargetName] = useState("");
  const [primaryId, setPrimaryId] = useState<string>("");

  const merge = useAdminMutation<MergeResponse>({
    path: "/api/v1/admin/connection-groups/merge",
    method: "POST",
  });

  // Reset state when the dialog closes so a re-open starts fresh. Leaving
  // stale selections in place across opens would surface confusing default
  // values (and a stale primary id no longer in the source set).
  const reset = () => {
    setStep("select");
    setSelectedIds([]);
    setTargetName("");
    setPrimaryId("");
    merge.clearError();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const toggleConnection = (id: string) => {
    setSelectedIds((prev) => {
      const removing = prev.includes(id);
      const next = removing ? prev.filter((x) => x !== id) : [...prev, id];
      // Keep `primaryId` in lockstep with the selection set so the server's
      // `uniqueSourceIds.includes(primaryConnectionId)` check at submit time
      // never sees a stale primary. Without this, toggling on A (primary=A),
      // then on B, then off A leaves the wizard with `primaryId=A` not in
      // selectedIds and the merge fails with a 400 that the admin can't
      // diagnose from the UI.
      if (removing && primaryId === id) {
        setPrimaryId(next[0] ?? "");
      } else if (!removing && !primaryId) {
        setPrimaryId(id);
      }
      return next;
    });
  };

  // Existing target group (if the user names a group that already exists).
  // The preview surfaces this so "Add to existing prod" reads differently
  // from "Create new prod" — same merge call, different audit framing.
  const existingTarget = targetName.trim()
    ? groups.find((g) => g.name === targetName.trim())
    : undefined;

  // Source groups currently anchoring the selected connections — used to
  // count the "auto-detected environments will be deleted" preview line.
  const sourceGroupIds = Array.from(
    new Set(
      selectedIds
        .map((id) => connections.find((c) => c.id === id)?.groupId)
        .filter((g): g is string => typeof g === "string"),
    ),
  );
  const eligibleForCleanup = sourceGroupIds.filter((gid) => {
    const g = groups.find((x) => x.id === gid);
    if (!g) return false;
    if (existingTarget && g.id === existingTarget.id) return false;
    return isAutoBackfilledSingleton(g);
  });

  const submit = async () => {
    if (selectedIds.length < 2 || !targetName.trim() || !primaryId) return;
    const result = await merge.mutate({
      body: {
        targetName: targetName.trim(),
        sourceConnectionIds: selectedIds,
        primaryConnectionId: primaryId,
      },
    });
    if (result.ok && result.data) {
      onMerged(result.data);
      handleOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge connections into an environment</DialogTitle>
          <DialogDescription>
            {step === "select"
              ? "Pick the connections that share a schema. We'll move them into one environment."
              : step === "name"
                ? "Name the target environment and choose which connection runs scheduled tasks and dashboards."
                : "Confirm the changes. The merge is atomic — every step succeeds together or rolls back."}
          </DialogDescription>
        </DialogHeader>

        {step === "select" ? (
          <div
            className="flex flex-col gap-1 max-h-[280px] overflow-y-auto pr-1"
            data-testid="env-merge-select-list"
          >
            {connections.length === 0 ? (
              <p className="text-xs text-muted-foreground">No connections to merge.</p>
            ) : (
              connections.map((c) => {
                const checked = selectedIds.includes(c.id);
                return (
                  <Label
                    key={c.id}
                    className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm hover:border-border hover:bg-muted/40 cursor-pointer"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleConnection(c.id)}
                      data-testid={`env-merge-source-${c.id}`}
                    />
                    <span className="flex-1 truncate font-mono text-xs">{c.id}</span>
                    {c.dbType ? (
                      <Badge variant="outline" className="text-[10px]">
                        {c.dbType}
                      </Badge>
                    ) : null}
                  </Label>
                );
              })
            )}
          </div>
        ) : null}

        {step === "name" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="env-merge-name" className="text-xs uppercase tracking-wide text-muted-foreground">
                Environment name
              </Label>
              <Input
                id="env-merge-name"
                value={targetName}
                onChange={(e) => setTargetName(e.target.value)}
                placeholder="prod"
                autoFocus
                data-testid="env-merge-name"
              />
              {existingTarget ? (
                <p className="text-xs text-muted-foreground">
                  An environment named{" "}
                  <span className="font-mono">{stripGroupPrefix(existingTarget.name)}</span>{" "}
                  already exists with {existingTarget.memberCount} member(s) — your selection will
                  be added to it.
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="env-merge-primary" className="text-xs uppercase tracking-wide text-muted-foreground">
                Primary connection
              </Label>
              <Select value={primaryId} onValueChange={setPrimaryId}>
                <SelectTrigger id="env-merge-primary" data-testid="env-merge-primary">
                  <SelectValue placeholder="Select a primary…" />
                </SelectTrigger>
                <SelectContent>
                  {selectedIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Scheduled tasks and dashboard cards in this environment will execute against the
                primary connection.
              </p>
            </div>
          </div>
        ) : null}

        {step === "preview" ? (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 text-sm">
            <p>
              <strong>{selectedIds.length} connection(s)</strong> will move into{" "}
              <span className="font-mono">{targetName.trim()}</span>
              {existingTarget ? " (existing environment)" : " (new environment)"}.
            </p>
            <p>
              Primary connection: <span className="font-mono">{primaryId}</span>
            </p>
            {eligibleForCleanup.length > 0 ? (
              <p>
                {eligibleForCleanup.length} auto-detected singleton environment(s) will be
                deleted.
              </p>
            ) : (
              <p className="text-muted-foreground">
                No auto-detected environments will be deleted by this merge.
              </p>
            )}
          </div>
        ) : null}

        <MutationErrorSurface error={merge.error} feature="Environments" onRetry={merge.clearError} />

        <DialogFooter>
          {step === "select" ? (
            <>
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => setStep("name")}
                disabled={selectedIds.length < 2}
                data-testid="env-merge-next-name"
              >
                Next
              </Button>
            </>
          ) : null}
          {step === "name" ? (
            <>
              <Button variant="ghost" onClick={() => setStep("select")}>
                Back
              </Button>
              <Button
                onClick={() => setStep("preview")}
                disabled={!targetName.trim() || !primaryId}
                data-testid="env-merge-next-preview"
              >
                Review
              </Button>
            </>
          ) : null}
          {step === "preview" ? (
            <>
              <Button variant="ghost" onClick={() => setStep("name")}>
                Back
              </Button>
              <Button
                onClick={submit}
                disabled={merge.saving}
                data-testid="env-merge-confirm"
              >
                {merge.saving ? <Loader2 className="size-4 animate-spin" /> : "Merge"}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
