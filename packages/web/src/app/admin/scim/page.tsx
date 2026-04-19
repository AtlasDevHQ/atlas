"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from "@/components/form-dialog";
import { z } from "zod";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Cable,
  Users,
  ArrowRightLeft,
  Loader2,
  Plus,
  Trash2,
  KeyRound,
} from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

const SCIMConnectionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  organizationId: z.string().nullable(),
});

const SCIMSyncStatusSchema = z.object({
  connections: z.number(),
  provisionedUsers: z.number(),
  lastSyncAt: z.string().nullable(),
});

const SCIMStatusResponseSchema = z.object({
  connections: z.array(SCIMConnectionSchema),
  syncStatus: SCIMSyncStatusSchema,
});

const SCIMGroupMappingSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  scimGroupName: z.string(),
  roleName: z.string(),
  createdAt: z.string(),
});
const GroupMappingsResponseSchema = z.object({
  mappings: z.array(SCIMGroupMappingSchema),
  total: z.number(),
});

// ── Shared Design Primitives (locally duplicated per #1551) ──────────────

type StatusKind = "connected" | "disconnected" | "unavailable";

function StatusDot({ kind, className }: { kind: StatusKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,_var(--primary)_15%,_transparent)]",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "unavailable" && "bg-muted-foreground/20 outline-1 outline-dashed outline-muted-foreground/30",
        className,
      )}
    >
      {kind === "connected" && (
        <span className="absolute inset-0 rounded-full bg-primary/60 motion-safe:animate-ping" />
      )}
    </span>
  );
}

const STATUS_LABEL: Record<StatusKind, string> = {
  connected: "Active",
  disconnected: "Inactive",
  unavailable: "Unavailable",
};

