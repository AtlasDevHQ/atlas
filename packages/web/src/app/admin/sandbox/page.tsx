"use client";

import { useEffect, useState, type ComponentType } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import {
  CompactRow,
  DetailList,
  DetailRow,
  InlineError,
  SectionHeading,
  Shell,
  StatusDot,
  type StatusKind,
  useDisclosure,
} from "@/ui/components/admin/compact";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useConfigForm } from "@/ui/hooks/use-config-form";
// Provider-key vocabulary and status wire schemas are shared with the
// API route layer via `@useatlas/schemas` (#3371).
import {
  SANDBOX_PROVIDER_KEYS,
  SANDBOX_PROVIDER_BACKEND_IDS,
  SandboxStatusSchema,
  type SandboxConnectedProvider as ConnectedProvider,
  type SandboxProviderKey,
  type SandboxStatus,
} from "@/ui/lib/admin-schemas";
import { combineMutationErrors } from "@/ui/lib/mutation-errors";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Box,
  Cloud,
  Cpu,
  Loader2,
  OctagonX,
  Plus,
  RotateCcw,
  Save,
  Server,
  TrainFront,
  Trash2,
} from "lucide-react";

// ── Provider metadata ─────────────────────────────────────────────

interface ProviderInfo {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  fields: {
    key: string;
    label: string;
    type: "text" | "password";
    placeholder: string;
    required: boolean;
  }[];
}

const PROVIDERS: Record<SandboxProviderKey, ProviderInfo> = {
  vercel: {
    label: "Vercel Sandbox",
    description: "Firecracker microVM with network isolation.",
    icon: Cpu,
    fields: [
      { key: "accessToken", label: "Access Token", type: "password", placeholder: "vercel_...", required: true },
      { key: "teamId", label: "Team ID", type: "text", placeholder: "team_...", required: true },
      // Required at runtime — @vercel/sandbox needs the full
      // token/teamId/projectId triple to create sandboxes (#3370).
      { key: "projectId", label: "Project ID", type: "text", placeholder: "prj_...", required: true },
    ],
  },
  e2b: {
    label: "E2B",
    description: "Ephemeral cloud sandboxes with sub-second startup.",
    icon: Box,
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "e2b_...", required: true },
    ],
  },
  daytona: {
    label: "Daytona",
    description: "Cloud-hosted development sandboxes.",
    icon: Server,
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "daytona_...", required: true },
      { key: "apiUrl", label: "API URL", type: "text", placeholder: "https://api.daytona.io", required: false },
    ],
  },
  railway: {
    label: "Railway",
    description:
      "Ephemeral Railway microVMs. Outbound network egress is not blocked — single-tenant use only.",
    icon: TrainFront,
    fields: [
      { key: "token", label: "API Token", type: "password", placeholder: "Railway API token", required: true },
      { key: "environmentId", label: "Environment ID", type: "text", placeholder: "Environment UUID", required: true },
    ],
  },
};

// Compile-time guard: a provider key added to `SANDBOX_PROVIDER_KEYS`
// without a `PROVIDERS` entry fails the `Record<SandboxProviderKey, ...>`
// annotation above; iteration order comes from the shared tuple.
const PROVIDER_KEYS = SANDBOX_PROVIDER_KEYS;

// ── StatusPill (page-specific labels) ─────────────────────────────
// Kept inline because this page uses several custom labels ("Available",
// "Connected", "Override", "Default") that the shared Shell's default
// trailing pill doesn't cover. Consumed via Shell's `trailing` prop.

function StatusPill({ kind, label }: { kind: StatusKind; label: string }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em]",
        kind === "connected" && "text-primary",
        kind === "ready" && "text-primary/80",
        (kind === "disconnected" || kind === "unavailable") && "text-muted-foreground",
      )}
    >
      <StatusDot kind={kind} />
      {label}
    </span>
  );
}

// ── Fail-closed outage ────────────────────────────────────────────

