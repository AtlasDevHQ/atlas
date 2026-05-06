"use client";

/**
 * Audit-log filter bar (#2067).
 *
 * Renders the `actorKind` discriminator dropdown + the MCP-only
 * `clientId` and `tool` follow-up fields. Lifted out of `audit/page.tsx`
 * so the discriminated-union UI is independently testable — the page
 * is too dense (600 LOC of stat cards, tabs, retention panel) to mount
 * end-to-end just to verify "Actor=MCP reveals two extra fields".
 *
 * Contract:
 *   - Pure controlled component. URL state lives in the parent's
 *     `useQueryStates(auditSearchParams)`; we never read or write
 *     `nuqs` directly so the filter bar can be reused under a
 *     different state container if the audit page ever splits.
 *   - The MCP follow-ups (`clientId`, `tool`) are revealed only when
 *     `actorKind === "mcp"`. Switching away clears both fields so the
 *     URL doesn't carry stale `?clientId=` after the user picks
 *     "Human" — that drift was the source of #2067's "filter says
 *     MCP-only but rows look like web traffic" confusion.
 *   - `clientOptions` may be empty (no DCR clients yet, or fetch
 *     failed). When empty we fall back to a free-text input so an
 *     admin can paste a known client_id manually rather than be
 *     blocked.
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
          // Switching away from MCP clears the follow-ups so a stale
          // `?clientId=claude-desktop` doesn't keep filtering when the
          // dropdown reads "Human". Mirrors the audit page's existing
          // clearFilters affordance — surgical, not a full reset.
          if (next !== "mcp" && (clientId || tool)) {
            onChange({ actorKind: next, clientId: "", tool: "" });
          } else {
            onChange({ actorKind: next });
          }
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
