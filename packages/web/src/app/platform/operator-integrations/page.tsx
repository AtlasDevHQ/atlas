"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
} from "lucide-react";

// ── Wire schemas (mirror admin-operator-integrations.ts) ─────────────

const FieldStatusSchema = z.object({
  envVar: z.string(),
  label: z.string(),
  hint: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
  destructiveRotation: z.boolean(),
  present: z.boolean(),
  source: z.enum(["db", "env", "unset"]),
});
type FieldStatus = z.infer<typeof FieldStatusSchema>;

const PlatformStatusSchema = z.object({
  platform: z.string(),
  label: z.string(),
  configured: z.boolean(),
  hasDbOverride: z.boolean(),
  updatedAt: z.string().nullable(),
  fields: z.array(FieldStatusSchema),
});

const StatusResponseSchema = z.object({
  status: PlatformStatusSchema,
  refreshed: z.boolean().optional(),
  refreshError: z.string().optional(),
});

const ListResponseSchema = z.object({
  platforms: z.array(
    z.object({
      platform: z.string(),
      label: z.string(),
      configured: z.boolean(),
      hasDbOverride: z.boolean(),
    }),
  ),
});

// ── Per-field source badge ───────────────────────────────────────────

function SourceBadge({ field }: { field: FieldStatus }) {
  if (field.source === "db") {
    return (
      <Badge variant="outline" className="border-primary/40 text-primary">
        Set via console
      </Badge>
    );
  }
  if (field.source === "env") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        From environment
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn(field.required ? "border-amber-500 text-amber-600" : "text-muted-foreground")}
    >
      {field.required ? "Not set" : "Optional · not set"}
    </Badge>
  );
}

// ── One platform's credential card ───────────────────────────────────

