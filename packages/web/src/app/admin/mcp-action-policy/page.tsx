"use client";

import { z } from "zod";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { ShieldHalf } from "lucide-react";

// ── Schema ────────────────────────────────────────────────────────
// Mirrors the `McpActionPolicyResponse` wire shape from @useatlas/types.
// `category` stays `z.string()` (not the literal union) so the dashboard is
// resilient if the API adds a category before the web bundle ships — the
// admin-schemas convention. Every category (with its label/description) comes
// from the server, so the UI never hardcodes the category set.

const PolicyEntrySchema = z.object({
  category: z.string(),
  label: z.string(),
  description: z.string(),
  status: z.enum(["allowed", "blocked"]),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const PolicyResponseSchema = z.object({
  entries: z.array(PolicyEntrySchema),
});

export default function McpActionPolicyPage() {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/mcp/action-policy",
    { schema: PolicyResponseSchema },
  );

  const { mutate, saving, error: mutationError, errorFor, clearError } =
    useAdminMutation({
      path: "/api/v1/admin/mcp/action-policy",
      method: "PUT",
      invalidates: refetch,
    });

  async function toggle(category: string, allowed: boolean) {
    await mutate({
      itemId: category,
      body: { category, status: allowed ? "allowed" : "blocked" },
    });
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">MCP Action Policy</h1>
        <p className="text-sm text-muted-foreground">
          Allow or block whole categories of MCP actions for this workspace. A blocked
          category short-circuits every matching MCP tool call before any other check —
          regardless of who asks. MCP can only ever <em>tighten</em> governance, never
          loosen it, so this control never weakens your existing guardrails.
        </p>
      </div>

      <ErrorBoundary>
        <MutationErrorSurface
          error={mutationError}
          feature="MCP Action Policy"
          onRetry={clearError}
        />

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="MCP Action Policy"
          onRetry={refetch}
          loadingMessage="Loading MCP action policy..."
          emptyIcon={ShieldHalf}
          emptyTitle="No MCP action categories"
          emptyDescription="No MCP action categories are available for this workspace."
          isEmpty={!data || data.entries.length === 0}
        >
          {data && (
            <div className="space-y-3 max-w-2xl">
              {data.entries.map((entry) => {
                const allowed = entry.status === "allowed";
                const itemError = errorFor(entry.category);
                return (
                  <Card key={entry.category}>
                    <CardContent className="flex items-start justify-between gap-4 py-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Label
                            htmlFor={`mcp-policy-${entry.category}`}
                            className="text-sm font-medium"
                          >
                            {entry.label}
                          </Label>
                          <Badge
                            variant="outline"
                            className={
                              allowed
                                ? "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400"
                                : "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400"
                            }
                          >
                            {allowed ? "Allowed" : "Blocked"}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{entry.description}</p>
                        {itemError && (
                          <p className="text-xs text-red-600 dark:text-red-400">
                            {itemError.message}
                          </p>
                        )}
                      </div>
                      <Switch
                        id={`mcp-policy-${entry.category}`}
                        checked={allowed}
                        disabled={saving}
                        onCheckedChange={(checked) => toggle(entry.category, checked)}
                        aria-label={`${allowed ? "Block" : "Allow"} ${entry.label} via MCP`}
                      />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}
