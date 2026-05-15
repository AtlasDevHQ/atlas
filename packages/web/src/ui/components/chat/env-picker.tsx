"use client";

/**
 * Chat header env/member picker (#2345).
 *
 * Shows the conversation's active group and member (e.g. "prod /
 * us-int"). Clicking opens a dropdown of every member in every group
 * the user has access to. Selecting a different member is a *per-turn*
 * override — the conversation's stored `connection_id` is unchanged;
 * the picker holds the override in component state and `useAtlasChat`
 * forwards it on the next request via the transport body.
 *
 * Selecting a different group changes the *content scope*. Group
 * changes propagate to the conversation row on the next turn (the
 * server persists the new value when the body carries
 * `connectionGroupId`), so subsequent turns inherit the new scope
 * without the user having to re-pick.
 *
 * Renders nothing only in the truly trivial 1×1 case: one group with
 * one member. Multi-singleton workspaces (the 0062 1:1 backfill shape)
 * still surface the picker so the 1.4.4 feature is discoverable; a
 * dropdown footer hints that admins can merge connections into shared
 * environments. See #2408.
 */

import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export interface ChatEnvMember {
  readonly connectionId: string;
  readonly dbType: string;
  readonly description: string | null;
}

export interface ChatEnvGroup {
  readonly id: string;
  readonly name: string;
  readonly members: ReadonlyArray<ChatEnvMember>;
}

export interface ChatEnvPickerProps {
  /** Resolved groups from `/api/v1/me/connection-groups`. */
  readonly groups: ReadonlyArray<ChatEnvGroup>;
  /** Currently active group id. `null` ⇒ no group context yet. */
  readonly activeGroupId: string | null;
  /** Currently active member (execution target). `null` ⇒ inherit from group's first member. */
  readonly activeConnectionId: string | null;
  /**
   * Called when the user picks a new group + member pair from the
   * dropdown. The parent component decides whether this is a per-turn
   * override (just update local state) or a content-scope change
   * (also update the conversation row on the next request).
   */
  readonly onSelect: (next: { groupId: string; connectionId: string }) => void;
}

function stripGroupPrefix(name: string): string {
  // The 0062 1:1 backfill names groups `g_<connId>` for legacy
  // single-connection orgs. Strip the prefix so the chip reads
  // naturally ("prod" instead of "g_prod"); admins who set a custom
  // name see the raw value unchanged.
  return name.startsWith("g_") ? name.slice(2) : name;
}

