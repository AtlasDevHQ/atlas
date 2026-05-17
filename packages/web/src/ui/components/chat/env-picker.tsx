"use client";

/**
 * Chat header env/member picker (#2345, #2518).
 *
 * Three-state cross-environment routing picker (PRD #2515, slice 3
 * issue #2518):
 *
 *   - **Auto** (default for new conversations) — the agent's `scope`
 *     argument on `executeSQL` decides per turn. Routes to the active
 *     member by default and fans out only when the agent asks for it.
 *   - **Pin to <member>** — force single-env execution against the
 *     selected member; the agent's `scope` override is ignored.
 *   - **All envs** — force fanout across every member of the active
 *     group; the agent's `scope` override is ignored.
 *
 * The dropdown also lists every member of the active group below the
 * three modes so the user can flip the pinned member without unpinning.
 * Picking a member from that list implicitly switches the mode to
 * `pin` (you can't "select a member" in fanout — it's structurally
 * meaningless).
 *
 * 1×1 case (one group with one member): the picker stays hidden.
 * Multi-singleton workspaces (the 0062 1:1 backfill shape) still
 * surface the picker so the 1.4.4 feature is discoverable; a
 * dropdown footer hints that admins can merge connections into shared
 * environments. See #2408.
 *
 * Group changes propagate to the conversation row on the next turn
 * (the server persists the new value when the body carries
 * `connectionGroupId`), so subsequent turns inherit the new scope
 * without the user having to re-pick. Routing-mode changes flow the
 * same way via `routingMode`.
 */

