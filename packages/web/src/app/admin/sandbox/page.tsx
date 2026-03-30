"use client";

import { useState } from "react";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Box,
  Cloud,
  Cpu,
  Loader2,
  RotateCcw,
  Save,
  Server,
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

const SandboxStatusSchema = z.object({
  activeBackend: z.string(),
  platformDefault: z.string(),
  workspaceOverride: z.string().nullable(),
  workspaceSidecarUrl: z.string().nullable(),
  availableBackends: z.array(SandboxBackendSchema),
  connectedProviders: z.array(ConnectedProviderSchema),
});

// ── Provider metadata ─────────────────────────────────────────────

interface ProviderInfo {
  label: string;
  description: string;
  icon: typeof Cloud;
  fields: { key: string; label: string; type: "text" | "password"; placeholder: string; required: boolean }[];
}

const PROVIDERS: Record<SandboxProviderKey, ProviderInfo> = {
  vercel: {
    label: "Vercel Sandbox",
    description: "Firecracker microVM with network isolation. Bring your own Vercel account.",
    icon: Cpu,
    fields: [
      { key: "accessToken", label: "Access Token", type: "password", placeholder: "vercel_...", required: true },
      { key: "teamId", label: "Team ID", type: "text", placeholder: "team_...", required: true },
    ],
  },
  e2b: {
    label: "E2B",
    description: "Ephemeral cloud sandboxes with sub-second startup. Bring your own API key.",
    icon: Box,
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "e2b_...", required: true },
    ],
  },
  daytona: {
    label: "Daytona",
    description: "Cloud-hosted development sandboxes. Bring your own API key.",
    icon: Server,
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "daytona_...", required: true },
      { key: "apiUrl", label: "API URL", type: "text", placeholder: "https://api.daytona.io", required: false },
    ],
  },
};

const PROVIDER_KEYS = Object.keys(PROVIDERS) as SandboxProviderKey[];

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

  const mutationError =
    saveMutation.error ?? saveUrlMutation.error ?? resetMutation.error;

  return (
    <div className="p-6">
    <ErrorBoundary>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {isSaas ? "Execution Environment" : "Sandbox"}
          </h1>
          <p className="text-muted-foreground">
            {isSaas
              ? "Connect and manage sandbox providers for code execution and data exploration."
              : "Configure the sandbox backend used for the explore and Python tools."}
          </p>
        </div>

        {mutationError && <ErrorBanner message={mutationError} />}

        <AdminContentWrapper
          loading={loading}
          error={error}
          isEmpty={!data}
          emptyIcon={Box}
          emptyTitle="Sandbox unavailable"
          emptyDescription="No sandbox status available."
        >
          {data &&
            (isSaas ? (
              <SandboxIntegrationGrid
                status={data}
                onSelectBackend={async (backendId) => {
                  await saveMutation.mutate({ body: { value: backendId } });
                }}
                onRefetch={refetch}
                saving={saveMutation.saving}
              />
            ) : (
              <SandboxConfigCard
                status={data}
                onSelectBackend={async (backendId) => {
                  await saveMutation.mutate({ body: { value: backendId } });
                }}
                onSetSidecarUrl={async (url) => {
                  await saveUrlMutation.mutate({ body: { value: url } });
                }}
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
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
    </div>
  );
}

// ── SaaS Integration Grid ─────────────────────────────────────────

function SandboxIntegrationGrid({
  status,
  onSelectBackend,
  onRefetch,
  saving,
}: {
  status: SandboxStatus;
  onSelectBackend: (backendId: string) => Promise<void>;
  onRefetch: () => void;
  saving: boolean;
}) {
  const connected = status.connectedProviders;
  const isManagedActive =
    !status.workspaceOverride ||
    !connected.some((p) => p.provider === status.workspaceOverride);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Atlas Cloud Sandbox — always first */}
      <ManagedSandboxCard
        isActive={isManagedActive}
        onSelect={async () => onSelectBackend("sidecar")}
        saving={saving}
      />

      {/* BYOC provider cards */}
      {PROVIDER_KEYS.map((key) => {
        const provider = connected.find((p) => p.provider === key);
        return (
          <ProviderCard
            key={key}
            providerKey={key}
            connection={provider ?? null}
            isActive={provider?.isActive ?? false}
            onSelect={async () => onSelectBackend(key)}
            onRefetch={onRefetch}
            saving={saving}
          />
        );
      })}
    </div>
  );
}