/**
 * The deployment's sandbox plan constructs nothing, so explore refuses every
 * request. Presented as an OUTAGE, above both views, because that is what it is
 * — this is the page an operator opens to diagnose sandboxing, and before #4837
 * neither view said so. The self-hosted view rendered the string `"fail-closed"`
 * in the same monospace "Active" slot as `vercel-sandbox`, reading as one more
 * backend id; the SaaS view never rendered `activeBackend` at all and showed
 * "Atlas Cloud Sandbox · Live", which is the worse half of the bug.
 *
 * Reachable in SaaS production, not just in theory (#4828 — see
 * `formatSandboxFailClosed`, which composes the message this renders).
 *
 * `remediation` is rendered verbatim, never paraphrased or supplemented: the
 * server composed it from the resolved plan, so it names the pinned backend and
 * the credential it actually needs. Local copy would either duplicate that
 * derivation or regress to generic advice a priority pin makes unactionable.
 *
 * Exported for `__tests__/fail-closed-outage.test.tsx`, on the same footing as
 * `SaasSandboxView` below: it renders from the page shell (above BOTH views), so
 * reaching it through the page would mean mocking the fetch and deploy-mode
 * hooks to assert copy that has nothing to do with either.
 */
export function SandboxOutageNotice({
  remediation,
  workspaceStillRunning,
}: {
  /**
   * Nullable on purpose. The headline is driven by the outage STATE
   * (`platformDefault === null`), not by this string, so a payload that somehow
   * arrives without a `failClosed` block still raises the alarm — it just cannot
   * say how to fix it. Losing the remediation must never downgrade the reported
   * state, and this is where that principle meets the DOM.
   */
  remediation: string | null;
  /**
   * A workspace BYOC override resolved despite the platform outage. It sits
   * ahead of the platform plan, so this workspace's explore still works — the
   * deployment default is what is down. Saying "every request is refused" here
   * would be a false alarm, and an operator who dismisses one alarm as noise
   * dismisses the next one too.
   */
  workspaceStillRunning: boolean;
}) {
  return (
    <Alert variant="destructive" role="alert">
      <OctagonX />
      <AlertTitle>
        {workspaceStillRunning
          ? "Platform sandbox unavailable — this workspace is running on its own backend"
          : "Explore tool unavailable — every request is refused"}
      </AlertTitle>
      <AlertDescription>
        <p>
          {workspaceStillRunning
            ? "No platform sandbox backend can be constructed on this deployment. This workspace's own connected backend still runs, but any workspace falling back to the platform default has no working sandbox."
            : "No sandbox backend can be constructed on this deployment, and it is configured to refuse rather than run unsandboxed. Explore tool calls fail until this is fixed."}
        </p>
        {remediation ? (
          <p className="font-mono text-xs leading-relaxed">{remediation}</p>
        ) : (
          <p>
            No remediation was reported — check the API startup warnings for the
            pinned backend and its missing credential.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function SandboxPage() {
  // View-swapping consumer (deploy-mode parity contract Rule 2, #3378): this
  // page swaps whole mode-specific views AND writes mode-specific values
  // (ATLAS_SANDBOX_BACKEND vocabulary differs per view), so it must never
  // commit to a guessed mode. Mode loading/error are folded into the
  // AdminContentWrapper below — neither view (and neither view's save path)
  // renders until the mode is authoritative. `resolved` (not just
  // loading/error) is the authoritative signal: a settings response missing
  // `deployMode` (frontend/API version skew) reports loading:false,
  // error:null, resolved:false, and must hold the neutral state rather than
  // render a guessed view's save path (#3391 review).
  const {
    deployMode,
    loading: modeLoading,
    error: modeError,
    resolved: modeResolved,
  } = useDeployMode();
  const isSaas = deployMode === "saas";

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/sandbox/status",
    { schema: SandboxStatusSchema },
  );

  const saveMutation = useAdminMutation({
    path: "/api/v1/admin/settings/ATLAS_SANDBOX_BACKEND",
    method: "PUT",
    invalidates: refetch,
  });

  const saveUrlMutation = useAdminMutation({
    path: "/api/v1/admin/settings/ATLAS_SANDBOX_URL",
    method: "PUT",
    invalidates: refetch,
  });

  const resetMutation = useAdminMutation({
    method: "DELETE",
    invalidates: refetch,
  });

  const mutationError = combineMutationErrors([
    saveMutation.error,
    saveUrlMutation.error,
    resetMutation.error,
  ]);

  function clearMutationError() {
    saveMutation.clearError();
    saveUrlMutation.clearError();
    resetMutation.clearError();
  }

  return (
    <div className="p-6">
      <ErrorBoundary>
        {/* Heading copy is cosmetic-tier (Rule 2) — it may render from the
            hostname guess while the mode resolves. */}
        <div className="mx-auto mb-8 max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isSaas ? "Execution Environment" : "Sandbox"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSaas
              ? "Atlas runs code in isolated sandboxes. Use the managed one, or connect your own cloud."
              : "Choose how the explore tool executes commands for this workspace. The Python tool follows the platform-level sandbox configuration."}
          </p>
        </div>

        <AdminContentWrapper
          loading={loading || modeLoading || (!modeResolved && !modeError)}
          error={error ?? modeError}
          isEmpty={!data}
          emptyIcon={Box}
          emptyTitle="Sandbox unavailable"
          emptyDescription="No sandbox status available."
        >
          <div className="mx-auto max-w-3xl space-y-8">
            <MutationErrorSurface
              error={mutationError}
              feature="Sandbox"
              onRetry={clearMutationError}
            />

            {/* Gated on the outage STATE, not on the optional `failClosed`
                block: the banner is the loudest signal on the page, so it must
                not be the thing that disappears if the block ever goes missing. */}
            {data && data.platformDefault === null && (
              <SandboxOutageNotice
                remediation={data.failClosed?.remediation || null}
                workspaceStillRunning={data.activeBackend !== null}
              />
            )}

            {data &&
              (isSaas ? (
                <SaasSandboxView
                  status={data}
                  onSelectBackend={(backendId) =>
                    saveMutation.mutate({ body: { value: backendId } })
                  }
                  onSelectManaged={() =>
                    resetMutation.mutate({
                      path: "/api/v1/admin/settings/ATLAS_SANDBOX_BACKEND",
                    })
                  }
                  onRefetch={refetch}
                  saving={saveMutation.saving || resetMutation.saving}
                />
              ) : (
                <SelfHostedSandboxView
                  onSelectBackend={(backendId) =>
                    saveMutation.mutate({ body: { value: backendId } })
                  }
                  onSetSidecarUrl={(url) =>
                    saveUrlMutation.mutate({ body: { value: url } })
                  }
                  onReset={async () => {
                    await Promise.all([
                      resetMutation.mutate({
                        path: "/api/v1/admin/settings/ATLAS_SANDBOX_BACKEND",
                      }),
                      resetMutation.mutate({
                        path: "/api/v1/admin/settings/ATLAS_SANDBOX_URL",
                      }),
                    ]);
                  }}
                  saving={
                    saveMutation.saving ||
                    saveUrlMutation.saving ||
                    resetMutation.saving
                  }
                />
              ))}
          </div>
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}

// ── SaaS view ─────────────────────────────────────────────────────
// Exported for the save-value-mapping regression test (#3375) — the
// backend-id vocabulary written to ATLAS_SANDBOX_BACKEND is asserted in
// `__tests__/saas-backend-selection.test.tsx`.

export function SaasSandboxView({
  status,
  onSelectBackend,
  onSelectManaged,
  onRefetch,
  saving,
}: {
  status: SandboxStatus;
  onSelectBackend: (backendId: string) => Promise<unknown>;
  onSelectManaged: () => Promise<unknown>;
  onRefetch: () => void;
  saving: boolean;
}) {
  const connected = status.connectedProviders;
  // Managed is the SELECTED card whenever no BYOC provider row is live —
  // `isActive` is server-derived in backend-id vocabulary (#3375), so this
  // can't disagree with the runtime resolution.
  const isManagedSelected = !connected.some((p) => p.isActive);
  // Selected is not the same as running. "Managed" means *follow the platform
  // default*, and a null `platformDefault` is the deployment saying it has no
  // default to follow (#4837). Without this third state the SaaS view — which
  // never rendered `activeBackend` at all, so the self-hosted view's
  // `Active: fail-closed` row could not even warn here — showed
  // "Atlas Cloud Sandbox · Live" on a region refusing every explore request.
  //
  // Collapsed to one value rather than an `isActive` + `isDown` pair so
  // "selected but down" cannot be spelled as `{ isActive: false, isDown: true }`
  // — an incoherent card the type system would otherwise permit.
  //
  // `down` is checked FIRST and independently of selection. The card offers
  // "follow the platform default"; if that default constructs nothing the option
  // is down whether or not this workspace currently sits on it. Gating down-ness
  // on selection left the un-selected case reading "Available" with a live
  // "Use this" button — one click moving the workspace off a working BYOC
  // backend and onto the outage.
  const managedState: ManagedState =
    status.platformDefault === null ? "down" : isManagedSelected ? "live" : "available";

  return (
    <>
      <section>
        <SectionHeading
          title="Managed"
          description="Atlas-hosted sandbox. No setup — always available."
        />
        <ManagedSandboxShell
          state={managedState}
          // "Managed" means *follow the platform default* (the SaaS
          // `vercel-sandbox` pin in deploy/api/atlas.config.ts), so it
          // clears the workspace override rather than writing a value —
          // the previous "sidecar" write never matched a real backend,
          // and pinning the current default would go stale if the
          // platform pin ever changes (#3375).
          onSelect={() => onSelectManaged()}
          saving={saving}
        />
      </section>

      <section>
        <SectionHeading
          title="Bring your own cloud"
          description="Connect your own provider for isolated execution you control."
        />
        <div className="space-y-2">
          {PROVIDER_KEYS.map((key) => {
            const provider = connected.find((p) => p.provider === key);
            return (
              <ProviderRow
                key={key}
                providerKey={key}
                connection={provider ?? null}
                isActive={provider?.isActive ?? false}
                // Absent field (older API) defaults to available so the page
                // degrades to its pre-#3370 behavior rather than locking
                // every card.
                runtimeAvailable={status.providerRuntimeAvailability?.[key] ?? true}
                needsReconnect={provider?.needsReconnect ?? false}
                // ATLAS_SANDBOX_BACKEND stores backend ids, not provider
                // keys — saving the bare key used to fall through to the
                // platform default silently (#3375).
                onSelect={() => onSelectBackend(SANDBOX_PROVIDER_BACKEND_IDS[key])}
                onRefetch={onRefetch}
                saving={saving}
              />
            );
          })}
        </div>
      </section>
    </>
  );
}

// ── Managed Sandbox ───────────────────────────────────────────────

/**
 * The three readings of the managed card, as one value.
 *
 * `"live"` and `"down"` are the pair this card must never confuse — that
 * confusion IS #4837 — and `"available"` (not selected, still offerable) is a
 * third thing rather than the negation of either.
 */
type ManagedState = "available" | "live" | "down";

const MANAGED_PRESENTATION: Record<
  ManagedState,
  { status: StatusKind; label: string }
> = {
  available: { status: "ready", label: "Available" },
  live: { status: "connected", label: "Live" },
  // `unavailable` is the closest existing StatusKind; the destructive banner
  // above carries the alarm, this pill just must not read as "Live".
  down: { status: "unavailable", label: "Down" },
};

function ManagedSandboxShell({
  state,
  onSelect,
  saving,
}: {
  state: ManagedState;
  onSelect: () => Promise<unknown>;
  saving: boolean;
}) {
  const { status, label } = MANAGED_PRESENTATION[state];
  return (
    <Shell
      icon={Cloud}
      title="Atlas Cloud Sandbox"
      description="Managed Firecracker microVM with network isolation. Recommended for most workspaces."
      status={status}
      trailing={<StatusPill kind={status} label={label} />}
      actions={
        // Offered only when selecting it would change something. Not while live
        // (already in effect) and not while down — selecting the platform
        // default is exactly what is in effect and broken.
        state === "available" && (
          <Button size="sm" onClick={onSelect} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Use this
          </Button>
        )
      }
    >
      {state === "down" ? (
        <p className="text-xs text-destructive">
          This deployment has no working sandbox backend — see the outage above.
          Connect your own cloud below to restore the explore tool for this
          workspace.
        </p>
      ) : state === "available" ? (
        <p className="text-xs text-muted-foreground">
          Switch back here anytime — no credentials required.
        </p>
      ) : null}
    </Shell>
  );
}

// ── BYOC Provider Row ─────────────────────────────────────────────

function ProviderRow({
  providerKey,
  connection,
  isActive,
  runtimeAvailable,
  needsReconnect,
  onSelect,
  onRefetch,
  saving,
}: {
  providerKey: SandboxProviderKey;
  connection: ConnectedProvider | null;
  isActive: boolean;
  runtimeAvailable: boolean;
  needsReconnect: boolean;
  onSelect: () => Promise<unknown>;
  onRefetch: () => void;
  saving: boolean;
}) {
  const info = PROVIDERS[providerKey];
  const isConnected = !!connection;
  // A provider only runs when this deployment has its runtime AND the stored
  // credentials are complete — otherwise selecting it silently falls back to
  // the platform default, so the card must not offer "Use this" (#3370).
  const isUsable = runtimeAvailable && !needsReconnect;
  const status: StatusKind = isActive
    ? "connected"
    : isConnected
      ? isUsable
        ? "ready"
        : "unavailable"
      : runtimeAvailable
        ? "disconnected"
        : "unavailable";

  const disconnectMutation = useAdminMutation({
    path: `/api/v1/admin/sandbox/disconnect/${providerKey}`,
    method: "DELETE",
    invalidates: onRefetch,
  });

  const connectMutation = useAdminMutation<{
    connected: boolean;
    displayName: string | null;
    validatedAt: string;
  }>({
    path: `/api/v1/admin/sandbox/connect/${providerKey}`,
    method: "POST",
    invalidates: onRefetch,
  });

  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState<string | null>(null);

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({
      collapseOn: isConnected,
      onCollapseCleanup: () => {
        connectMutation.clearError();
        setValidationError(null);
        setFieldValues({});
      },
    });

  // `useDisclosure`'s auto-collapse fires `setExpanded(false)` directly, without
  // running `onCollapseCleanup`. Reset locally on connect so a later disconnect
  // + re-expand doesn't pre-fill the credential inputs with the token the user
  // just saved.
  const clearConnectError = connectMutation.clearError;
  useEffect(() => {
    if (isConnected) {
      clearConnectError();
      setValidationError(null);
      setFieldValues({});
    }
  }, [isConnected, clearConnectError]);

  const showFull = isConnected || expanded;

  // No runtime for this provider in this deployment: connecting credentials
  // would store secrets that can never run. Say so instead of offering a
  // connect flow that implies isolation that won't happen (#3370).
  if (!runtimeAvailable && !isConnected) {
    return (
      <CompactRow
        icon={info.icon}
        title={info.label}
        description={`${info.description} Not available on this deployment.`}
        status={status}
        action={<StatusPill kind="unavailable" label="Unavailable" />}
      />
    );
  }

  if (!showFull) {
    return (
      <CompactRow
        icon={info.icon}
        title={info.label}
        description={info.description}
        status={status}
        action={
          <Button
            ref={triggerRef}
            size="sm"
            variant="outline"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            <Plus className="mr-1.5 size-3.5" />
            Connect
          </Button>
        }
      />
    );
  }

  async function handleConnect() {
    setValidationError(null);
    for (const field of info.fields) {
      if (field.required && !fieldValues[field.key]?.trim()) {
        setValidationError(`${field.label} is required`);
        return;
      }
    }
    const credentials: Record<string, string> = {};
    for (const field of info.fields) {
      const val = fieldValues[field.key]?.trim();
      if (val) credentials[field.key] = val;
    }
    await connectMutation.mutate({ body: { credentials } });
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={info.icon}
      title={info.label}
      description={info.description}
      status={status}
      trailing={
        isActive ? (
          <StatusPill kind="connected" label="Live" />
        ) : isConnected ? (
          needsReconnect ? (
            <StatusPill kind="unavailable" label="Reconnect required" />
          ) : runtimeAvailable ? (
            <StatusPill kind="ready" label="Connected" />
          ) : (
            <StatusPill kind="unavailable" label="Unavailable" />
          )
        ) : undefined
      }
      onCollapse={!isConnected ? collapse : undefined}
      actions={
        isConnected ? (
          <>
            {!isActive && isUsable && (
              <Button size="sm" onClick={onSelect} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Use this
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={disconnectMutation.saving}
                >
                  {disconnectMutation.saving ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="mr-1.5 size-3.5" />
                  )}
                  Disconnect
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect {info.label}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes your {info.label} credentials.
                    {isActive &&
                      " Since this is your active sandbox, execution will fall back to Atlas Cloud Sandbox."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      await disconnectMutation.mutate({});
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <Button size="sm" onClick={handleConnect} disabled={connectMutation.saving}>
            {connectMutation.saving && (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            )}
            Validate & connect
          </Button>
        )
      }
    >
      {isConnected ? (
        <>
          <DetailList>
            {connection.displayName && (
              <DetailRow label="Account" value={connection.displayName} />
            )}
            <DetailRow label="Connected" value={formatDateTime(connection.connectedAt)} />
            {connection.validatedAt && (
              <DetailRow label="Validated" value={formatDateTime(connection.validatedAt)} />
            )}
          </DetailList>
          {needsReconnect && (
            <p className="text-xs text-muted-foreground">
              These credentials are missing fields now required to run sandboxes
              (for Vercel, a Project ID). Disconnect and reconnect with the full
              set to use this provider.
            </p>
          )}
          {!runtimeAvailable && (
            <p className="text-xs text-muted-foreground">
              This provider isn&apos;t available on this deployment, so the stored
              credentials can&apos;t be used to run sandboxes yet.
            </p>
          )}
        </>
      ) : (
        <div className="space-y-3">
          {info.fields.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`${providerKey}-${field.key}`}>
                {field.label}
                {!field.required && (
                  <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
                )}
              </Label>
              <Input
                id={`${providerKey}-${field.key}`}
                type={field.type}
                placeholder={field.placeholder}
                className={field.type === "password" ? "font-mono text-sm" : undefined}
                value={fieldValues[field.key] ?? ""}
                onChange={(e) => {
                  setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }));
                  // Clear prior client-side validation so a stale "required"
                  // message doesn't persist after the user starts typing a
                  // valid value.
                  if (validationError) setValidationError(null);
                }}
              />
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Credentials are validated against the provider API before saving.
          </p>
        </div>
      )}

      {validationError && <InlineError>{validationError}</InlineError>}
      <MutationErrorSurface
        error={connectMutation.error}
        feature="Sandbox"
        variant="inline"
      />
      <MutationErrorSurface
        error={disconnectMutation.error}
        feature="Sandbox"
        variant="inline"
      />
    </Shell>
  );
}

// ── Self-hosted view ──────────────────────────────────────────────

/** Editable field set for the self-hosted backend form (#4204). */
type SelfHostedFormValues = {
  backend: string;
  sidecarUrl: string;
};

/**
 * Exported for `__tests__/fail-closed-outage.test.tsx` — this view owns the row
 * #4837 is literally named after (`Active: fail-closed` in the monospace slot),
 * and self-hosted reaches fail-closed through the `ATLAS_SANDBOX=nsjail` pin
 * with no usable binary (#4829). Same footing as `SaasSandboxView` above.
 */
export function SelfHostedSandboxView({
  onSelectBackend,
  onSetSidecarUrl,
  onReset,
  saving,
}: {
  onSelectBackend: (backendId: string) => Promise<unknown>;
  onSetSidecarUrl: (url: string) => Promise<unknown>;
  onReset: () => Promise<void>;
  saving: boolean;
}) {
  // Load / dirty gate / reset-on-refetch ride `useConfigForm` on the same
  // status query the page already fetches (TanStack dedupes on the path key),
  // replacing the hand-rolled useState pair + `hasChanges` compare (#4204).
  // The save itself deliberately does NOT go through `form.save()`: it fans
  // out to two settings endpoints (ATLAS_SANDBOX_BACKEND / ATLAS_SANDBOX_URL,
  // PUT or DELETE depending on the value) via the parent's mutations, and
  // multi-endpoint saves are out of useConfigForm's scope by design (see the
  // hook docs). The mutations' invalidation refetch still drives the
  // re-baseline, so a successful save flips `dirty` back to false.
  const form = useConfigForm<SandboxStatus, SelfHostedFormValues>({
    path: "/api/v1/admin/sandbox/status",
    schema: SandboxStatusSchema,
    toForm: (s) => ({
      backend: s.workspaceOverride ?? "",
      sidecarUrl: s.workspaceSidecarUrl ?? "",
    }),
  });

  const status = form.data;
  const fields = form.fields;
  const values = form.values;
  // The parent only renders this view once the status query has data, so
  // this guard closes the single pre-baseline render pass, not a real state.
  if (!status || !fields || !values) return null;

  const availableBackends = status.availableBackends.filter((b) => b.available);
  // This is the ONLY place on the page that compares `activeBackend` against a
  // backend id, and it is the one #4837 asks to audit ("audit every consumer
  // that compares `activeBackend` against a backend id"). It was already correct
  // by accident — `"fail-closed" !== "sidecar"` — and is now correct by
  // construction, since the sentinel can no longer reach this value at all.
  const showSidecarUrl =
    values.backend === "sidecar" ||
    (!values.backend && status.activeBackend === "sidecar");
  const hasOverride = Boolean(status.workspaceOverride);
  // A null `activeBackend` is this workspace's explore being down, and it must
  // outrank "Override"/"Default" — those describe which knob is in effect, which
  // is not the operator's problem when nothing runs.
  const isDown = status.activeBackend === null;
  const shellStatus: StatusKind = isDown
    ? "unavailable"
    : hasOverride
      ? "connected"
      : "ready";

  return (
    <section>
      <SectionHeading
        title="Backend"
        description="Select which backend executes explore tool calls. The Python tool follows the platform-level sandbox configuration."
      />
      <Shell
        icon={Server}
        title="Sandbox backend"
        description={
          hasOverride
            ? `This workspace overrides the platform default.`
            : status.platformDefault === null
              ? `The platform default has no usable backend, so explore requests are refused.`
              : `Using the platform default (${status.platformDefault}).`
        }
        status={shellStatus}
        trailing={
          <StatusPill
            kind={shellStatus}
            label={isDown ? "Down" : hasOverride ? "Override" : "Default"}
          />
        }
        actions={
          <>
            {hasOverride && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={async () => {
                  // The DELETEs' invalidation refetch re-baselines the form
                  // to the cleared override — no manual field reset needed.
                  await onReset();
                }}
                disabled={saving}
              >
                <RotateCcw className="mr-1.5 size-3.5" />
                Reset
              </Button>
            )}
            <Button
              size="sm"
              onClick={async () => {
                // `"__default__"` is a Select sentinel: picking it clears the
                // workspace override so the platform default takes over.
                const effectiveBackend =
                  values.backend === "__default__" ? "" : values.backend;
                if (effectiveBackend) {
                  await onSelectBackend(effectiveBackend);
                } else {
                  await onReset();
                }
                if (values.sidecarUrl && showSidecarUrl && effectiveBackend) {
                  await onSetSidecarUrl(values.sidecarUrl);
                }
              }}
              disabled={saving || !form.dirty}
            >
              {saving ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 size-3.5" />
              )}
              Save
            </Button>
          </>
        }
      >
        <DetailList>
          {/* `mono` marks machine literals (ids, URLs). A null renders as worded
              destructive text instead, so the outage can never be mistaken for
              one more id in the same monospace slot — the exact misreading
              #4837 is about. */}
          <DetailRow
            label="Active"
            value={
              status.activeBackend ?? (
                <span className="text-destructive">None — explore refuses every request</span>
              )
            }
            mono={status.activeBackend !== null}
          />
          <DetailRow
            label="Platform default"
            value={
              status.platformDefault ?? (
                <span className="text-destructive">None — fails closed</span>
              )
            }
            mono={status.platformDefault !== null}
          />
          {status.workspaceSidecarUrl && (
            <DetailRow
              label="Sidecar URL"
              value={status.workspaceSidecarUrl}
              mono
            />
          )}
        </DetailList>

        <div className="space-y-1.5">
          <Label htmlFor="sandbox-backend">Backend</Label>
          <Select value={values.backend} onValueChange={fields.backend.set}>
            <SelectTrigger id="sandbox-backend" aria-label="Sandbox backend">
              <SelectValue placeholder="Use platform default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">
                {status.platformDefault === null
                  ? "Use platform default (none — fails closed)"
                  : `Use platform default (${status.platformDefault})`}
              </SelectItem>
              {availableBackends.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                  {b.type === "plugin" ? " (plugin)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {availableBackends.length === 0
              ? "No sandbox backends are available in this deployment."
              : "Select a backend for this workspace, or fall back to the platform default."}
          </p>
        </div>

        {showSidecarUrl && (
          <div className="space-y-1.5">
            <Label htmlFor="sidecar-url">Sidecar URL</Label>
            <Input
              id="sidecar-url"
              type="url"
              placeholder="https://sandbox.example.com"
              className="font-mono text-sm"
              value={values.sidecarUrl}
              onChange={(e) => fields.sidecarUrl.set(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Override the sidecar service URL. Leave empty to use the platform default.
            </p>
          </div>
        )}
      </Shell>
    </section>
  );
}
