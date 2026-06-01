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
import { Layers, AlertCircle, Sparkles, Pin, Globe2, Check, Network, Crosshair, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { stripGroupPrefix } from "@/ui/lib/strip-group-prefix";
import type {
  ChatRestDatasourceScope,
  MeConnectionGroupsEmptyReason,
} from "@/ui/lib/types";
import type { ConversationRoutingMode } from "@useatlas/types/conversation";
import type { ChatRoutingPreference } from "@/lib/stores/chat-routing-preference-store";

export type { ChatRestDatasourceScope };

export type { ConversationRoutingMode };

export interface ChatEnvMember {
  readonly connectionId: string;
  readonly dbType: string;
  readonly description: string | null;
}

export interface ChatEnvGroup {
  readonly id: string;
  readonly name: string;
  // Operator-designated default; picker falls back to members[0] when
  // null or the named member is absent from `members`.
  readonly primaryConnectionId: string | null;
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
   * #3044 — the workspace's REST datasources + their env scope. Rendered in the
   * dropdown so the user can see (and, #3066, toggle) what the conversation
   * reaches. Workspace-global datasources answer regardless of the SQL pin.
   * Optional / defaults to empty for back-compat with callers that don't pass it.
   */
  readonly restDatasources?: ReadonlyArray<ChatRestDatasourceScope>;
  /**
   * #3066 — the conversation's REST datasource exclude-set (excluded
   * `install_id`s). A datasource in this set is unchecked in the picker and
   * the agent will not query it. Defaults to empty (all in scope).
   */
  readonly restExcludedDatasourceIds?: ReadonlyArray<string>;
  /**
   * #3066 — called when the user checks / unchecks a REST datasource. Receives
   * the FULL next exclude-set (not a delta) so the parent persists it verbatim
   * — sending `[]` when everything is re-included is meaningful (it clears the
   * row), so the parent must forward it as-is. Optional for callers that don't
   * surface REST scope.
   */
  readonly onRestExcludedChange?: (next: string[]) => void;
  /**
   * #3067 — the conversation's REST-only focus (`install_id`, or null = not
   * focused). When set, the chip reads "<name> only", SQL is suspended for the
   * turn, and the exclude toggles are inert (focus overrides them). Defaults to
   * null for callers that don't surface REST-only focus.
   */
  readonly restFocusDatasourceId?: string | null;
  /**
   * #3067 — called when the user focuses a datasource (`install_id`) or clears
   * focus (`null`). Like {@link onRestExcludedChange}, the parent forwards it
   * verbatim — `null` is meaningful (it clears focus on the row). Optional for
   * callers that don't surface REST-only focus.
   */
  readonly onRestFocusChange?: (next: string | null) => void;
  /**
   * Called when the user picks a new group / member / mode triple from
   * the dropdown. The parent decides whether this is a per-turn
   * override (just update local state) or a persistent change (the
   * server stamps the new value onto the conversation row).
   */
  readonly onSelect: (next: ChatEnvSelection) => void;
}

/**
 * #3066 — order-independent equality for two string sets (excluded
 * `install_id`s). Mirrors the API route's `sameStringSet` so the picker's
 * "did the exclude-set actually change" checks agree with the server's.
 */
export function sameExcludeSet(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  // Compare as SETS, not lists — dedupe each side first. Comparing raw lengths
  // would false-positive `["a","a"]` (1 distinct) against `["a","b"]` (2
  // distinct). Mirrors the API route's `sameStringSet` exactly.
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
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
  /**
   * #3066 — REST datasources the conversation can exclude. Their presence makes
   * the picker worth showing even when SQL routing is trivial (one group / one
   * member), so the exclude toggles stay reachable — otherwise the exclude-set
   * feature is dead for the common one-Postgres + one-REST-datasource
   * workspace. #3078 — also surfaces the picker for a zero-group, REST-only
   * workspace via the SQL-less render path, so its REST datasources are
   * excludable / focusable with no SQL group/member chip.
   */
  readonly restDatasources?: ReadonlyArray<unknown>;
}

export function shouldRenderEnvPicker(args: ShouldRenderEnvPickerArgs): boolean {
  if (args.groups.length === 0) {
    // #3078 — a zero-group (REST-only) workspace still has REST datasources to
    // exclude / focus, so render the SQL-less scope section. Otherwise show
    // only for a diagnostic reason / transport error (#2422 / #2504).
    if ((args.restDatasources?.length ?? 0) > 0) return true;
    return args.reason !== null || args.error != null;
  }
  if (args.groups.length > 1) return true;
  if ((args.groups[0]?.members.length ?? 0) > 1) return true;
  // #3066 — single group + single member, but there are REST datasources to
  // toggle: show the picker so the exclude-set is reachable.
  return (args.restDatasources?.length ?? 0) > 0;
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
 * What `atlas-chat` should auto-select when no conversation-level
 * selection exists. Returns null to mean "leave the current selection
 * alone" so the same call site handles both "nothing to do" and "the
 * user has already picked" without branching.
 */
export interface EnvSeed {
  readonly groupId: string;
  readonly connectionId: string;
}

export function pickDefaultEnvSeed(
  groups: ReadonlyArray<ChatEnvGroup>,
  currentSelection: string | null,
): EnvSeed | null {
  if (currentSelection !== null) return null;
  const group = groups[0];
  if (!group) return null;
  const member =
    group.members.find((m) => m.connectionId === group.primaryConnectionId) ??
    group.members[0];
  if (!member) return null;
  return { groupId: group.id, connectionId: member.connectionId };
}

/**
 * How the picker's current selection came to be (#3064). Only `explicit`
 * short-circuits the resolver; `unset` and `default` both re-evaluate the
 * stored preference on every run (so a matching preference can still restore
 * over them). The one thing `default` adds over `unset` is suppressing a
 * second default seed once one has been applied.
 *
 *   - `unset` — nothing selected yet (fresh chat before any seed).
 *   - `default` — the effect applied the group-primary fallback. With no
 *     matching preference it stays; a workspace-matching preference still
 *     restores over it (it never short-circuits the way `explicit` does).
 *   - `explicit` — the user picked it (or a conversation restored it).
 *     Authoritative; never auto-replaced.
 */
export type EnvSelectionProvenance = "unset" | "default" | "explicit";

/**
 * A workspace-scoped sticky env-picker preference. Aliased to the store's
 * own type so the two can't drift (the store has no back-reference to this
 * module, so the import is cycle-free).
 */
export type EnvSelectionPreference = ChatRoutingPreference;

export interface ResolveEnvSelectionInput {
  /** Resolved groups from `/api/v1/me/connection-groups`. */
  readonly groups: ReadonlyArray<ChatEnvGroup>;
  /** The picker's current selection. */
  readonly current: {
    readonly groupId: string | null;
    readonly connectionId: string | null;
    readonly routingMode: ConversationRoutingMode | null;
    /** #3066 — current REST exclude-set, so a pref-only exclude change still restores. */
    readonly restExcludedDatasourceIds: ReadonlyArray<string>;
    /** #3067 — current REST-only focus, so a pref-only focus change still restores. */
    readonly restFocusDatasourceId: string | null;
  };
  /** How {@link current}'s SQL scope (group / member / mode) was set. */
  readonly provenance: EnvSelectionProvenance;
  /**
   * #3078 — how {@link current}'s REST scope (exclude-set + focus) was set,
   * independent of the SQL {@link provenance}. When `"explicit"` the REST scope
   * is authoritative — a conversation-open restore made the row's exclude-set /
   * focus the source of truth, or the user toggled it — so the resolver passes
   * the *current* REST values through instead of clobbering them with the
   * default-seed empty set / the sticky preference, even while the SQL scope is
   * seeded or restored. `"unset"` / `"default"` mean "REST follows the SQL
   * seed/restore" (pre-#3078 behaviour). Required (like {@link provenance}): a
   * silent default in a precedence resolver is how the clobber bug returns.
   */
  readonly restProvenance: EnvSelectionProvenance;
  /** The persisted sticky preference for this browser. */
  readonly preference: EnvSelectionPreference;
  /** Active workspace id (`null` = self-hosted / no active org). */
  readonly activeWorkspaceId: string | null;
  /** The persist store has finished rehydrating `localStorage`. */
  readonly preferenceHydrated: boolean;
  /** The auth session has resolved, so {@link activeWorkspaceId} is final. */
  readonly sessionResolved: boolean;
  /**
   * #3078 — a `/me/connection-groups` fetch has settled at least once, so an
   * empty `groups` is a genuine zero-group (REST-only) workspace rather than a
   * not-yet-loaded cold start. Gates the REST-only seed/restore path: with no
   * SQL groups there's nothing to seed for SQL, but the sticky REST preference
   * should still seed a fresh chat (per ADR-0011). Until the fetch settles, the
   * resolver waits rather than seeding against a transiently-empty list.
   */
  readonly groupsLoaded: boolean;
}

/**
 * What the seed/restore effect should do — `wait` (data not ready),
 * `noop` (leave the selection alone), `restore` (apply the sticky
 * preference), or `seed` (apply the group-primary default).
 */
export type EnvSelectionDecision =
  | { readonly kind: "wait" }
  | { readonly kind: "noop" }
  | {
      readonly kind: "restore";
      /**
       * The restored SQL scope. Non-null for a normal (with-groups) restore.
       * #3078 — `null` for a zero-group (REST-only) workspace restore, where
       * there is no SQL group/member and only the REST scope is seeded.
       */
      readonly groupId: string | null;
      readonly connectionId: string | null;
      readonly routingMode: ConversationRoutingMode | null;
      /** #3066 — the sticky preference's exclude-set to seed onto this fresh chat. */
      readonly restExcludedDatasourceIds: string[];
      /** #3067 — the sticky preference's REST-only focus to seed onto this fresh chat. */
      readonly restFocusDatasourceId: string | null;
    }
  | {
      readonly kind: "seed";
      readonly groupId: string;
      readonly connectionId: string;
      /** #3066 — a default seed excludes nothing (every in-scope datasource queryable). */
      readonly restExcludedDatasourceIds: string[];
      /** #3067 — a default seed is not focused (SQL active). */
      readonly restFocusDatasourceId: string | null;
    };

/**
 * Pure decision behind atlas-chat's fresh-chat seed/restore effect
 * (#3064). Centralizes the precedence that the inline effect used to get
 * wrong on reload:
 *
 *   1. **Gate.** Do nothing until groups have loaded, the preference store
 *      has rehydrated, and the session has resolved. Committing a default
 *      seed inside that window — then locking it in against the
 *      later-arriving preference — was the reset-on-reload bug.
 *   2. **Explicit wins.** A user pick / conversation-restored value is
 *      never auto-replaced.
 *   3. **Preference > default.** Restore a sticky preference that belongs
 *      to the active workspace and still resolves to a live group+member;
 *      a preference from another workspace is ignored (ids can collide).
 *      Because this step runs before the seed step on every invocation, a
 *      previously default-seeded selection is restored over as soon as a
 *      matching preference arrives; an unmatched preference falls back to
 *      the group-primary default seed.
 *
 * #3078 — **zero-group (REST-only) workspace.** When `groups` is *loaded-empty*
 * (`groupsLoaded` true) there is no SQL to seed, but the sticky REST preference
 * still seeds a fresh chat: the resolver restores the workspace-matching
 * preference's exclude-set / focus with a null SQL scope. Until the fetch
 * settles it waits (so it never seeds against a transiently-empty list), and an
 * explicit SQL/REST scope is left untouched.
 */
export function resolveEnvSelection(
  input: ResolveEnvSelectionInput,
): EnvSelectionDecision {
  const {
    groups,
    current,
    provenance,
    restProvenance,
    preference,
    activeWorkspaceId,
    preferenceHydrated,
    sessionResolved,
    groupsLoaded,
  } = input;

  // #3078 — when the REST scope is authoritative (conversation-open restore, or
  // a user toggle), pass the CURRENT exclude-set / focus through any
  // seed/restore decision below instead of overwriting it. This keeps the SQL
  // scope free to seed/restore while the REST scope stays put — the seam that
  // fixes the all-null-SQL exclude-set data loss.
  const restExplicit = restProvenance === "explicit";

  // 1. Gate — wait until the inputs we need to choose correctly are ready.
  // (Group readiness is handled per-branch below: a *loaded-empty* group list is
  // a real zero-group workspace, not a cold start, so it must not block forever.)
  if (!preferenceHydrated) return { kind: "wait" };
  if (!sessionResolved) return { kind: "wait" };

  // #3078 — zero-group (REST-only) workspace. There's no SQL to seed/restore, but
  // the sticky REST preference should still seed a fresh chat (ADR-0011). Wait
  // until a fetch has settled so we don't seed against a transiently-empty list;
  // then run a REST-only restore (SQL stays null).
  if (groups.length === 0) {
    if (!groupsLoaded) return { kind: "wait" };
    // An explicit selection (user pick / conversation restore) is authoritative,
    // and an explicit REST scope must not be clobbered — leave both alone.
    if (provenance === "explicit" || restExplicit) return { kind: "noop" };
    // Restore the workspace-matching preference's REST scope; another workspace's
    // preference is ignored (ids can collide). SQL scope stays null (no groups).
    const prefMatchesWorkspace = preference.workspaceId === activeWorkspaceId;
    const nextRestExcluded = prefMatchesWorkspace
      ? [...(preference.restExcludedDatasourceIds ?? [])]
      : [];
    const nextRestFocus = prefMatchesWorkspace
      ? preference.restFocusDatasourceId ?? null
      : null;
    // Already on the target REST scope — don't churn (and don't loop).
    if (
      sameExcludeSet(current.restExcludedDatasourceIds ?? [], nextRestExcluded) &&
      (current.restFocusDatasourceId ?? null) === nextRestFocus
    ) {
      return { kind: "noop" };
    }
    return {
      kind: "restore",
      groupId: null,
      connectionId: null,
      routingMode: null,
      restExcludedDatasourceIds: nextRestExcluded,
      restFocusDatasourceId: nextRestFocus,
    };
  }

  // 2. An explicit pick (or conversation-restored value) is authoritative.
  // (When SQL is explicit the REST scope is already settled too, so there is no
  // divergent REST action to take here — the early noop is safe.)
  if (provenance === "explicit") return { kind: "noop" };

  // 3. Restore a workspace-matching, still-resolvable preference.
  const prefMatchesWorkspace = preference.workspaceId === activeWorkspaceId;
  const prefGroup =
    prefMatchesWorkspace && preference.groupId
      ? groups.find((g) => g.id === preference.groupId)
      : undefined;
  const prefMember = prefGroup?.members.find(
    (m) => m.connectionId === preference.connectionId,
  );
  if (prefGroup && prefMember) {
    // The REST scope this restore would apply: the preference's, UNLESS the REST
    // scope is explicit (#3078) — then the current exclude-set / focus is
    // authoritative and passes through untouched. Computed once so the no-churn
    // guard and the returned decision agree (a mismatch would loop forever).
    const nextRestExcluded = restExplicit
      ? [...(current.restExcludedDatasourceIds ?? [])]
      : [...(preference.restExcludedDatasourceIds ?? [])];
    const nextRestFocus = restExplicit
      ? current.restFocusDatasourceId ?? null
      : preference.restFocusDatasourceId ?? null;

    // Already on the preferred selection — don't churn React state. The
    // routing mode AND the REST scope (#3066/#3067) are part of the selection,
    // so a mode-only or REST-only difference (e.g. a default seed landed on the
    // preferred member but with no mode / empty exclude-set) must still restore.
    if (
      current.groupId === prefGroup.id &&
      current.connectionId === prefMember.connectionId &&
      current.routingMode === preference.routingMode &&
      sameExcludeSet(current.restExcludedDatasourceIds ?? [], nextRestExcluded) &&
      (current.restFocusDatasourceId ?? null) === nextRestFocus
    ) {
      return { kind: "noop" };
    }
    return {
      kind: "restore",
      groupId: prefGroup.id,
      connectionId: prefMember.connectionId,
      routingMode: preference.routingMode,
      restExcludedDatasourceIds: nextRestExcluded,
      restFocusDatasourceId: nextRestFocus,
    };
  }

  // No restorable preference. Seed the group-primary default only on a fresh
  // chat (provenance "unset"); once a default has been seeded — or anything
  // is already selected — leave it in place rather than re-seeding.
  if (provenance === "default" || current.connectionId !== null) {
    return { kind: "noop" };
  }
  const seed = pickDefaultEnvSeed(groups, current.connectionId);
  if (!seed) return { kind: "noop" };
  // A default seed carries no exclusions — every in-scope REST datasource stays
  // queryable until the user opts one out — and is not focused (SQL active).
  // #3078 — UNLESS the REST scope is explicit (e.g. an all-null-SQL conversation
  // whose exclude-set / focus was just restored): pass it through so seeding the
  // SQL default doesn't wipe it.
  return {
    kind: "seed",
    groupId: seed.groupId,
    connectionId: seed.connectionId,
    restExcludedDatasourceIds: restExplicit
      ? [...(current.restExcludedDatasourceIds ?? [])]
      : [],
    restFocusDatasourceId: restExplicit ? current.restFocusDatasourceId ?? null : null,
  };
}

/**
 * The persisted scope columns on a conversation row — structurally a subset
 * of `ConversationWithMessages`. Declared locally so this module needn't import
 * the `Conversation` / `ConversationWithMessages` row-shape types (it already
 * depends only on the `ConversationRoutingMode` alias); the picker is otherwise
 * scope-shape agnostic.
 */
export interface ConversationScopeSource {
  readonly connectionGroupId: string | null;
  readonly connectionId: string | null;
  readonly routingMode?: ConversationRoutingMode | null;
  /** #3066 — the row's REST exclude-set (excluded `install_id`s). Absent ⇒ none. */
  readonly restExcludedDatasourceIds?: ReadonlyArray<string> | null;
  /** #3067 — the row's REST-only focus (`install_id`, or null = not focused). */
  readonly restFocusDatasourceId?: string | null;
}

/**
 * #3078 — the REST half of a conversation's restored scope (exclude-set +
 * focus). Carried on EVERY {@link ConversationScopeDecision} regardless of the
 * SQL decision, because REST scope is independent of SQL routing. Shared by
 * {@link RestoredConversationScope} (the `restore` arm) and the `seed` arm so the
 * two arms' REST fields can't drift — the union's consumers read them without
 * narrowing on `kind`.
 */
export interface RestoredRestScope {
  /**
   * #3066 — the conversation's REST exclude-set (excluded `install_id`s). The SQL
   * scope (group/member) can fall back to a `seed` decision while the exclude-set
   * is still carried faithfully; an absent / null column coalesces to `[]`.
   */
  readonly restExcludedDatasourceIds: string[];
  /**
   * #3067 — the conversation's REST-only focus (`install_id`, or null = not
   * focused). Carried the same way as the exclude-set.
   */
  readonly restFocusDatasourceId: string | null;
}

/** The picker selection restored from a conversation row — SQL scope + REST scope. */
export interface RestoredConversationScope extends RestoredRestScope {
  readonly groupId: string | null;
  readonly connectionId: string | null;
  readonly routingMode: ConversationRoutingMode | null;
}

/**
 * What {@link resolveConversationScope} decides for an opened conversation's
 * **SQL scope**: `restore` (apply the group/member/mode and make it
 * authoritative) or `seed` (the row carried no usable SQL scope — defer to the
 * fresh-chat seed/restore effect).
 *
 * #3078 — the **REST scope** (exclude-set + focus, {@link RestoredRestScope}) is
 * carried on BOTH decisions: it is independent of SQL routing, so the row's REST
 * scope is restored even when the SQL scope must be seeded (an all-null /
 * archived-group row). The caller applies the REST fields regardless of `kind`
 * and marks the REST scope authoritative, so the seed/restore effect can't
 * clobber it.
 */
export type ConversationScopeDecision =
  | ({ readonly kind: "restore" } & RestoredConversationScope)
  | ({ readonly kind: "seed" } & RestoredRestScope);

/**
 * S1b (#3065) — decide how to populate the picker when a saved conversation is
 * opened. The conversation row is authoritative (precedence: row > sticky
 * preference > default seed), but ONLY when it carries an SQL scope that still
 * resolves against the visible environments. A `restore` decision applies the
 * SQL scope and is marked `explicit` by the caller so the seed/restore effect
 * can't overwrite it; a `seed` decision means the caller resets the SQL scope to
 * `unset` and lets that effect seed the default (or restore the sticky
 * preference) instead.
 *
 * #3078 — the REST scope (exclude-set + focus) is **independent of SQL routing**
 * and is therefore carried on BOTH decisions. The caller restores it and marks
 * its own provenance `explicit` regardless of the SQL `kind`, so a row's
 * exclude-set survives even when its SQL scope is all-null (defers to `seed`).
 * Before #3078 the `seed` decision dropped the exclude-set and the caller
 * cleared it; the always-sent transport array then wiped the persisted
 * exclusions on the next turn (the data-loss bug this fixes).
 *
 * Validation against `groups` prevents two ways a verbatim restore would lie to
 * the agent (both Codex-flagged):
 *   - an all-null legacy/API-created row → `explicit` nulls show a fallback chip
 *     while the transport sends nothing → query runs against server-default
 *     routing, unrepairable because `explicit` forces the effect to no-op;
 *   - a row pointing at an archived/removed group → sent verbatim and rejected
 *     by the chat route (`invalid_connection_group`).
 * Both fall back to `seed`. An archived *member* under a still-valid group is
 * repaired to the group primary rather than discarding the still-valid group. A
 * legacy group-less row (null group, set connection) locates the group that now
 * owns the connection so the pin is preserved — seeding it would let the effect
 * send a different non-null member and silently switch environments (Codex).
 *
 * The routing mode is preserved faithfully on a restore: a null `routingMode`
 * stays null because the picker and the agent runtime both read null as "pin"
 * (pre-#2518 back-compat — see {@link effectiveMode}). An omitted `routingMode`
 * (optional on the wire type) is coalesced to null rather than left undefined.
 */
export function resolveConversationScope(
  source: ConversationScopeSource,
  groups: ReadonlyArray<ChatEnvGroup>,
): ConversationScopeDecision {
  const groupId = source.connectionGroupId;
  const connectionId = source.connectionId;
  const routingMode = source.routingMode ?? null;
  // #3066 — the row's REST exclude-set. Coalesce an absent / null column to `[]`
  // (no exclusions). Cloned so the caller owns a mutable array. #3078 — carried
  // on EVERY decision below (restore AND seed), independent of the SQL
  // group/member validation: REST scope is not tied to SQL routing.
  const restExcludedDatasourceIds = source.restExcludedDatasourceIds
    ? [...source.restExcludedDatasourceIds]
    : [];
  // #3067 — the row's REST-only focus (null = not focused). Carried on every
  // decision the same way as the exclude-set (#3078).
  const restFocusDatasourceId = source.restFocusDatasourceId ?? null;

  // A row that persisted no SQL scope is never authoritative for routing — defer
  // to the seed/restore effect (decided before the load gate so it holds either
  // way). The REST scope still rides along, so an all-null-SQL conversation with
  // an exclude-set keeps it (#3078).
  if (groupId === null && connectionId === null) return { kind: "seed", restExcludedDatasourceIds, restFocusDatasourceId };

  // Groups not loaded yet (cold-start open): we can't validate, so trust the
  // row optimistically. Losing the restore here would be a worse, more common
  // regression than the rare archived-env + cold-start intersection.
  if (groups.length === 0) {
    return { kind: "restore", groupId, connectionId, routingMode, restExcludedDatasourceIds, restFocusDatasourceId };
  }

  // Groups loaded — validate the row against the visible environments.
  if (groupId !== null) {
    // The row named a content group: it must still resolve, else a stale group
    // id reaches the chat route and is rejected (invalid_connection_group).
    const group = groups.find((g) => g.id === groupId);
    if (!group) return { kind: "seed", restExcludedDatasourceIds, restFocusDatasourceId };

    // Group resolves. Keep the pinned member if it's still present; otherwise
    // repair the execution target to the group primary (never send a stale id),
    // preserving the still-valid group rather than discarding it.
    const member = group.members.find((m) => m.connectionId === connectionId);
    if (member) {
      return { kind: "restore", groupId: group.id, connectionId: member.connectionId, routingMode, restExcludedDatasourceIds, restFocusDatasourceId };
    }
    const repaired =
      group.members.find((m) => m.connectionId === group.primaryConnectionId) ??
      group.members[0];
    if (!repaired) return { kind: "seed", restExcludedDatasourceIds, restFocusDatasourceId }; // group exists but has no live members
    return { kind: "restore", groupId: group.id, connectionId: repaired.connectionId, routingMode, restExcludedDatasourceIds, restFocusDatasourceId };
  }

  // Legacy group-less row (connectionGroupId null, connectionId set, e.g. a
  // pre-0067 row whose group was never backfilled): locate the group that now
  // owns the connection so the PIN is preserved. Returning `seed` here would
  // clear the scope and let the seed/restore effect send the sticky preference /
  // group primary as a non-null override — silently switching a conversation
  // pinned to e.g. `eu-prod` onto the default environment (Codex, #3074). Only
  // seed if the connection no longer exists in any visible group.
  const owningGroup = groups.find((g) =>
    g.members.some((m) => m.connectionId === connectionId),
  );
  if (!owningGroup) return { kind: "seed", restExcludedDatasourceIds, restFocusDatasourceId };
  return { kind: "restore", groupId: owningGroup.id, connectionId, routingMode, restExcludedDatasourceIds, restFocusDatasourceId };
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
  restDatasources = [],
  restExcludedDatasourceIds = [],
  onRestExcludedChange,
  restFocusDatasourceId = null,
  onRestFocusChange,
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

  if (!shouldRenderEnvPicker({ groups, reason: emptyReason, error: transportError, restDatasources })) {
    return null;
  }

  const activeGroup =
    groups.find((g) => g.id === activeGroupId) ??
    groups.find((g) => g.members.some((m) => m.connectionId === activeConnectionId)) ??
    groups[0];
  const activeMember =
    activeGroup?.members.find((m) => m.connectionId === activeConnectionId) ??
    activeGroup?.members.find((m) => m.connectionId === activeGroup.primaryConnectionId) ??
    activeGroup?.members[0];

  // #3078 — a zero-group (REST-only) workspace has no SQL routing to display.
  // `activeGroup` is undefined there, so the chip / dropdown drop the SQL
  // routing modes, member list, and singleton hint and show only the REST
  // scope. `hasSqlScope` gates every SQL affordance below.
  const hasSqlScope = activeGroup != null;
  const mode = effectiveMode(activeRoutingMode);
  const groupLabel = activeGroup ? stripGroupPrefix(activeGroup.name) : "—";
  const memberLabel = activeMember?.connectionId ?? "—";

  // #3066 — REST scope summary (e.g. `2/3` in-scope of reachable). "Reachable" =
  // the datasources actually reachable in scope; excluded ones reduce the
  // in-scope count. With an active group it's workspace-global + datasources
  // scoped to that group. #3078 — on a zero-group (REST-only) workspace there's
  // no SQL env to scope against, so EVERY REST datasource is reachable (else a
  // group-scoped install would show "0/0 REST" with no toggle).
  const excludedRestSet = new Set(restExcludedDatasourceIds);
  const reachableRest = hasSqlScope
    ? restDatasources.filter((d) => d.groupId === null || d.groupId === activeGroup?.id)
    : restDatasources;
  const restInScopeCount = reachableRest.filter((d) => !excludedRestSet.has(d.id)).length;

  // #3067 — REST-only focus, looked up for the chip / dropdown summary. Falls
  // back to "REST only" if the focused id isn't in the list (e.g. a datasource
  // scoped to another env, still focusable via the resolver).
  const focusedDatasource = restFocusDatasourceId
    ? restDatasources.find((d) => d.id === restFocusDatasourceId)
    : undefined;
  const isFocused = restFocusDatasourceId !== null;

  // Chip label. Precedence: REST-only focus (SQL suspended) > SQL routing chip
  // (with the REST count appended) > SQL-less REST count (zero-group workspace).
  let chipLabel: string;
  let ChipIcon: typeof Layers;
  if (isFocused) {
    // #3067 — focus overrides the chip entirely: SQL routing is suspended, so the
    // chip reads "<name> only" for the datasource the agent targets.
    chipLabel = `${focusedDatasource?.displayName ?? "REST"} only`;
    ChipIcon = Crosshair;
  } else if (hasSqlScope) {
    // SQL routing chip — tracks the mode so the trigger reflects the next turn's
    // routing. The compact forms keep the chip readable for long names.
    if (mode === "auto") {
      chipLabel = `Auto · ${groupLabel}`;
      ChipIcon = Sparkles;
    } else if (mode === "all") {
      chipLabel = `All · ${groupLabel}`;
      ChipIcon = Globe2;
    } else {
      // Pin — show the member name. Collapse "warehouse / warehouse" →
      // "warehouse" when the stripped group name and the member id match (the
      // common 0062 backfill shape: g_<connId> + one member named <connId>).
      chipLabel = groupLabel === memberLabel ? memberLabel : `${groupLabel} / ${memberLabel}`;
      ChipIcon = Pin;
    }
    // #3066 — append the REST count (e.g. `Pin · apac-prod · 2/3 REST`) only when
    // the workspace has a reachable REST datasource, so SQL-only workspaces keep
    // their byte-identical chip.
    if (reachableRest.length > 0) {
      chipLabel = `${chipLabel} · ${restInScopeCount}/${reachableRest.length} REST`;
    }
  } else {
    // #3078 — zero-group (REST-only) workspace: no SQL group/member to show, so
    // the chip is just the REST count.
    chipLabel = `${restInScopeCount}/${reachableRest.length} REST`;
    ChipIcon = Network;
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
          data-focused={isFocused}
          data-sql-scope={hasSqlScope}
          aria-label={
            isFocused
              ? `Conversation scope: focused on ${chipLabel} — SQL suspended. Change.`
              : hasSqlScope
                ? `Cross-environment routing: ${chipLabel}. Change.`
                : `Conversation scope: ${chipLabel}. Change.`
          }
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
        {/* Mode section — three SQL-routing states with the current mode marked.
            #3078 — hidden for a zero-group (REST-only) workspace: there is no SQL
            to route, so the dropdown shows only the REST scope section below. */}
        {hasSqlScope && (
          <>
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
          </>
        )}

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

        {/* #3078 — the singleton hint is an SQL-connections affordance; suppress
            it on a zero-group (REST-only) workspace, where `allSingletons` would
            be vacuously true for the empty group list. */}
        {hasSqlScope && allSingletons && (
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

        <ChatEnvRestScopeSection
          restDatasources={restDatasources}
          activeGroupId={activeGroup?.id ?? null}
          hasSqlScope={hasSqlScope}
          excludedIds={restExcludedDatasourceIds}
          onRestExcludedChange={onRestExcludedChange}
          focusedId={restFocusDatasourceId}
          focusedDatasource={focusedDatasource}
          onRestFocusChange={onRestFocusChange}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * #3044 / #3066 — REST datasource scope section. Each datasource reachable in
 * the active env (workspace-global, or scoped to the active group) renders as a
 * checkbox: checked = in scope, unchecking EXCLUDES it from the conversation so
 * the agent stops querying it (#3066). Datasources scoped to *other*
 * environments aren't reachable here, so they stay informational (excluding
 * them would be a no-op). Toggling sends the FULL next exclude-set to the
 * parent — `[]` when everything is re-included is meaningful (it clears the
 * row). When no `onRestExcludedChange` is supplied the rows fall back to a
 * read-only summary (back-compat with #3044 callers).
 */
function ChatEnvRestScopeSection({
  restDatasources,
  activeGroupId,
  hasSqlScope = true,
  excludedIds,
  onRestExcludedChange,
  focusedId,
  focusedDatasource,
  onRestFocusChange,
}: {
  restDatasources: ReadonlyArray<ChatRestDatasourceScope>;
  activeGroupId: string | null;
  /**
   * #3078 — whether the workspace has an active SQL scope (a connection group).
   * `false` for a zero-group REST-only workspace. Drives two things: (1) the
   * leading separator is suppressed when false (the REST section is the first
   * dropdown content, so no dangling rule); (2) when false there is no SQL env
   * to scope against, so EVERY REST datasource is reachable (toggleable /
   * focusable) rather than partitioned by `activeGroupId`. Defaults to true for
   * back-compat with callers that always render the SQL section.
   */
  hasSqlScope?: boolean;
  excludedIds: ReadonlyArray<string>;
  onRestExcludedChange?: (next: string[]) => void;
  /** #3067 — the focused datasource id, or null = not focused. */
  focusedId: string | null;
  /** #3067 — the focused datasource (for its display name), if it's in the list. */
  focusedDatasource?: ChatRestDatasourceScope;
  /** #3067 — focus a datasource (`install_id`) or clear focus (`null`). */
  onRestFocusChange?: (next: string | null) => void;
}): React.ReactElement | null {
  if (restDatasources.length === 0) return null;

  // #3067 — focused state: SQL is suspended and the exclude-set is inert, so
  // render the focus summary + a clear action INSTEAD of the exclude checkboxes
  // (toggling exclusions while focused would be confusing — they don't apply).
  if (focusedId !== null) {
    return (
      <>
        {hasSqlScope && <DropdownMenuSeparator />}
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
          REST-only focus
        </DropdownMenuLabel>
        <div
          className="px-2 pb-1 pt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400"
          data-testid="chat-env-picker-rest-focused"
          data-focus-id={focusedId}
        >
          <span className="flex items-center gap-1.5">
            <Crosshair className="size-3 shrink-0 text-primary" aria-hidden />
            <span className="truncate">
              Focused on{" "}
              <span className="font-medium text-zinc-700 dark:text-zinc-200">
                {focusedDatasource?.displayName ?? focusedId}
              </span>
            </span>
          </span>
          <span className="mt-0.5 block text-zinc-400 dark:text-zinc-500">
            SQL is suspended — the agent answers from this datasource only.
          </span>
        </div>
        {onRestFocusChange && (
          <DropdownMenuItem
            onSelect={() => onRestFocusChange(null)}
            className="flex items-center gap-2 text-xs"
            data-testid="chat-env-picker-rest-focus-clear"
          >
            <X className="size-3.5 text-zinc-500" aria-hidden />
            <span>Clear focus — re-enable SQL</span>
          </DropdownMenuItem>
        )}
      </>
    );
  }

  const workspaceGlobal = restDatasources.filter((d) => d.groupId === null);
  // #3078 — group-scoped datasources reachable in the current scope. With an
  // active SQL group, that's the ones scoped to it; on a zero-group REST-only
  // workspace there's no env to scope against, so ALL group-scoped installs are
  // reachable (otherwise they'd be unreachable with no SQL group to match).
  const inActiveGroup = restDatasources.filter(
    (d) => d.groupId !== null && (!hasSqlScope || d.groupId === activeGroupId),
  );
  // Out of scope only exists when there IS an SQL env to be "other" than; a
  // zero-group workspace has no other environments.
  const otherScoped = hasSqlScope
    ? restDatasources.filter((d) => d.groupId !== null && d.groupId !== activeGroupId)
    : [];
  // #3067 — the datasources reachable in the current scope are the ones a user
  // can focus (workspace-global + the reachable scoped ones), mirroring the
  // exclude checkboxes. A datasource scoped to another env stays informational.
  const focusable = [...workspaceGlobal, ...inActiveGroup];

  const excludedSet = new Set(excludedIds);
  // Compute the next exclude-set when one datasource is (un)checked. `checked`
  // = in scope, so checking removes it from the set and unchecking adds it.
  const toggle = (id: string, checked: boolean) => {
    if (!onRestExcludedChange) return;
    const next = new Set(excludedSet);
    if (checked) next.delete(id);
    else next.add(id);
    onRestExcludedChange([...next]);
  };

  const renderRow = (
    d: ChatRestDatasourceScope,
    opts: { readonly global: boolean },
  ): React.ReactElement => {
    const inScope = !excludedSet.has(d.id);
    const Icon = opts.global ? Globe2 : Network;
    return (
      <DropdownMenuCheckboxItem
        key={d.id}
        checked={inScope}
        // Keep the menu open so several datasources can be toggled in one pass.
        onSelect={(e) => e.preventDefault()}
        onCheckedChange={(checked) => toggle(d.id, checked === true)}
        className="text-xs"
        data-testid={`chat-env-picker-rest-toggle-${d.id}`}
        data-in-scope={inScope}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <Icon className="size-3 shrink-0 text-zinc-400" aria-hidden />
          <span className="truncate">{d.displayName}</span>
        </span>
      </DropdownMenuCheckboxItem>
    );
  };

  return (
    <>
      {hasSqlScope && <DropdownMenuSeparator />}
      <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
        REST datasources
      </DropdownMenuLabel>

      {workspaceGlobal.length > 0 && (
        <div data-testid="chat-env-picker-rest-global">
          <DropdownMenuLabel className="px-2 pb-0.5 pt-1 text-[10px] font-normal text-zinc-400 dark:text-zinc-500">
            Workspace-global — answers in every environment
          </DropdownMenuLabel>
          {workspaceGlobal.map((d) => renderRow(d, { global: true }))}
        </div>
      )}

      {inActiveGroup.length > 0 && (
        <div data-testid="chat-env-picker-rest-in-scope">
          <DropdownMenuLabel className="px-2 pb-0.5 pt-1 text-[10px] font-normal text-zinc-400 dark:text-zinc-500">
            {/* #3078 — "this environment" only reads right when there IS an SQL
                env; a zero-group workspace just has in-scope datasources. */}
            {hasSqlScope ? "In this environment" : "In scope"}
          </DropdownMenuLabel>
          {inActiveGroup.map((d) => renderRow(d, { global: false }))}
        </div>
      )}

      {otherScoped.length > 0 && (
        <div
          className="px-2 py-1 text-[11px] leading-snug text-zinc-400 dark:text-zinc-500"
          data-testid="chat-env-picker-rest-out-of-scope"
        >
          <span className="flex items-center gap-1.5">
            <Network className="size-3" aria-hidden />
            {otherScoped.length} scoped to other environments — not reachable here
          </span>
        </div>
      )}

      {/* #3067 — REST-only focus selector. Picking one targets it exclusively
          and suspends SQL for the conversation. Only when a focus handler is
          wired and there's a reachable datasource to focus. */}
      {onRestFocusChange && focusable.length > 0 && (
        <div data-testid="chat-env-picker-rest-focus-options">
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="px-2 pb-0.5 pt-1 text-[10px] font-normal text-zinc-400 dark:text-zinc-500">
            Focus one datasource — suspends SQL
          </DropdownMenuLabel>
          {focusable.map((d) => (
            <DropdownMenuItem
              key={d.id}
              // Focusing is a one-shot scope change — let the menu close on
              // select (default DropdownMenuItem behavior); the chip updates to
              // "<name> only". (Contrast the exclude checkboxes, which
              // preventDefault to stay open for multi-toggle.)
              onSelect={() => onRestFocusChange(d.id)}
              className="flex items-center gap-1.5 text-xs"
              data-testid={`chat-env-picker-rest-focus-${d.id}`}
            >
              <Crosshair className="size-3 shrink-0 text-zinc-400" aria-hidden />
              <span className="truncate">{d.displayName} only</span>
            </DropdownMenuItem>
          ))}
        </div>
      )}
    </>
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
  /** #3044 — REST datasources + their env scope, for the picker's scope footer. */
  readonly restDatasources: ReadonlyArray<ChatRestDatasourceScope>;
  readonly reason: MeConnectionGroupsEmptyReason | null;
  readonly loading: boolean;
  /**
   * #3078 — `true` once a fetch has settled (success or error) at least once,
   * so a consumer can tell "groups loaded and are genuinely empty" (a zero-group
   * REST-only workspace) from "groups not fetched yet" (cold start). The seed/
   * restore effect needs this to seed the sticky REST preference on a fresh chat
   * in a zero-group workspace without racing the in-flight fetch.
   */
  readonly hasLoaded: boolean;
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
  const [restDatasources, setRestDatasources] = useState<
    ReadonlyArray<ChatRestDatasourceScope>
  >([]);
  const [reason, setReason] = useState<MeConnectionGroupsEmptyReason | null>(null);
  const [loading, setLoading] = useState(false);
  // #3078 — flips true once the first fetch settles (see UseChatEnvGroupsResult).
  const [hasLoaded, setHasLoaded] = useState(false);
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
          restDatasources?: ChatRestDatasourceScope[];
          reason?: unknown;
        };
        if (!cancelled) {
          setGroups(body.groups ?? []);
          // #3044 — older API servers (pre-this-change) omit the field; default
          // to empty so the scope footer simply doesn't render on mixed deploys.
          setRestDatasources(body.restDatasources ?? []);
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
          setRestDatasources([]);
          // Don't synthesize a `reason` on transport failure — the
          // server is the only source of truth for "empty because of
          // X". A flaky network reading as "no_internal_db" would be
          // misleading.
          setReason(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          // #3078 — a fetch has now settled; the empty state (if any) is real,
          // not a not-yet-loaded one.
          setHasLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [opts.apiUrl, opts.enabled, opts.getHeaders, opts.getCredentials]);

  return { groups, restDatasources, reason, loading, hasLoaded, error };
}