function PlatformCard({ platform }: { platform: string }) {
  const { data, loading, error, refetch } = useAdminFetch(
    `/api/v1/platform/operator-integrations/${platform}`,
    { schema: StatusResponseSchema },
  );

  const { mutate: saveMutate, saving, error: saveError, clearError: clearSaveError } = useAdminMutation({
    path: `/api/v1/platform/operator-integrations/${platform}`,
    method: "PUT",
    invalidates: refetch,
  });
  const { mutate: deleteMutate, saving: deleting, error: deleteError, clearError: clearDeleteError } =
    useAdminMutation({
      path: `/api/v1/platform/operator-integrations/${platform}`,
      method: "DELETE",
      invalidates: refetch,
    });

  // Draft values keyed by env var. All start blank — a blank field PRESERVES
  // the stored secret on save (the server merges non-empty over the bundle).
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Reset the draft only when the platform's stored identity changes (not on
  // every background refetch) so an in-flight edit isn't clobbered.
  const lastSyncedKey = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !data) return;
    const key = `${data.status.platform}|${data.status.updatedAt ?? "none"}`;
    if (lastSyncedKey.current === key) return;
    lastSyncedKey.current = key;
    setDraft({});
    setShown({});
  }, [data, loading]);

  const status = data?.status;
  const fields = status?.fields ?? [];

  // Which destructive fields is the admin about to rotate? (non-empty drafts)
  const destructiveEdits = fields.filter(
    (f) => f.destructiveRotation && (draft[f.envVar] ?? "").trim().length > 0,
  );
  const hasAnyEdit = fields.some((f) => (draft[f.envVar] ?? "").trim().length > 0);

  function setField(envVar: string, value: string) {
    setDraft((prev) => ({ ...prev, [envVar]: value }));
  }

  async function persist() {
    clearSaveError();
    clearDeleteError();
    // Only send non-empty fields — blank = preserve.
    const payload: Record<string, string> = {};
    for (const f of fields) {
      const v = (draft[f.envVar] ?? "").trim();
      if (v.length > 0) payload[f.envVar] = draft[f.envVar];
    }
    const result = await saveMutate({ body: { fields: payload } });
    if (result.ok) {
      setDraft({});
      setShown({});
    }
  }

  async function handleSave() {
    if (destructiveEdits.length > 0) {
      setConfirmOpen(true);
      return;
    }
    await persist();
  }

  async function handleRemove() {
    clearSaveError();
    clearDeleteError();
    await deleteMutate();
  }

  return (
    <section className="rounded-xl border bg-card/60">
      <header className="flex items-start gap-3 border-b p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
          <Plug className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight">{status?.label ?? platform}</h2>
            {status?.configured ? (
              <Badge variant="outline" className="border-primary/40 text-primary">
                Configured
              </Badge>
            ) : (
              <Badge variant="outline" className="border-amber-500 text-amber-600">
                Incomplete
              </Badge>
            )}
            {status?.hasDbOverride && (
              <Badge variant="outline" className="text-muted-foreground">
                Console override active
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Atlas&apos;s own {status?.label ?? platform} app credentials. Set here to rotate without a
            redeploy — values not set fall back to the server environment.
          </p>
          {status?.updatedAt && (
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">
              Last updated {formatDateTime(status.updatedAt)}
            </p>
          )}
        </div>
      </header>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Operator Integrations"
        onRetry={refetch}
        loadingMessage="Loading credential status..."
      >
        <div className="space-y-4 p-4">
          {(saveError || deleteError) && (
            <MutationErrorSurface
              error={saveError ?? deleteError}
              feature="Operator Integrations"
              onRetry={() => {
                clearSaveError();
                clearDeleteError();
              }}
            />
          )}

          {data?.refreshError && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Credentials were saved, but the chat plugin did not rebuild ({data.refreshError}). The
                change will apply on the next restart.
              </span>
            </div>
          )}

          <div className="space-y-4">
            {fields.map((field) => (
              <div key={field.envVar} className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor={field.envVar} className="flex items-center gap-1.5">
                    {field.label}
                    {field.required && <span className="text-destructive">*</span>}
                    {field.destructiveRotation && (
                      <AlertTriangle className="size-3.5 text-amber-600" />
                    )}
                  </Label>
                  <SourceBadge field={field} />
                </div>

                {field.secret ? (
                  <div className="relative">
                    <Input
                      id={field.envVar}
                      type={shown[field.envVar] ? "text" : "password"}
                      className="pr-10 font-mono text-sm"
                      placeholder={field.present ? "•••••••• (leave blank to keep)" : "Enter value"}
                      value={draft[field.envVar] ?? ""}
                      onChange={(e) => setField(field.envVar, e.target.value)}
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1/2 size-7 -translate-y-1/2 p-0"
                      onClick={() => setShown((p) => ({ ...p, [field.envVar]: !p[field.envVar] }))}
                    >
                      {shown[field.envVar] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>
                  </div>
                ) : (
                  <Input
                    id={field.envVar}
                    className="font-mono text-sm"
                    placeholder={field.present ? "(leave blank to keep)" : "Enter value"}
                    value={draft[field.envVar] ?? ""}
                    onChange={(e) => setField(field.envVar, e.target.value)}
                    autoComplete="off"
                  />
                )}

                <p
                  className={cn(
                    "text-xs",
                    field.destructiveRotation ? "text-amber-700" : "text-muted-foreground",
                  )}
                >
                  {field.hint}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
            {status?.hasDbOverride && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-muted-foreground"
                onClick={handleRemove}
                disabled={deleting || saving}
              >
                {deleting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Remove console credentials
              </Button>
            )}
            <Button type="button" onClick={handleSave} disabled={saving || deleting || !hasAnyEdit}>
              {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Save credentials
            </Button>
          </div>
        </div>
      </AdminContentWrapper>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-600" />
              Rotate destructive credential?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  You are changing{" "}
                  <span className="font-medium text-foreground">
                    {destructiveEdits.map((f) => f.label).join(", ")}
                  </span>
                  . Rotating this is destructive:
                </p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {destructiveEdits.map((f) => (
                    <li key={f.envVar} className="flex items-start gap-1.5">
                      <KeyRound className="mt-0.5 size-3 shrink-0" />
                      <span>{f.hint}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground">
                  Every workspace using this integration will need to re-authorize. This cannot be
                  undone.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                void persist();
              }}
            >
              Rotate &amp; save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

export default function OperatorIntegrationsPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return <LoadingState message="Checking access..." />;
  return (
    <ErrorBoundary>
      <OperatorIntegrationsContent />
    </ErrorBoundary>
  );
}

function OperatorIntegrationsContent() {
  const { data, loading, error, refetch } = useAdminFetch("/api/v1/platform/operator-integrations", {
    schema: ListResponseSchema,
  });

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Operator Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Atlas&apos;s own integration app registrations (Slack OAuth app, etc.). Set or rotate them
          here to update every workspace at runtime — no redeploy. Credentials are encrypted at rest;
          a field left blank falls back to the server environment.
        </p>
      </div>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Operator Integrations"
        onRetry={refetch}
        loadingMessage="Loading platforms..."
      >
        <div className="mx-auto max-w-3xl space-y-6">
          {(data?.platforms ?? []).map((p) => (
            <PlatformCard key={p.platform} platform={p.platform} />
          ))}
        </div>
      </AdminContentWrapper>
    </div>
  );
}
