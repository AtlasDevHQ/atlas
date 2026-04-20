"use client";

import { useEffect, useState, type ComponentType } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  Plus,
  RotateCcw,
  Save,
  Server,
  Trash2,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

const SandboxProviderKeySchema = z.enum(["vercel", "e2b", "daytona"]);
type SandboxProviderKey = z.infer<typeof SandboxProviderKeySchema>;

const SandboxBackendSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["built-in", "plugin"]),
  available: z.boolean(),
  description: z.string().optional(),
});

const ConnectedProviderSchema = z.object({
  provider: SandboxProviderKeySchema,
  displayName: z.string().nullable(),
  connectedAt: z.string(),
  validatedAt: z.string().nullable(),
  isActive: z.boolean(),
});
type ConnectedProvider = z.infer<typeof ConnectedProviderSchema>;

const SandboxStatusSchema = z.object({
  activeBackend: z.string(),
  platformDefault: z.string(),
  workspaceOverride: z.string().nullable(),
  workspaceSidecarUrl: z.string().nullable(),
  availableBackends: z.array(SandboxBackendSchema),
  connectedProviders: z.array(ConnectedProviderSchema),
});
type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

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
};

const PROVIDER_KEYS = Object.keys(PROVIDERS) as SandboxProviderKey[];

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

// ── Page ──────────────────────────────────────────────────────────

export default function SandboxPage() {
  const { deployMode } = useDeployMode();
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
        <div className="mx-auto mb-8 max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isSaas ? "Execution Environment" : "Sandbox"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSaas
              ? "Atlas runs code in isolated sandboxes. Use the managed one, or connect your own cloud."
              : "Choose how the explore and Python tools execute commands for this workspace."}
          </p>
        </div>

        <AdminContentWrapper
          loading={loading}
          error={error}
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

            {data &&
              (isSaas ? (
                <SaasSandboxView
                  status={data}
                  onSelectBackend={(backendId) =>
                    saveMutation.mutate({ body: { value: backendId } })
                  }
                  onRefetch={refetch}
                  saving={saveMutation.saving}
                />
              ) : (
                <SelfHostedSandboxView
                  status={data}
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

function SaasSandboxView({
  status,
  onSelectBackend,
  onRefetch,
  saving,
}: {
  status: SandboxStatus;
  onSelectBackend: (backendId: string) => Promise<unknown>;
  onRefetch: () => void;
  saving: boolean;
}) {
  const connected = status.connectedProviders;
  const isManagedActive =
    !status.workspaceOverride ||
    !connected.some((p) => p.provider === status.workspaceOverride);

  return (
    <>
      <section>
        <SectionHeading
          title="Managed"
          description="Atlas-hosted container service. No setup — always available."
        />
        <ManagedSandboxShell
          isActive={isManagedActive}
          onSelect={() => onSelectBackend("sidecar")}
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
                onSelect={() => onSelectBackend(key)}
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

function ManagedSandboxShell({
  isActive,
  onSelect,
  saving,
}: {
  isActive: boolean;
  onSelect: () => Promise<unknown>;
  saving: boolean;
}) {
  const status: StatusKind = isActive ? "connected" : "ready";
  return (
    <Shell
      icon={Cloud}
      title="Atlas Cloud Sandbox"
      description="Managed container service with HTTP isolation. Recommended for most workspaces."
      status={status}
      trailing={
        isActive ? (
          <StatusPill kind="connected" label="Live" />
        ) : (
          <StatusPill kind="ready" label="Available" />
        )
      }
      actions={
        !isActive && (
          <Button size="sm" onClick={onSelect} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Use this
          </Button>
        )
      }
    >
      {isActive ? null : (
        <p className="text-xs text-muted-foreground">
          Switch back here anytime — no credentials required.
        </p>
      )}
    </Shell>
  );
}

// ── BYOC Provider Row ─────────────────────────────────────────────

function ProviderRow({
  providerKey,
  connection,
  isActive,
  onSelect,
  onRefetch,
  saving,
}: {
  providerKey: SandboxProviderKey;
  connection: ConnectedProvider | null;
  isActive: boolean;
  onSelect: () => Promise<unknown>;
  onRefetch: () => void;
  saving: boolean;
}) {
  const info = PROVIDERS[providerKey];
  const isConnected = !!connection;
  const status: StatusKind = isActive ? "connected" : isConnected ? "ready" : "disconnected";

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
          <StatusPill kind="ready" label="Connected" />
        ) : undefined
      }
      onCollapse={!isConnected ? collapse : undefined}
      actions={
        isConnected ? (
          <>
            {!isActive && (
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
        <DetailList>
          {connection.displayName && (
            <DetailRow label="Account" value={connection.displayName} />
          )}
          <DetailRow label="Connected" value={formatDateTime(connection.connectedAt)} />
          {connection.validatedAt && (
            <DetailRow label="Validated" value={formatDateTime(connection.validatedAt)} />
          )}
        </DetailList>
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

function SelfHostedSandboxView({
  status,
  onSelectBackend,
  onSetSidecarUrl,
  onReset,
  saving,
}: {
  status: SandboxStatus;
  onSelectBackend: (backendId: string) => Promise<unknown>;
  onSetSidecarUrl: (url: string) => Promise<unknown>;
  onReset: () => Promise<void>;
  saving: boolean;
}) {
  const [selectedBackend, setSelectedBackend] = useState(
    status.workspaceOverride ?? "",
  );
  const [sidecarUrl, setSidecarUrl] = useState(status.workspaceSidecarUrl ?? "");

  const availableBackends = status.availableBackends.filter((b) => b.available);
  const showSidecarUrl =
    selectedBackend === "sidecar" ||
    (!selectedBackend && status.activeBackend === "sidecar");
  const hasChanges =
    (selectedBackend && selectedBackend !== (status.workspaceOverride ?? "")) ||
    sidecarUrl !== (status.workspaceSidecarUrl ?? "");
  const hasOverride = Boolean(status.workspaceOverride);
  const shellStatus: StatusKind = hasOverride ? "connected" : "ready";

  return (
    <section>
      <SectionHeading
        title="Backend"
        description="Select which backend executes explore and Python tool calls."
      />
      <Shell
        icon={Server}
        title="Sandbox backend"
        description={
          hasOverride
            ? `This workspace overrides the platform default.`
            : `Using the platform default (${status.platformDefault}).`
        }
        status={shellStatus}
        trailing={
          <StatusPill
            kind={shellStatus}
            label={hasOverride ? "Override" : "Default"}
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
                  await onReset();
                  setSelectedBackend("");
                  setSidecarUrl("");
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
                  selectedBackend === "__default__" ? "" : selectedBackend;
                if (effectiveBackend) {
                  await onSelectBackend(effectiveBackend);
                } else {
                  await onReset();
                }
                if (sidecarUrl && showSidecarUrl && effectiveBackend) {
                  await onSetSidecarUrl(sidecarUrl);
                }
              }}
              disabled={saving || !hasChanges}
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
          <DetailRow label="Active" value={status.activeBackend} mono />
          <DetailRow label="Platform default" value={status.platformDefault} mono />
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
          <Select value={selectedBackend} onValueChange={setSelectedBackend}>
            <SelectTrigger id="sandbox-backend" aria-label="Sandbox backend">
              <SelectValue placeholder="Use platform default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">
                Use platform default ({status.platformDefault})
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
              value={sidecarUrl}
              onChange={(e) => setSidecarUrl(e.target.value)}
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