import { useEffect, useState } from "react";
import { Layers, AlertCircle, Sparkles, Pin, Globe2, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { stripGroupPrefix } from "@/ui/lib/strip-group-prefix";
import type { MeConnectionGroupsEmptyReason } from "@/ui/lib/types";
import type { ConversationRoutingMode } from "@useatlas/types/conversation";

export type { ConversationRoutingMode };

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

/**
 * Payload for {@link ChatEnvPickerProps.onSelect}. The parent receives
 * the full triple every time so it can persist any subset onto the
 * conversation row without the picker having to know which fields the
 * server treats as content-scope vs. per-turn execution-target.
 */
export interface ChatEnvSelection {
  readonly groupId: string;
  readonly connectionId: string;
  readonly routingMode: ConversationRoutingMode;
}

export interface ChatEnvPickerProps {
  /** Resolved groups from `/api/v1/me/connection-groups`. */
  readonly groups: ReadonlyArray<ChatEnvGroup>;
  /**
   * When `groups` is empty, this explains why. `null` ⇒ empty list is a
   * normal "workspace has no group config yet" state (picker stays
   * hidden, chat falls back to single-connection routing). A populated
   * reason swaps the silent hide for an inline diagnostic chip. See
   * #2422.
   */
  readonly emptyReason?: MeConnectionGroupsEmptyReason | null;
  /**
   * Non-null when the `/api/v1/me/connection-groups` fetch failed
   * (4xx/5xx, CORS, network). Swaps the silent hide for an inline
   * "unavailable" chip — the silent hide is what #2504 was. The raw
   * message is not surfaced ("Failed to fetch" helps nobody).
   */
  readonly transportError?: string | null;
  /** Currently active group id. `null` ⇒ no group context yet. */
  readonly activeGroupId: string | null;
  /** Currently active member (execution target). `null` ⇒ inherit from group's first member. */
  readonly activeConnectionId: string | null;
  /**
   * #2518 — three-state cross-environment routing mode for the active
   * conversation. `null` (or omitted, for back-compat with pre-#2518
   * call sites) is treated as `"pin"` — pre-#2518 conversations carry
   * a single `connectionId` and the safest interpretation is "stay
   * pinned to that member".
   */
  readonly activeRoutingMode?: ConversationRoutingMode | null;
  /**
   * Called when the user picks a new group / member / mode triple from
   * the dropdown. The parent decides whether this is a per-turn
   * override (just update local state) or a persistent change (the
   * server stamps the new value onto the conversation row).
   */
  readonly onSelect: (next: ChatEnvSelection) => void;
}

/**
 * Single source of truth for the picker's visibility shape. Parent
 * layouts use it to collapse their own wrapper row (hairline border)
 * when the picker self-hides — exporting keeps the predicate from
 * drifting against a future #2408-style tweak.
 */
export interface ShouldRenderEnvPickerArgs {
  readonly groups: ReadonlyArray<{ readonly members: ReadonlyArray<unknown> }>;
  readonly reason: MeConnectionGroupsEmptyReason | null;
  readonly error?: string | null;
}

export function shouldRenderEnvPicker(args: ShouldRenderEnvPickerArgs): boolean {
  if (args.groups.length === 0) return args.reason !== null || args.error != null;
  if (args.groups.length > 1) return true;
  return (args.groups[0]?.members.length ?? 0) > 1;
}

const EMPTY_REASON_COPY: Record<MeConnectionGroupsEmptyReason, string> = {
  no_active_org: "No active workspace — select one in the top bar.",
  no_internal_db:
    "Multi-environment features require an internal database. Self-hosters: set DATABASE_URL.",
};

/**
 * Runtime narrow against the closed reason union. A server emitting an
 * unrecognized value (forward-compat scenario, or a bug) would
 * otherwise index into `EMPTY_REASON_COPY` and render `undefined` as
 * visible chip text. Treat unknowns as "no reason" so the picker
 * falls back to its hide-on-empty default.
 */
function isKnownEmptyReason(value: unknown): value is MeConnectionGroupsEmptyReason {
  return typeof value === "string" && value in EMPTY_REASON_COPY;
}

/**
 * Back-compat default — NULL on the conversation row means "pin", not
 * "auto". Pre-#2518 rows carry a non-null `connection_id` and the
 * safest interpretation is "stay pinned to that member". The default
 * lives behind a helper so chip-label / mode-state logic stays in
 * lockstep.
 */
function effectiveMode(
  mode: ConversationRoutingMode | null,
): ConversationRoutingMode {
  return mode ?? "pin";
}

export function ChatEnvPicker({
  groups,
  emptyReason = null,
  transportError = null,
  activeGroupId,
  activeConnectionId,
  activeRoutingMode = null,
  onSelect,
}: ChatEnvPickerProps): React.ReactElement | null {
  // Empty list + a reason ⇒ render a diagnostic chip instead of
  // silently hiding. Hiding here would conceal a real degraded state
  // (org switch in flight, self-host missing DATABASE_URL) and is
  // exactly the failure mode #2422 traced.
  if (groups.length === 0 && emptyReason) {
    return (
      <div
        className="flex h-8 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs font-medium text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
        role="status"
        data-testid="chat-env-picker-empty-reason"
        data-reason={emptyReason}
      >
        <AlertCircle className="size-3.5" aria-hidden />
        <span>{EMPTY_REASON_COPY[emptyReason]}</span>
      </div>
    );
  }

  // Transport failure with no cached groups — emptyReason takes
  // precedence above, so this is the "server unreachable" fallback.
  if (groups.length === 0 && transportError) {
    return (
      <div
        className="flex h-8 items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 text-xs font-medium text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200"
        role="status"
        data-testid="chat-env-picker-transport-error"
      >
        <AlertCircle className="size-3.5" aria-hidden />
        <span>Environments unavailable — connection error.</span>
      </div>
    );
  }

  if (!shouldRenderEnvPicker({ groups, reason: emptyReason, error: transportError })) {
    return null;
  }

  const activeGroup =
    groups.find((g) => g.id === activeGroupId) ??
    groups.find((g) => g.members.some((m) => m.connectionId === activeConnectionId)) ??
    groups[0];
  const activeMember =
    activeGroup?.members.find((m) => m.connectionId === activeConnectionId) ??
    activeGroup?.members[0];

  const mode = effectiveMode(activeRoutingMode);
  const groupLabel = activeGroup ? stripGroupPrefix(activeGroup.name) : "—";
  const memberLabel = activeMember?.connectionId ?? "—";

  // Chip label tracks the picker's mode so the trigger always reflects
  // the routing the next turn will use. The compact forms keep the
  // chip readable when group/member names are long.
  let chipLabel: string;
  let ChipIcon: typeof Layers;
  if (mode === "auto") {
    chipLabel = `Auto · ${groupLabel}`;
    ChipIcon = Sparkles;
  } else if (mode === "all") {
    chipLabel = `All · ${groupLabel}`;
    ChipIcon = Globe2;
  } else {
    // Pin — show the member name. Collapse "warehouse / warehouse" →
    // "warehouse" when the stripped group name and the member id match
    // (the common 0062 backfill shape: g_<connId> + one member named
    // <connId>).
    chipLabel = groupLabel === memberLabel ? memberLabel : `${groupLabel} / ${memberLabel}`;
    ChipIcon = Pin;
  }

  // When every group has at most one member (the 0062 backfill shape,
  // or a defensive-empty group), the dropdown has no actual
  // multi-member choice to offer. Surface a hint so admins discover
  // that merging connections into a shared environment is possible.
  const allSingletons = groups.every((g) => g.members.length <= 1);

  // The active group's member list is the source the Pin/Member rows
  // render from. We re-resolve here (vs. consuming `activeGroup` directly)
  // so a defensive-empty group renders an "empty" affordance rather than
  // a silent zero-length list.
  const activeMembers = activeGroup?.members ?? [];

  // Mode dispatch — every selection produces the full triple so the
  // parent can persist whichever subset matters. Implicit rules:
  //   - Switching mode keeps the current member as the execution
  //     target (pinned mode targets it; auto/all also need a sensible
  //     `currentMember` for the server-side routing lookup).
  //   - Selecting a member from the member list implies `pin` mode —
  //     you can't "select a member" in fanout, and the most natural
  //     interpretation is "pin to that one".
  const handleModeSelect = (nextMode: ConversationRoutingMode) => {
    if (!activeGroup || !activeMember) return;
    onSelect({
      groupId: activeGroup.id,
      connectionId: activeMember.connectionId,
      routingMode: nextMode,
    });
  };
  const handleMemberSelect = (groupId: string, connectionId: string) => {
    onSelect({ groupId, connectionId, routingMode: "pin" });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-full border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
          data-testid="chat-env-picker-trigger"
          data-mode={mode}
          aria-label={`Cross-environment routing: ${chipLabel}. Change.`}
        >
          <ChipIcon className="size-3.5 text-zinc-500" aria-hidden />
          <span data-testid="chat-env-picker-label">{chipLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        data-testid="chat-env-picker-menu"
      >
        {/* Mode section — three states with the current mode marked. */}
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
          Routing
        </DropdownMenuLabel>
        <ChatEnvModeItem
          mode="auto"
          active={mode === "auto"}
          icon={Sparkles}
          title="Auto"
          subtitle="Agent decides per turn"
          onSelect={() => handleModeSelect("auto")}
        />
        <ChatEnvModeItem
          mode="pin"
          active={mode === "pin"}
          icon={Pin}
          title={`Pin to ${memberLabel}`}
          subtitle="Lock execution to one member"
          onSelect={() => handleModeSelect("pin")}
        />
        <ChatEnvModeItem
          mode="all"
          active={mode === "all"}
          icon={Globe2}
          title="All envs"
          subtitle="Fan out to every member"
          onSelect={() => handleModeSelect("all")}
        />

        {activeGroup && activeMembers.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
              {stripGroupPrefix(activeGroup.name)} members
            </DropdownMenuLabel>
            {activeMembers.map((member) => {
              // Pin highlight only when the current mode is pin AND we're
              // on the member it pins to — otherwise highlighting the
              // member would falsely suggest "this is the active target"
              // while routing is in Auto/All.
              const isActive =
                mode === "pin" && member.connectionId === activeMember?.connectionId;
              return (
                <DropdownMenuItem
                  key={member.connectionId}
                  onSelect={() =>
                    handleMemberSelect(activeGroup.id, member.connectionId)
                  }
                  className="flex items-center justify-between gap-2 text-xs"
                  data-testid={`chat-env-picker-member-${member.connectionId}`}
                  data-active={isActive}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {isActive && <Check className="size-3 text-primary" aria-hidden />}
                    <span className="truncate">{member.connectionId}</span>
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                    {member.dbType}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {groups.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
              Other environments
            </DropdownMenuLabel>
            {groups
              .filter((g) => g.id !== activeGroup?.id)
              .map((group) => (
                <ChatEnvOtherGroupItem
                  key={group.id}
                  group={group}
                  onSelect={(connectionId) =>
                    handleMemberSelect(group.id, connectionId)
                  }
                />
              ))}
          </>
        )}

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

function ChatEnvModeItem({
  mode,
  active,
  icon: Icon,
  title,
  subtitle,
  onSelect,
}: {
  mode: ConversationRoutingMode;
  active: boolean;
  icon: typeof Layers;
  title: string;
  subtitle: string;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className="flex items-start gap-2 text-xs"
      data-testid={`chat-env-picker-mode-${mode}`}
      data-active={active}
    >
      <Icon
        className={`mt-0.5 size-3.5 ${active ? "text-primary" : "text-zinc-500"}`}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate ${active ? "font-medium" : ""}`}>{title}</span>
        <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
          {subtitle}
        </span>
      </div>
      {active && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />}
    </DropdownMenuItem>
  );
}

/**
 * Row for a member of a *different* group. Selecting it switches both
 * the active group and pins to that member — the natural "I want to
 * work in a different environment" gesture.
 */
function ChatEnvOtherGroupItem({
  group,
  onSelect,
}: {
  group: ChatEnvGroup;
  onSelect: (connectionId: string) => void;
}): React.ReactElement {
  const label = stripGroupPrefix(group.name);
  return (
    <>
      {group.members.length === 0 ? (
        <DropdownMenuItem
          disabled
          className="text-xs italic text-zinc-400"
          data-testid={`chat-env-picker-empty-${group.id}`}
        >
          {label} — no members
        </DropdownMenuItem>
      ) : (
        group.members.map((member) => (
          <DropdownMenuItem
            key={`${group.id}:${member.connectionId}`}
            onSelect={() => onSelect(member.connectionId)}
            className="flex items-center justify-between gap-2 text-xs"
            data-testid={`chat-env-picker-other-${group.id}-${member.connectionId}`}
          >
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              <span className="truncate text-zinc-500">{label}</span>
              <span className="text-zinc-300">/</span>
              <span className="truncate">{member.connectionId}</span>
            </span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-400">
              {member.dbType}
            </span>
          </DropdownMenuItem>
        ))
      )}
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
  readonly reason: MeConnectionGroupsEmptyReason | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Fetches the user's accessible connection groups + members from
 * `/api/v1/me/connection-groups`. Defensive: a network or 5xx failure
 * surfaces as an empty list so the chat still renders, just without the
 * picker. `reason` mirrors the wire field so a known degraded state can
 * render an explanatory chip instead of a silent hide — see #2422.
 */
export function useChatEnvGroups(
  opts: UseChatEnvGroupsOptions,
): UseChatEnvGroupsResult {
  const [groups, setGroups] = useState<ReadonlyArray<ChatEnvGroup>>([]);
  const [reason, setReason] = useState<MeConnectionGroupsEmptyReason | null>(null);
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
        const body = (await res.json()) as {
          groups?: ChatEnvGroup[];
          reason?: unknown;
        };
        if (!cancelled) {
          setGroups(body.groups ?? []);
          // Narrow unknown / unrecognized reason values to `null` —
          // never index into `EMPTY_REASON_COPY` with a value the
          // frontend hasn't been built to render.
          setReason(isKnownEmptyReason(body.reason) ? body.reason : null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          // Surface to the console so a persistent 5xx or CORS
          // regression leaves a breadcrumb. CLAUDE.md: every catch
          // must log or rethrow — silent swallowing is what #2422
          // existed to fix.
          console.warn("[atlas-chat] failed to load connection groups", msg);
          setError(msg);
          setGroups([]);
          // Don't synthesize a `reason` on transport failure — the
          // server is the only source of truth for "empty because of
          // X". A flaky network reading as "no_internal_db" would be
          // misleading.
          setReason(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [opts.apiUrl, opts.enabled, opts.getHeaders, opts.getCredentials]);

  return { groups, reason, loading, error };
}
