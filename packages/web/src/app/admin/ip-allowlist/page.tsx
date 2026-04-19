"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Shield,
  ShieldCheck,
  Plus,
  Trash2,
  Loader2,
  AlertTriangle,
  Globe,
  Network,
} from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

const IPAllowlistEntrySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  cidr: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
type IPAllowlistEntry = z.infer<typeof IPAllowlistEntrySchema>;

const IPAllowlistResponseSchema = z.object({
  entries: z.array(IPAllowlistEntrySchema),
  total: z.number(),
  callerIP: z.string().nullable(),
  // Server-side truth. The middleware in ee/src/auth/ip-allowlist.ts
  // short-circuits to `{ allowed: true }` when enterprise is disabled or
  // the internal DB is missing, so the UI can't derive enforcement from
  // entry count alone without lying to admins.
  effectivelyEnforced: z.boolean(),
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

function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {children}
    </div>
  );
}

function CompactRow({
  icon: Icon,
  title,
  description,
  status,
  action,
  titleAccessory,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: StatusKind;
  action?: ReactNode;
  titleAccessory?: ReactNode;
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
          {titleAccessory}
          <StatusDot kind={status} className="shrink-0" />
          <span className="sr-only">Status: {STATUS_LABEL[status]}</span>
        </div>
        {/* Newline-delimited descriptions render as a two-line subtitle (e.g. a
            rule's human description on top and its added-at/by metadata below).
            Single-line descriptions truncate as before. */}
        {(() => {
          const lines = description.split("\n");
          if (lines.length > 1) {
            return (
              <div className="mt-0.5 space-y-0.5">
                <p className="truncate text-xs text-muted-foreground">
                  {lines[0]}
                </p>
                <p className="truncate text-[11px] text-muted-foreground/70">
                  {lines.slice(1).join(" · ")}
                </p>
              </div>
            );
          }
          return (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {description}
            </p>
          );
        })()}
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

  function handleOpenChange(next: boolean) {
    if (next) saveMutation.reset();
    onOpenChange(next);
  }

  async function handleSubmit(values: z.infer<typeof ipEntrySchema>) {
    const result = await saveMutation.mutate({
      body: {
        cidr: values.cidr.trim(),
        ...(values.description.trim() && { description: values.description.trim() }),
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
      {(form) => (
        <>
          <FormField
            control={form.control}
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
            control={form.control}
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
    if (result.ok) {
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

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/ip-allowlist",
    { schema: IPAllowlistResponseSchema },
  );

  const entries = data?.entries ?? [];
  const callerIP = data?.callerIP ?? null;
  // Server-computed: true only when EE is enabled, the internal DB is
  // configured, AND at least one entry exists. Never derive this from
  // `entries.length` alone — the request-time middleware will short-circuit
  // to allow-all when EE is off or the internal DB is missing.
  const effectivelyEnforced = data?.effectivelyEnforced ?? false;

  const ruleCount = entries.length;
  // "Dormant" = has rules but enforcement is off (EE disabled or no internal
  // DB). Admins in that state must be told the rules aren't actually gating
  // requests, instead of seeing the same green "Active" affordance as a
  // properly-enforcing deploy.
  const enforcementDormant = !effectivelyEnforced && ruleCount > 0;

  let enforcementStatus: StatusKind;
  let enforcementDescription: string;
  if (effectivelyEnforced) {
    enforcementStatus = "connected";
    enforcementDescription = `Active — ${ruleCount} range${ruleCount !== 1 ? "s" : ""} permitted`;
  } else if (enforcementDormant) {
    enforcementStatus = "unavailable";
    enforcementDescription = `${ruleCount} range${ruleCount !== 1 ? "s" : ""} configured, but not being enforced`;
  } else {
    enforcementStatus = "disconnected";
    enforcementDescription = "No ranges configured — the workspace accepts requests from any IP";
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Hero */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">IP allowlist</h1>
          <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
            <span className={cn(ruleCount > 0 ? "text-primary" : "text-muted-foreground")}>
              {String(ruleCount).padStart(2, "0")}
            </span>
            <span className="opacity-50">{" "}ranges</span>
          </p>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          Restrict workspace access to specific CIDR ranges.
        </p>
        {callerIP && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Globe className="size-3.5" />
            Your current IP
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {callerIP}
            </code>
          </div>
        )}
      </header>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="IP Allowlist"
          onRetry={refetch}
          loadingMessage="Loading IP allowlist..."
          isEmpty={false}
        >
          <div className="space-y-10">
            {/* Enforcement */}
            <section>
              <SectionHeading
                title="Enforcement"
                description="Access is restricted when one or more ranges are configured"
              />
              {enforcementStatus === "connected" ? (
                <IntegrationShell
                  icon={ShieldCheck}
                  title="Allowlist enforcement"
                  description={enforcementDescription}
                  status="connected"
                  actions={
                    <span className="text-xs text-muted-foreground">
                      Requests outside these ranges are rejected
                    </span>
                  }
                />
              ) : (
                <>
                  <CompactRow
                    icon={enforcementStatus === "unavailable" ? ShieldCheck : Shield}
                    title="Allowlist enforcement"
                    description={enforcementDescription}
                    status={enforcementStatus}
                  />
                  {enforcementDormant && (
                    <InlineError>
                      These ranges aren&apos;t being enforced. IP allowlisting requires
                      an Atlas Enterprise license and a configured internal database
                      (<code className="rounded bg-destructive/10 px-1 font-mono">DATABASE_URL</code>).
                      Until both are present, the workspace accepts requests from any IP.
                    </InlineError>
                  )}
                </>
              )}
            </section>

            {/* Ranges */}
            <section>
              <SectionHeading
                title="Ranges"
                description="IPv4 and IPv6 CIDR blocks permitted to reach the workspace"
              />
              <div className="space-y-2">
                {entries.map((entry) => {
                  const addedLine = `Added ${formatDateTime(entry.createdAt)}${entry.createdBy ? ` · ${entry.createdBy}` : ""}`;
                  // Render description (when present) AND the added-at/by metadata.
                  // Newline triggers the two-line subtitle fork inside CompactRow so
                  // rules with a description don't drop their created metadata.
                  const description = entry.description
                    ? `${entry.description}\n${addedLine}`
                    : addedLine;
                  return (
                  <CompactRow
                    key={entry.id}
                    icon={Network}
                    title={entry.cidr}
                    description={description}
                    status="connected"
                    titleAccessory={
                      <Badge
                        variant="outline"
                        className="shrink-0 font-mono text-[10px] uppercase"
                      >
                        {entry.cidr.includes(":") ? "IPv6" : "IPv4"}
                      </Badge>
                    }
                    action={
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setDeleteEntry(entry)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${entry.cidr}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    }
                  />
                  );
                })}

                <CompactRow
                  icon={Plus}
                  title={entries.length === 0 ? "Add your first range" : "Add another range"}
                  description={
                    entries.length === 0
                      ? "Paste an IPv4 or IPv6 CIDR block — e.g. 10.0.0.0/8 or 2001:db8::/32"
                      : "Add an IPv4 or IPv6 CIDR block to the allowlist"
                  }
                  status="disconnected"
                  action={
                    <Button size="sm" onClick={() => setAddDialogOpen(true)}>
                      <Plus className="mr-1.5 size-3.5" />
                      Add range
                    </Button>
                  }
                />
              </div>
            </section>
          </div>
        </AdminContentWrapper>
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