// ── Managed Sandbox Card ──────────────────────────────────────────

function ManagedSandboxCard({
  isActive,
  onSelect,
  saving,
}: {
  isActive: boolean;
  onSelect: () => Promise<void>;
  saving: boolean;
}) {
  return (
    <Card
      className={cn(
        "transition-colors",
        isActive && "ring-2 ring-primary border-primary",
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cloud className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">Atlas Cloud Sandbox</CardTitle>
          </div>
          <div className="flex gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              Recommended
            </Badge>
            {isActive && (
              <Badge variant="default" className="bg-green-600 text-[10px]">
                Active
              </Badge>
            )}
          </div>
        </div>
        <CardDescription>
          Managed container service with HTTP isolation. No setup required.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isActive ? (
          <p className="text-sm text-muted-foreground">
            This is your current execution environment.
          </p>
        ) : (
          <Button size="sm" onClick={onSelect} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Select
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ── BYOC Provider Card ────────────────────────────────────────────

function ProviderCard({
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
  onSelect: () => Promise<void>;
  onRefetch: () => void;
  saving: boolean;
}) {
  const info = PROVIDERS[providerKey];
  const Icon = info.icon;
  const isConnected = !!connection;
  const [connectOpen, setConnectOpen] = useState(false);

  const disconnectMutation = useAdminMutation({
    path: `/api/v1/admin/sandbox/disconnect/${providerKey}`,
    method: "DELETE",
    invalidates: onRefetch,
  });

  return (
    <>
      <Card
        className={cn(
          "transition-colors",
          isActive && "ring-2 ring-primary border-primary",
        )}
      >
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{info.label}</CardTitle>
            </div>
            {isActive ? (
              <Badge variant="default" className="bg-green-600 text-[10px]">
                Active
              </Badge>
            ) : isConnected ? (
              <Badge variant="secondary" className="text-[10px]">
                Connected
              </Badge>
            ) : null}
          </div>
          <CardDescription>{info.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isConnected && (
            <div className="space-y-2 text-sm">
              {connection.displayName && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Account</span>
                  <span className="font-medium">{connection.displayName}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(connection.connectedAt)}</span>
              </div>
            </div>
          )}

          {disconnectMutation.error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {disconnectMutation.error}
            </div>
          )}

          <div className="flex gap-2">
            {!isConnected && (
              <Button size="sm" onClick={() => setConnectOpen(true)}>
                Connect
              </Button>
            )}

            {isConnected && !isActive && (
              <Button size="sm" onClick={onSelect} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Select
              </Button>
            )}

            {isConnected && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disconnectMutation.saving}
                  >
                    {disconnectMutation.saving && (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    )}
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Disconnect {info.label}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove your {info.label} credentials.
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
            )}
          </div>
        </CardContent>
      </Card>

      {/* Connect dialog */}
      <ConnectDialog
        providerKey={providerKey}
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onRefetch={onRefetch}
      />
    </>
  );
}

// ── Connect Dialog ────────────────────────────────────────────────

function ConnectDialog({
  providerKey,
  open,
  onOpenChange,
  onRefetch,
}: {
  providerKey: SandboxProviderKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefetch: () => void;
}) {
  const info = PROVIDERS[providerKey];
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState<string | null>(null);

  const connectMutation = useAdminMutation<{
    connected: boolean;
    displayName: string | null;
    validatedAt: string;
  }>({
    path: `/api/v1/admin/sandbox/connect/${providerKey}`,
    method: "POST",
    invalidates: onRefetch,
  });

  function resetForm() {
    setFieldValues({});
    setValidationError(null);
    connectMutation.clearError();
  }

  async function handleSubmit() {
    setValidationError(null);

    // Client-side required field check
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

    const result = await connectMutation.mutate({
      body: { credentials },
    });

    if (result.ok) {
      resetForm();
      onOpenChange(false);
    } else {
      setValidationError(result.error);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {info.label}</DialogTitle>
          <DialogDescription>
            Enter your credentials. They will be validated against the provider
            API before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {info.fields.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={`connect-${field.key}`}>
                {field.label}
                {!field.required && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    (optional)
                  </span>
                )}
              </Label>
              <Input
                id={`connect-${field.key}`}
                type={field.type}
                placeholder={field.placeholder}
                value={fieldValues[field.key] ?? ""}
                onChange={(e) =>
                  setFieldValues((prev) => ({
                    ...prev,
                    [field.key]: e.target.value,
                  }))
                }
              />
            </div>
          ))}

          {(validationError ?? connectMutation.error) && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {validationError ?? connectMutation.error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={connectMutation.saving}>
            {connectMutation.saving && (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            )}
            Validate & Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Sandbox Config Card (self-hosted) ─────────────────────────────

function SandboxConfigCard({
  status,
  onSelectBackend,
  onSetSidecarUrl,
  onReset,
  saving,
}: {
  status: SandboxStatus;
  onSelectBackend: (backendId: string) => Promise<void>;
  onSetSidecarUrl: (url: string) => Promise<void>;
  onReset: () => Promise<void>;
  saving: boolean;
}) {
  const [selectedBackend, setSelectedBackend] = useState(
    status.workspaceOverride ?? "",
  );
  const [sidecarUrl, setSidecarUrl] = useState(
    status.workspaceSidecarUrl ?? "",
  );

  const availableBackends = status.availableBackends.filter((b) => b.available);
  const showSidecarUrl =
    selectedBackend === "sidecar" ||
    (!selectedBackend && status.activeBackend === "sidecar");
  const hasChanges =
    (selectedBackend && selectedBackend !== (status.workspaceOverride ?? "")) ||
    sidecarUrl !== (status.workspaceSidecarUrl ?? "");

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Sandbox Backend</CardTitle>
            <CardDescription>
              Choose how the explore and Python tools execute commands.
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">
            Active: {status.activeBackend}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Current status */}
        <div className="rounded-md border bg-muted/50 p-4">
          <div className="grid gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Platform default</span>
              <span className="font-medium">{status.platformDefault}</span>
            </div>
            {status.workspaceOverride && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Workspace override
                </span>
                <Badge variant="secondary" className="text-xs">
                  {status.workspaceOverride}
                </Badge>
              </div>
            )}
            {status.workspaceSidecarUrl && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Custom sidecar URL
                </span>
                <code className="text-xs">{status.workspaceSidecarUrl}</code>
              </div>
            )}
          </div>
        </div>

        {/* Backend selector */}
        <div className="space-y-2">
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
          <p className="text-xs text-muted-foreground">
            {availableBackends.length === 0
              ? "No sandbox backends are available in this deployment."
              : "Select which sandbox backend this workspace uses for the explore and Python tools."}
          </p>
        </div>

        {/* Sidecar URL (conditional) */}
        {showSidecarUrl && (
          <div className="space-y-2">
            <Label htmlFor="sidecar-url">Sidecar URL</Label>
            <Input
              id="sidecar-url"
              type="url"
              placeholder="https://sandbox.example.com"
              value={sidecarUrl}
              onChange={(e) => setSidecarUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Custom sidecar service URL for this workspace. Leave empty to use
              the platform default.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={async () => {
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
            disabled={saving || (!hasChanges && !status.workspaceOverride)}
            size="sm"
          >
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save"}
          </Button>
          {status.workspaceOverride && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await onReset();
                setSelectedBackend("");
                setSidecarUrl("");
              }}
              disabled={saving}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset to default
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
