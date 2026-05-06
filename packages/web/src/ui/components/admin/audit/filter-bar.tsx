"use client";

/**
 * Audit-log filter bar — actor discriminator + MCP-only follow-ups.
 *
 * Pure controlled component. URL state lives in the parent's
 * `useQueryStates(auditSearchParams)`; we never read or write `nuqs`
 * directly so the filter bar can be reused under a different state
 * container if the audit page ever splits.
 *
 * Switching `actorKind` away from `mcp` clears the follow-ups so a
 * stale `?clientId=` doesn't keep filtering after the dropdown shows
 * a non-MCP actor. `clientOptions` may be empty (no DCR clients yet,
 * or fetch failed) — the component falls back to a free-text input
 * so an admin pasting a known client_id is never blocked.
 */

import type { ReactElement } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Canonical actor-kind values surfaced in the dropdown. Only `"mcp"`
 * is currently populated by a writer (see `audit_log.actor_kind`);
 * the others are reserved for future writer paths (chat, scheduler)
 * to opt into without a UI change.
 */
export const ACTOR_KIND_OPTIONS = [
  { value: "human", label: "Human" },
  { value: "agent", label: "Agent" },
  { value: "mcp", label: "MCP" },
  { value: "scheduler", label: "Scheduler" },
] as const;

export type ActorKindFilter = (typeof ACTOR_KIND_OPTIONS)[number]["value"] | "";

export interface AuditFilterBarProps {
  /** Current actor-kind filter ("" = all). */
  actorKind: ActorKindFilter;
  /** OAuth client_id filter ("" = all). Only meaningful when actorKind === "mcp". */
  clientId: string;
  /** Tool-name filter ("" = all). Only meaningful when actorKind === "mcp". */
  tool: string;
  /**
   * Registered OAuth clients in the active workspace. Populates the
   * `clientId` dropdown. Empty array → free-text input fallback.
   */
  clientOptions: ReadonlyArray<{ clientId: string; clientName: string | null }>;
  /**
   * Single setter — the parent batches the URL update so switching
   * Actor away from MCP can clear the follow-ups in one history
   * entry (otherwise the back button would step through three
   * intermediate states).
   */
  onChange: (next: { actorKind?: ActorKindFilter; clientId?: string; tool?: string }) => void;
}

const ALL_SENTINEL = "__all__";

/**
 * Compute the next URL-state patch when the actor dropdown changes.
 * Pulled out as a pure function so the load-bearing "switch away from
 * MCP clears the follow-ups" branch is unit-testable without driving
 * Radix Select internals through jsdom.
 */
export function actorKindUpdate(
  next: ActorKindFilter,
  currentClientId: string,
  currentTool: string,
): { actorKind?: ActorKindFilter; clientId?: string; tool?: string } {
  if (next !== "mcp" && (currentClientId || currentTool)) {
    return { actorKind: next, clientId: "", tool: "" };
  }
  return { actorKind: next };
}

export function AuditFilterBar({
  actorKind,
  clientId,
  tool,
  clientOptions,
  onChange,
}: AuditFilterBarProps): ReactElement {
  return (
    <>
      <Select
        value={actorKind || ALL_SENTINEL}
        onValueChange={(v) => {
          const next = v === ALL_SENTINEL ? "" : (v as ActorKindFilter);
          onChange(actorKindUpdate(next, clientId, tool));
        }}
      >
        <SelectTrigger className="h-9 w-32" aria-label="Filter by actor">
          <SelectValue placeholder="All actors" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_SENTINEL}>All actors</SelectItem>
          {ACTOR_KIND_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {actorKind === "mcp" && (
        <>
          {clientOptions.length > 0 ? (
            <Select
              value={clientId || ALL_SENTINEL}
              onValueChange={(v) =>
                onChange({ clientId: v === ALL_SENTINEL ? "" : v })
              }
            >
              <SelectTrigger className="h-9 w-44" aria-label="Filter by OAuth client">
                <SelectValue placeholder="All clients" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SENTINEL}>All clients</SelectItem>
                {clientOptions.map((c) => (
                  <SelectItem key={c.clientId} value={c.clientId}>
                    {c.clientName ? `${c.clientName} (${c.clientId})` : c.clientId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder="Filter by OAuth client_id..."
              value={clientId}
              onChange={(e) => onChange({ clientId: e.target.value })}
              className="h-9 w-44"
              aria-label="Filter by OAuth client"
            />
          )}

          <Input
            placeholder="Filter by tool (e.g. runMetric)..."
            value={tool}
            onChange={(e) => onChange({ tool: e.target.value })}
            className="h-9 w-52"
            aria-label="Filter by MCP tool"
          />
        </>
      )}
    </>
  );
}