export function ChatEnvPicker({
  groups,
  activeGroupId,
  activeConnectionId,
  onSelect,
}: ChatEnvPickerProps): React.ReactElement | null {
  // Hide only the truly trivial 1×1 case: one group with one member.
  // The 0062 1:1 backfill emits N singleton groups for N legacy
  // connections, so anything ≥ 2 groups (even all singletons) is a
  // legitimate environment fan-out we want to surface — otherwise the
  // 1.4.4 marquee feature stays invisible on the dev/demo setup. See
  // #2408.
  if (groups.length < 2 && (groups[0]?.members.length ?? 0) < 2) return null;

  const activeGroup =
    groups.find((g) => g.id === activeGroupId) ??
    groups.find((g) => g.members.some((m) => m.connectionId === activeConnectionId)) ??
    groups[0];
  const activeMember =
    activeGroup?.members.find((m) => m.connectionId === activeConnectionId) ??
    activeGroup?.members[0];

  const groupLabel = activeGroup ? stripGroupPrefix(activeGroup.name) : "—";
  const memberLabel = activeMember?.connectionId ?? "—";
  // Collapse "warehouse / warehouse" → "warehouse" when the stripped
  // group name and the member id are the same value (the common 0062
  // backfill shape: g_<connId> + one member named <connId>).
  const chipLabel = groupLabel === memberLabel ? memberLabel : `${groupLabel} / ${memberLabel}`;

  // When every group has at most one member (the 0062 backfill shape,
  // or a defensive-empty group), the dropdown has no actual
  // multi-member choice to offer. Surface a hint so admins discover
  // that merging connections into a shared environment is possible.
  const allSingletons = groups.every((g) => g.members.length <= 1);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-full border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
          data-testid="chat-env-picker-trigger"
          aria-label={`Active environment: ${groupLabel}, member: ${memberLabel}. Change.`}
        >
          <Layers className="size-3.5 text-zinc-500" aria-hidden />
          <span data-testid="chat-env-picker-label">{chipLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" data-testid="chat-env-picker-menu">
        {groups.map((group, idx) => (
          <ChatEnvGroupSection
            key={group.id}
            group={group}
            activeConnectionId={activeMember?.connectionId ?? null}
            onSelect={onSelect}
            isLast={idx === groups.length - 1}
          />
        ))}
        {allSingletons && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel
              className="px-2 py-1.5 text-[11px] font-normal leading-snug text-zinc-500 dark:text-zinc-400"
              data-testid="chat-env-picker-singleton-hint"
            >
              No multi-member environments configured. Add another connection in{" "}
              <span className="font-mono text-zinc-600 dark:text-zinc-300">
                /admin/connections
              </span>
              .
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatEnvGroupSection({
  group,
  activeConnectionId,
  onSelect,
  isLast,
}: {
  group: ChatEnvGroup;
  activeConnectionId: string | null;
  onSelect: ChatEnvPickerProps["onSelect"];
  isLast: boolean;
}): React.ReactElement {
  const label = stripGroupPrefix(group.name);
  return (
    <>
      <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
        {label}
      </DropdownMenuLabel>
      {group.members.length === 0 ? (
        <DropdownMenuItem
          disabled
          className="text-xs italic text-zinc-400"
          data-testid={`chat-env-picker-empty-${group.id}`}
        >
          No members
        </DropdownMenuItem>
      ) : (
        group.members.map((member) => {
          const active = member.connectionId === activeConnectionId;
          return (
            <DropdownMenuItem
              key={member.connectionId}
              onSelect={() =>
                onSelect({ groupId: group.id, connectionId: member.connectionId })
              }
              className="flex items-center justify-between gap-2 text-xs"
              data-testid={`chat-env-picker-member-${member.connectionId}`}
              data-active={active}
            >
              <span className="truncate">{member.connectionId}</span>
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                {member.dbType}
              </span>
            </DropdownMenuItem>
          );
        })
      )}
      {!isLast && <DropdownMenuSeparator />}
    </>
  );
}

// ── Data hook ────────────────────────────────────────────────────────

export interface UseChatEnvGroupsOptions {
  readonly apiUrl: string;
  readonly enabled: boolean;
  readonly getHeaders: () => Record<string, string>;
  readonly getCredentials: () => RequestCredentials;
}

export interface UseChatEnvGroupsResult {
  readonly groups: ReadonlyArray<ChatEnvGroup>;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Fetches the user's accessible connection groups + members from
 * `/api/v1/me/connection-groups`. Defensive: a network or 5xx failure
 * surfaces as an empty list so the chat still renders, just without the
 * picker. The picker only hides itself when there's a single
 * single-member group — see {@link ChatEnvPicker} for the predicate.
 */
export function useChatEnvGroups(
  opts: UseChatEnvGroupsOptions,
): UseChatEnvGroupsResult {
  const [groups, setGroups] = useState<ReadonlyArray<ChatEnvGroup>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opts.enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${opts.apiUrl}/api/v1/me/connection-groups`, {
      headers: opts.getHeaders(),
      credentials: opts.getCredentials(),
    })
      .then(async (res) => {
        if (!res.ok) {
          // 4xx/5xx — surface a hint but don't block the chat. Empty
          // list ⇒ picker hides itself.
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as { groups?: ChatEnvGroup[] };
        if (!cancelled) {
          setGroups(body.groups ?? []);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setGroups([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [opts.apiUrl, opts.enabled, opts.getHeaders, opts.getCredentials]);

  return { groups, loading, error };
}