function CompactRow({
  icon: Icon,
  title,
  description,
  status,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: StatusKind;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 transition-colors",
        "hover:bg-card/70 hover:border-border/80",
        status === "unavailable" && "opacity-60",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
            {title}
          </h3>
          <StatusDot kind={status} className="shrink-0" />
          <span className="sr-only">Status: {STATUS_LABEL[status]}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function IntegrationShell({
  icon: Icon,
  title,
  description,
  status,
  titleAccessory,
  children,
  actions,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: StatusKind;
  titleAccessory?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-card/60 backdrop-blur-[1px] transition-colors",
        "hover:border-border/80",
        status === "connected" && "border-primary/20",
      )}
    >
      {status === "connected" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-gradient-to-b from-transparent via-primary to-transparent opacity-70"
        />
      )}

      <header className="flex items-start gap-3 p-4 pb-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40",
            status === "connected" && "border-primary/30 text-primary",
            status !== "connected" && "text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
              {title}
            </h3>
            {titleAccessory}
            {status === "connected" && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                <StatusDot kind="connected" />
                Live
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs leading-snug text-muted-foreground">
            {description}
          </p>
        </div>
      </header>

      {children != null && (
        <div className="flex-1 space-y-3 px-4 pb-3 text-sm">{children}</div>
      )}

      {actions && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          {actions}
        </footer>
      )}
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right",
          mono && "font-mono text-[11px]",
          truncate && "truncate",
          !mono && "font-medium",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function DetailList({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-1.5 divide-y divide-border/50">
      {children}
    </div>
  );
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function SCIMPage() {
  const [addMappingOpen, setAddMappingOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: "connection" | "mapping"; id: string; label: string } | null>(null);

  const { data: statusData, loading: statusLoading, error: statusError, refetch: refetchStatus } =
    useAdminFetch("/api/v1/admin/scim", {
      schema: SCIMStatusResponseSchema,
    });

  const { data: mappingsData, loading: mappingsLoading, error: mappingsError, refetch: refetchMappings } =
    useAdminFetch("/api/v1/admin/scim/group-mappings", {
      schema: GroupMappingsResponseSchema,
    });

  const { mutate: deleteMutate, saving: deleting, error: mutationError, clearError: clearMutationError } =
    useAdminMutation({
      method: "DELETE",
      invalidates: [refetchStatus, refetchMappings],
    });

  const loading = statusLoading || mappingsLoading;
  const error = statusError ?? mappingsError;
  const connections = statusData?.connections ?? [];
  const syncStatus = statusData?.syncStatus ?? { connections: 0, provisionedUsers: 0, lastSyncAt: null };
  const mappings = mappingsData?.mappings ?? [];

  async function handleDelete() {
    if (!deleteTarget) return;
    const path = deleteTarget.type === "connection"
      ? `/api/v1/admin/scim/connections/${deleteTarget.id}`
      : `/api/v1/admin/scim/group-mappings/${deleteTarget.id}`;

    const result = await deleteMutate({ path });
    setDeleteTarget(null);
    // error is captured by the hook
    void result;
  }

  const liveCount = connections.length;
  const totalCount = Math.max(connections.length, syncStatus.connections);
  const lastSyncLabel = syncStatus.lastSyncAt
    ? formatDateTime(syncStatus.lastSyncAt)
    : "Never";

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Hero */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">SCIM</h1>
          <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
            <span className={cn(liveCount > 0 ? "text-primary" : "text-muted-foreground")}>
              {String(liveCount).padStart(2, "0")}
            </span>
            <span className="opacity-50">{" / "}</span>
            {String(totalCount).padStart(2, "0")} active
          </p>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          Directory sync for automated user provisioning from your identity provider.
        </p>
      </header>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="SCIM"
          onRetry={() => { refetchStatus(); refetchMappings(); }}
          loadingMessage="Loading SCIM configuration..."
          emptyIcon={Cable}
          emptyTitle="No SCIM configuration"
          isEmpty={false}
        >
          {mutationError && (
            <div className="mb-4">
              <ErrorBanner message={mutationError} onRetry={clearMutationError} />
            </div>
          )}

          <div className="space-y-10">
            {/* Sync overview — compact 3-up spec sheet, no framing card */}
            <section>
              <SectionHeading
                title="Sync"
                description="Directory activity for this workspace"
              />
              <DetailList>
                <DetailRow
                  label="Active connections"
                  value={
                    <span className="font-mono tabular-nums">
                      {String(syncStatus.connections).padStart(2, "0")}
                    </span>
                  }
                />
                <DetailRow
                  label="Provisioned users"
                  value={
                    <span className="font-mono tabular-nums">
                      {String(syncStatus.provisionedUsers).padStart(2, "0")}
                    </span>
                  }
                />
                <DetailRow label="Last sync" value={lastSyncLabel} />
              </DetailList>
            </section>

            {/* Connections */}
            <section>
              <SectionHeading
                title="Connections"
                description="Identity provider bearer tokens that can sync users"
              />
              <div className="space-y-2">
                {connections.map((conn) => (
                  <IntegrationShell
                    key={conn.id}
                    icon={KeyRound}
                    title={conn.providerId}
                    description="Bearer token issued via the SCIM token API"
                    status="connected"
                    titleAccessory={
                      <Badge variant="secondary" className="shrink-0 font-mono text-[10px] uppercase">
                        SCIM
                      </Badge>
                    }
                    actions={
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget({ type: "connection", id: conn.id, label: conn.providerId })}
                        aria-label={`Revoke ${conn.providerId} connection`}
                      >
                        <Trash2 className="size-3" />
                        Revoke
                      </Button>
                    }
                  >
                    <DetailList>
                      <DetailRow label="Provider" value={conn.providerId} mono truncate />
                      <DetailRow
                        label="Connection ID"
                        value={conn.id}
                        mono
                        truncate
                      />
                      {conn.organizationId && (
                        <DetailRow
                          label="Organization"
                          value={conn.organizationId}
                          mono
                          truncate
                        />
                      )}
                    </DetailList>
                  </IntegrationShell>
                ))}

                <CompactRow
                  icon={Plus}
                  title={connections.length === 0 ? "Generate your first SCIM token" : "Generate another SCIM token"}
                  description="Issue a bearer token via POST /api/auth/scim/generate-token for your IdP"
                  status="disconnected"
                  action={
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href="/api/auth/scim/generate-token"
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <KeyRound className="mr-1.5 size-3.5" />
                        Token API
                      </a>
                    </Button>
                  }
                />
              </div>
            </section>

            {/* Group Mappings */}
            <section>
              <SectionHeading
                title="Group mappings"
                description="Map IdP group names to Atlas custom roles"
              />
              <div className="space-y-2">
                {mappings.map((mapping) => (
                  <IntegrationShell
                    key={mapping.id}
                    icon={ArrowRightLeft}
                    title={mapping.scimGroupName}
                    description={`→ ${mapping.roleName}`}
                    status="connected"
                    titleAccessory={
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {mapping.roleName}
                      </Badge>
                    }
                    actions={
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget({ type: "mapping", id: mapping.id, label: mapping.scimGroupName })}
                        aria-label={`Remove mapping for ${mapping.scimGroupName}`}
                      >
                        <Trash2 className="size-3" />
                        Remove
                      </Button>
                    }
                  >
                    <DetailList>
                      <DetailRow label="SCIM group" value={mapping.scimGroupName} mono truncate />
                      <DetailRow label="Atlas role" value={mapping.roleName} mono truncate />
                      <DetailRow label="Added" value={formatDateTime(mapping.createdAt)} />
                    </DetailList>
                  </IntegrationShell>
                ))}

                <CompactRow
                  icon={mappings.length === 0 ? Users : Plus}
                  title={mappings.length === 0 ? "Add your first group mapping" : "Add another group mapping"}
                  description={
                    mappings.length === 0
                      ? "Map SCIM groups to roles so provisioned users land with the right permissions"
                      : "Hook another IdP group up to an Atlas role"
                  }
                  status="disconnected"
                  action={
                    <Button size="sm" onClick={() => setAddMappingOpen(true)}>
                      <Plus className="mr-1.5 size-3.5" />
                      Add mapping
                    </Button>
                  }
                />
              </div>
            </section>
          </div>
        </AdminContentWrapper>
      </ErrorBoundary>

      {/* Add Mapping Dialog */}
      <AddMappingDialog
        open={addMappingOpen}
        onOpenChange={setAddMappingOpen}
        onAdded={() => { refetchMappings(); }}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.type === "connection" ? "SCIM Connection" : "Group Mapping"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "connection"
                ? `This will revoke the SCIM connection "${deleteTarget.label}" and invalidate its bearer token. The IdP will no longer be able to sync users.`
                : `This will remove the mapping for SCIM group "${deleteTarget?.label}". Users already assigned via this mapping keep their current role.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-1 size-3 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Add Mapping Dialog ────────────────────────────────────────────

const mappingSchema = z.object({
  scimGroupName: z.string().min(1, "SCIM group name is required"),
  roleName: z.string().min(1, "Role name is required"),
});

function AddMappingDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const saveMutation = useAdminMutation({
    path: "/api/v1/admin/scim/group-mappings",
    method: "POST",
    invalidates: onAdded,
  });

  function handleOpenChange(next: boolean) {
    if (next) saveMutation.reset();
    onOpenChange(next);
  }

  async function handleSubmit(values: z.infer<typeof mappingSchema>) {
    const result = await saveMutation.mutate({
      body: {
        scimGroupName: values.scimGroupName.trim(),
        roleName: values.roleName.trim(),
      },
    });
    if (result.ok) {
      onOpenChange(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Add Group Mapping"
      description="Map a SCIM group from your identity provider to an Atlas custom role."
      schema={mappingSchema}
      defaultValues={{ scimGroupName: "", roleName: "" }}
      onSubmit={handleSubmit}
      submitLabel="Create Mapping"
      saving={saveMutation.saving}
      serverError={saveMutation.error}
    >
      {(form) => (
        <>
          <FormField
            control={form.control}
            name="scimGroupName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>SCIM Group Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. Engineers, Data Science Team"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  The display name of the group as it appears in your IdP.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="roleName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Atlas Role Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. analyst, viewer"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  The custom role to assign. Must already exist in{" "}
                  <a href="/admin/roles" className="underline">Roles</a>.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}
    </FormDialog>
  );
}
