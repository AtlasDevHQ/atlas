"use client";

import { useState } from "react";
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
import { friendlyError, friendlyErrorOrNull } from "@/ui/lib/fetch-error";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  CompactRow,
  InlineError,
  SectionHeading,
  Shell,
  type StatusKind,
} from "@/ui/components/admin/compact";
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
  //
  // `.optional()` keeps rolling deploys safe: during a web-before-api rollout
  // an older API server returns no `effectivelyEnforced`, and a required
  // boolean would fail safeParse and brick the whole page. Missing → treated
  // as `false` at the read site (pessimistic — shows the dormant banner, which
  // is technically wrong if the older server was actually enforcing but is
  // harmless and self-heals on the next successful deploy).
  effectivelyEnforced: z.boolean().optional(),
});

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
      serverError={friendlyErrorOrNull(saveMutation.error)}
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
                {friendlyError(error)}
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
                <Shell
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
                    <div className="mt-2">
                      <InlineError>
                        These ranges aren&apos;t being enforced. IP allowlisting requires
                        an Atlas Enterprise license and a configured internal database
                        (<code className="rounded bg-destructive/10 px-1 font-mono">DATABASE_URL</code>).
                        Until both are present, the workspace accepts requests from any IP.
                      </InlineError>
                    </div>
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
                  // When the rule has a human description, render two lines inside
                  // CompactRow's description slot: the description on top and the
                  // added-at/by metadata below. The extracted CompactRow wraps
                  // `description` in a <p>, so we use <span className="block">
                  // children instead of nested <p> tags to keep HTML valid.
                  const description = entry.description ? (
                    <>
                      <span className="block truncate">{entry.description}</span>
                      <span className="block truncate text-[11px] text-muted-foreground/80">
                        {addedLine}
                      </span>
                    </>
                  ) : (
                    addedLine
                  );
                  return (
                    <CompactRow
                      key={entry.id}
                      icon={Network}
                      title={entry.cidr}
                      description={description}
                      status="connected"
                      action={
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="shrink-0 font-mono text-[10px] uppercase"
                          >
                            {entry.cidr.includes(":") ? "IPv6" : "IPv4"}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setDeleteEntry(entry)}
                            className="text-muted-foreground hover:text-destructive"
                            aria-label={`Remove ${entry.cidr}`}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
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
