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
 * Empty groups list ⇒ render nothing. The legacy single-connection
 * flow doesn't need a picker, and a misconfigured workspace (no groups
 * yet) shouldn't surface an empty dropdown.
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
  // Defensive strip for any admin-set name that begins with `g_`.
  // Migration 0062 backfills `connection_groups.id` as `g_<connId>` but
  // stores `name = <connId>` (unprefixed), so this is a no-op on default
  // backfilled rows; it only fires when an admin renames a group to
  // something starting with `g_`.
  return name.startsWith("g_") ? name.slice(2) : name;
}

export function ChatEnvPicker({
  groups,
  activeGroupId,
  activeConnectionId,
  onSelect,
}: ChatEnvPickerProps): React.ReactElement | null {
  // Hide the picker when there's nothing meaningful to pick — fewer
  // than two members total means no override is possible.
  const totalMembers = groups.reduce((acc, g) => acc + g.members.length, 0);
  if (totalMembers < 2) return null;

  const activeGroup =
    groups.find((g) => g.id === activeGroupId) ??
    groups.find((g) => g.members.some((m) => m.connectionId === activeConnectionId)) ??
    groups[0];
  const activeMember =
    activeGroup?.members.find((m) => m.connectionId === activeConnectionId) ??
    activeGroup?.members[0];

  const groupLabel = activeGroup ? stripGroupPrefix(activeGroup.name) : "—";
  const memberLabel = activeMember?.connectionId ?? "—";

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
          <span data-testid="chat-env-picker-label">
            {groupLabel} / {memberLabel}
          </span>
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
 * picker. The picker treats fewer than two members as "no override
 * possible" and hides itself.
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
