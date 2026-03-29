"use client";

import { useState } from "react";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { cn } from "@/lib/utils";
import { Box, Cloud, Puzzle, RotateCcw, Save, Shield } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface SandboxBackend {
  id: string;
  name: string;
  type: "built-in" | "plugin";
  available: boolean;
  description?: string;
}

interface SandboxStatus {
  activeBackend: string;
  platformDefault: string;
  workspaceOverride: string | null;
  workspaceSidecarUrl: string | null;
  availableBackends: SandboxBackend[];
}

// ── Page ──────────────────────────────────────────────────────────

export default function SandboxPage() {
  const { deployMode } = useDeployMode();
  const isSaas = deployMode === "saas";

  const { data, loading, error, refetch } = useAdminFetch<SandboxStatus>(
    "/api/v1/admin/sandbox/status",
    { transform: (json) => json as SandboxStatus },
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

  const handlers = {
    onSelectBackend: async (backendId: string) => {
      await saveMutation.mutate({ body: { value: backendId } });
    },
    onSetSidecarUrl: async (url: string) => {
      await saveUrlMutation.mutate({ body: { value: url } });
    },
    onReset: async () => {
      await Promise.all([
        resetMutation.mutate({
          path: "/api/v1/admin/settings/ATLAS_SANDBOX_BACKEND",
        }),
        resetMutation.mutate({
          path: "/api/v1/admin/settings/ATLAS_SANDBOX_URL",
        }),
      ]);
    },
    saving:
      saveMutation.saving ||
      saveUrlMutation.saving ||
      resetMutation.saving,
  };

  return (
    <ErrorBoundary>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {isSaas ? "Execution Environment" : "Sandbox"}
          </h1>
          <p className="text-muted-foreground">
            {isSaas
              ? "Choose how your queries and explorations are executed."
              : "Configure the sandbox backend used for the explore and Python tools."}
          </p>
        </div>

        {mutationError && (
          <ErrorBanner message={mutationError} />
        )}

        <AdminContentWrapper
          loading={loading}
          error={error}
          isEmpty={!data}
          emptyIcon={Box}
          emptyTitle="Sandbox unavailable"
          emptyDescription="No sandbox status available."
        >
          {data && (
            isSaas ? (
              <SaasBackendSelector status={data} {...handlers} />
            ) : (
              <SandboxConfigCard status={data} {...handlers} />
            )
          )}
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
  );
}

// ── Backend display info ─────────────────────────────────────────

const BACKEND_DISPLAY: Record<
  string,
  { label: string; description: string; icon: typeof Cloud }
> = {
  __default__: {
    label: "Cloud Sandbox",
    description:
      "Standard cloud-hosted execution. Fast startup, shared infrastructure.",
    icon: Cloud,
  },
  "vercel-sandbox": {
    label: "Cloud Sandbox",
    description:
      "Standard cloud-hosted execution. Fast startup, shared infrastructure.",
    icon: Cloud,
  },
  nsjail: {
    label: "Isolated Container",
    description:
      "Dedicated container per query. Maximum isolation for sensitive data.",
    icon: Shield,
  },
  sidecar: {
    label: "Sidecar Service",
    description:
      "Dedicated sidecar service for execution. Managed by the platform.",
    icon: Box,
  },
  "just-bash": {
    label: "Direct Execution",
    description:
      "Runs commands directly on the host. Development use only.",
    icon: Box,
  },
};

function getBackendDisplay(backend: SandboxBackend) {
  const info = BACKEND_DISPLAY[backend.id];
  if (info) return info;
  if (backend.type === "plugin") {
    return {
      label: backend.name,
      description: backend.description ?? "Plugin-provided sandbox backend.",
      icon: Puzzle,
    };
  }
  return {
    label: backend.name,
    description: backend.description ?? "Sandbox backend.",
    icon: Box,
  };
}

// ── SaaS Backend Selector ────────────────────────────────────────

function SaasBackendSelector({
  status,
  onSelectBackend,
  onReset,
  saving,
}: {
  status: SandboxStatus;
  onSelectBackend: (backendId: string) => Promise<void>;
  onSetSidecarUrl: (url: string) => Promise<void>;
  onReset: () => Promise<void>;
  saving: boolean;
}) {
  const availableBackends = status.availableBackends.filter((b) => b.available);
  const [selected, setSelected] = useState(
    status.workspaceOverride ?? status.activeBackend,
  );
  const hasOverride = !!status.workspaceOverride;
  const hasChanges = selected !== (status.workspaceOverride ?? status.activeBackend);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution Environment</CardTitle>
        <CardDescription>
          Select how your workspace runs queries and explorations. The
          recommended option balances speed and security for most teams.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Backend cards */}
        <div className="grid gap-3 sm:grid-cols-2">
          {availableBackends.map((backend) => {
            const display = getBackendDisplay(backend);
            const Icon = display.icon;
            const isSelected = selected === backend.id;
            const isDefault = backend.id === status.platformDefault;
            return (
              <button
                key={backend.id}
                type="button"
                className={cn(
                  "flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent/50",
                  isSelected && "ring-2 ring-primary border-primary",
                )}
                onClick={() => setSelected(backend.id)}
              >
                <div className="flex w-full items-center gap-2">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium">{display.label}</span>
                  {backend.type === "plugin" && (
                    <Badge variant="outline" className="text-[10px]">
                      Plugin
                    </Badge>
                  )}
                  {isDefault && (
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      Recommended
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {display.description}
                </p>
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={async () => {
              if (selected === status.platformDefault && hasOverride) {
                await onReset();
              } else {
                await onSelectBackend(selected);
              }
            }}
            disabled={saving || !hasChanges}
            size="sm"
          >
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save"}
          </Button>
          {hasOverride && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await onReset();
                setSelected(status.platformDefault);
              }}
              disabled={saving}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Use recommended
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Sandbox Config Card (self-hosted) ────────────────────────────

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
  const showSidecarUrl = selectedBackend === "sidecar" || (!selectedBackend && status.activeBackend === "sidecar");
  const hasChanges =
    (selectedBackend && selectedBackend !== (status.workspaceOverride ?? "")) ||
    (sidecarUrl !== (status.workspaceSidecarUrl ?? ""));

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
                <span className="text-muted-foreground">Custom sidecar URL</span>
                <code className="text-xs">{status.workspaceSidecarUrl}</code>
              </div>
            )}
          </div>
        </div>

        {/* Backend selector */}
        <div className="space-y-2">
          <Label htmlFor="sandbox-backend">Backend</Label>
          <Select
            value={selectedBackend}
            onValueChange={setSelectedBackend}
          >
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
