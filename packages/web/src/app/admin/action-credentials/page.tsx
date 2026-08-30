"use client";

import { useState } from "react";
import {
  ActionCredentialsResponseSchema,
  EMPTY_DRAFT,
  SOURCE_LABEL,
  buildUpdatePayload,
  fieldPlaceholder,
  isDraftDirty,
  setValue,
  summarizeTarget,
  toggleCleared,
  type DeployMode,
  type FieldStatus,
  type TargetDraft,
  type TargetStatus,
} from "./credential-form";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError, type FetchError } from "@/ui/lib/fetch-error";
import { Eye, EyeOff, Loader2, Plug, Server } from "lucide-react";

const API_PATH = "/api/v1/admin/action-credentials";

/**
 * Workspace action-target credentials (#5553) — the page over the #3766 API.
 *
 * A workspace admin points Atlas's action targets at THEIR external systems,
 * with no operator involvement and no redeploy. The whole form is generated
 * from the field specs the API serves out of `ACTION_TARGETS`, so a new target
 * appears here the moment it is added to that registry — see the genericity
 * rule in `credential-form.ts`.
 *
 * Deliberately NOT `useConfigForm`. That hook models one settings object with
 * one dirty compare and one save; this page is N independent per-target forms
 * with per-item save/clear and per-item error slots, which is the
 * `useAdminFetch` + itemized `useAdminMutation` shape (cf. `/admin/mcp-action-policy`).
 * The dirty gate `useConfigForm` would have supplied lives in
 * `isDraftDirty` instead, derived from the same draft the payload is built
 * from so a field cannot be in one and missing from the other.
 *
 * Permission gating is server-side, like every sibling settings page: the
 * router mounts `requirePermission("admin:settings")`, and a caller without it
 * gets a 403 that `AdminContentWrapper` renders as the shared access-denied
 * surface. There is no client-side role check to drift from the real one.
 *
 * @see ADR-0046 — per-workspace action credentials
 */
export default function ActionCredentialsPage() {
  const { data, loading, error, refetch } = useAdminFetch(API_PATH, {
    schema: ActionCredentialsResponseSchema,
  });

  const {
    mutate,
    errorFor,
    clearErrorFor,
    isMutating,
    error: mutationError,
    clearError,
  } = useAdminMutation({ path: API_PATH, invalidates: refetch });

  // Per-target drafts, keyed by target slug. Absent = untouched.
  const [drafts, setDrafts] = useState<Record<string, TargetDraft>>({});
  // Revealed secret inputs, keyed `${target}:${envVar}`.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [pendingClear, setPendingClear] = useState<TargetStatus | null>(null);

  function draftFor(target: string): TargetDraft {
    return drafts[target] ?? EMPTY_DRAFT;
  }

  function updateDraft(target: string, next: TargetDraft) {
    setDrafts((prev) => ({ ...prev, [target]: next }));
  }

  async function save(target: TargetStatus) {
    const draft = draftFor(target.target);
    if (!isDraftDirty(draft)) return;
    clearErrorFor(target.target);
    const result = await mutate({
      path: `${API_PATH}/${encodeURIComponent(target.target)}`,
      method: "PUT",
      itemId: target.target,
      body: { ...buildUpdatePayload(draft) },
    });
    // Re-baseline only on success: a failed save must keep what the admin
    // typed, or a transient 500 costs them credentials they cannot re-read
    // from anywhere.
    if (result.ok) updateDraft(target.target, EMPTY_DRAFT);
  }

  async function clearStored(target: TargetStatus) {
    clearErrorFor(target.target);
    const result = await mutate({
      path: `${API_PATH}/${encodeURIComponent(target.target)}`,
      method: "DELETE",
      itemId: target.target,
    });
    if (result.ok) {
      updateDraft(target.target, EMPTY_DRAFT);
      setPendingClear(null);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Action Credentials</h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Point Atlas&apos;s action targets at your own external systems. Credentials saved
          here apply to this workspace only, and are stored encrypted — Atlas shows you
          whether each field is set, never the value itself.
        </p>
      </div>

      <ErrorBoundary>
        <MutationErrorSurface
          error={mutationError}
          feature="Action Credentials"
          onRetry={clearError}
        />

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Action Credentials"
          onRetry={refetch}
          loadingMessage="Loading action credentials..."
          emptyIcon={Plug}
          emptyTitle="No action targets"
          emptyDescription="This deployment has no action targets that take per-workspace credentials."
          isEmpty={!data || data.targets.length === 0}
        >
          {data && (
            <div className="space-y-4 max-w-3xl">
              {data.deployMode === "self-hosted" && <SelfHostedNote />}
              {data.targets.map((target) => (
                <TargetCard
                  key={target.target}
                  target={target}
                  deployMode={data.deployMode}
                  draft={draftFor(target.target)}
                  onDraftChange={(next) => updateDraft(target.target, next)}
                  revealed={revealed}
                  onToggleReveal={(key) =>
                    setRevealed((prev) => ({ ...prev, [key]: !prev[key] }))
                  }
                  busy={isMutating(target.target)}
                  itemError={errorFor(target.target)}
                  onSave={() => save(target)}
                  onRequestClear={() => setPendingClear(target)}
                />
              ))}
            </div>
          )}
        </AdminContentWrapper>
      </ErrorBoundary>

      <ClearDialog
        target={pendingClear}
        busy={pendingClear ? isMutating(pendingClear.target) : false}
        onCancel={() => setPendingClear(null)}
        onConfirm={() => pendingClear && clearStored(pendingClear)}
      />
    </div>
  );
}

/**
 * Names the environment rung once, at the top, rather than on every card.
 * Acceptance criterion 3: an operator whose actions already work from
 * `process.env` needs to understand why this page can show "not configured"
 * and the action still runs. On SaaS the rung does not exist (ADR-0046), so
 * this never renders there.
 */
function SelfHostedNote() {
  return (
    <div className="flex gap-3 rounded-lg border bg-muted/30 px-4 py-3">
      <Server className="size-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
      <p className="text-xs text-muted-foreground">
        This is a self-hosted deployment, so a target with no credentials saved here falls
        back to the environment variables set on the server. Credentials saved here take
        precedence for this workspace — and they are all-or-nothing: once any are saved,
        every required field must come from this page, not topped up from the environment.
      </p>
    </div>
  );
}

interface TargetCardProps {
  target: TargetStatus;
  deployMode: DeployMode;
  draft: TargetDraft;
  onDraftChange: (next: TargetDraft) => void;
  revealed: Record<string, boolean>;
  onToggleReveal: (key: string) => void;
  busy: boolean;
  itemError: FetchError | undefined;
  onSave: () => void;
  onRequestClear: () => void;
}

function TargetCard({
  target,
  deployMode,
  draft,
  onDraftChange,
  revealed,
  onToggleReveal,
  busy,
  itemError,
  onSave,
  onRequestClear,
}: TargetCardProps) {
  const summary = summarizeTarget(target, deployMode);
  const dirty = isDraftDirty(draft);

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{target.label}</h2>
              <Badge
                variant="outline"
                className={cn(
                  summary.tone === "configured" &&
                    "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400",
                  summary.tone === "environment" &&
                    "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400",
                  summary.tone === "unconfigured" && "text-muted-foreground",
                )}
              >
                {summary.label}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{summary.detail}</p>
          </div>
          {target.resolvedFrom === "workspace" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRequestClear}
            >
              Remove
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {target.fields.map((field) => (
          <CredentialField
            key={field.envVar}
            target={target.target}
            field={field}
            draft={draft}
            onDraftChange={onDraftChange}
            revealed={revealed}
            onToggleReveal={onToggleReveal}
            disabled={busy}
          />
        ))}

        {itemError && (
          <p className="text-xs text-red-600 dark:text-red-400">{friendlyError(itemError)}</p>
        )}

        <div className="flex items-center gap-3">
          <Button type="button" size="sm" disabled={!dirty || busy} onClick={onSave}>
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Save
          </Button>
          {!dirty && (
            <span className="text-xs text-muted-foreground">
              Enter a value to save. Fields left blank keep what is already stored.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface CredentialFieldProps {
  target: string;
  field: FieldStatus;
  draft: TargetDraft;
  onDraftChange: (next: TargetDraft) => void;
  revealed: Record<string, boolean>;
  onToggleReveal: (key: string) => void;
  disabled: boolean;
}

function CredentialField({
  target,
  field,
  draft,
  onDraftChange,
  revealed,
  onToggleReveal,
  disabled,
}: CredentialFieldProps) {
  const key = `${target}:${field.envVar}`;
  const inputId = `cred-${key}`;
  const clearId = `clear-${key}`;
  const isCleared = draft.cleared.includes(field.envVar);
  const show = Boolean(revealed[key]);
  // Secrets render as a password input and are NEVER prefilled — the server
  // sends presence, not bytes. Non-secret fields are not prefilled either, for
  // the same reason: the read is masked status-only for every field.
  const value = draft.values[field.envVar] ?? "";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId} className="text-sm">
          {field.label}
          {field.required ? (
            <span className="text-red-600 dark:text-red-400" aria-label="required">
              {" *"}
            </span>
          ) : (
            <span className="text-xs font-normal text-muted-foreground"> (optional)</span>
          )}
        </Label>
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          {SOURCE_LABEL[field.source]}
        </Badge>
      </div>

      <div className="relative">
        <Input
          id={inputId}
          type={field.secret && !show ? "password" : "text"}
          className={cn("font-mono text-sm", field.secret && "pr-10")}
          placeholder={isCleared ? "Will be removed on save" : fieldPlaceholder(field)}
          value={isCleared ? "" : value}
          disabled={disabled || isCleared}
          autoComplete="off"
          onChange={(e) => onDraftChange(setValue(draft, field.envVar, e.target.value))}
        />
        {field.secret && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
            aria-label={show ? `Hide ${field.label}` : `Show ${field.label}`}
            onClick={() => onToggleReveal(key)}
          >
            {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {field.hint} Stored as <code className="font-mono">{field.envVar}</code>.
      </p>

      <div className="flex items-center gap-2">
        <Checkbox
          id={clearId}
          checked={isCleared}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onDraftChange(toggleCleared(draft, field.envVar, checked === true))
          }
        />
        <Label htmlFor={clearId} className="text-xs font-normal text-muted-foreground">
          Remove this workspace&apos;s saved value on save
        </Label>
      </div>
    </div>
  );
}

function ClearDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: TargetStatus | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {target?.label} credentials?</AlertDialogTitle>
          <AlertDialogDescription>
            Every field saved for this workspace is deleted. {target?.label} actions stop
            working for this workspace until credentials are entered again — or, on a
            self-hosted deployment, until the server&apos;s environment variables can answer
            for them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
