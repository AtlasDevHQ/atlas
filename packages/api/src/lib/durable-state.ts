/**
 * Durable per-session working memory — plain write/load helpers + an
 * AsyncLocalStorage-backed handle (#3754, ADR-0020, slice 1).
 *
 * The tracer bullet for the durable-memory programming model (PRD #3752): a
 * typed, named per-SESSION memory handle (analogous to Vercel Eve's
 * `defineState`) that a tool or the agent loop reads and updates. A "session" is
 * a *conversation*, NOT a single turn — a slot written in one turn is readable
 * in the next, and after a crash/resume — so memory is keyed on
 * `conversation_id`, persisted to `agent_session_memory` (migration 0145).
 *
 * Two seams, mirroring `lib/durable-session.ts`:
 *   - Plain (non-Effect) helpers — {@link loadSessionMemory},
 *     {@link commitSessionMemory}, {@link buildDurableStateStore} — so the agent
 *     loop (`lib/agent.ts`, a plain async function) calls them directly, the same
 *     shape as the transcript checkpoint + token_usage writes it sits beside.
 *   - The {@link defineDurableState} handle + {@link runWithDurableState} ambient
 *     context, so tool `execute` callbacks (plain async functions invoked by the
 *     AI SDK as the stream is consumed) read/write the active session's slots
 *     without threading a store argument through every tool signature.
 *
 * Fail-soft is the contract (ADR-0020 "checkpointing never disrupts the
 * stream"): every commit rides the fire-and-forget `internalExecute` circuit
 * breaker (shared with token_usage / the transcript checkpoint), so a
 * persistence failure logs and never disrupts the live stream. When there is no
 * internal DB the store is a {@link NOOP_DURABLE_STATE_STORE} — reads return
 * empty, updates are no-ops, the agent behaves exactly as it does today. The
 * Effect `DurableState` Tag (`lib/effect/durable-state.ts`) wraps these same
 * helpers for `Layer.provide` test injection and future Effect callers.
 *
 * THIS SLICE delivers the handle + persistence only: memory is exercised THROUGH
 * the handle (a tool reads back what a prior turn wrote). Deterministic prompt
 * threading — auto-injecting memory into the model's context — is the next slice
 * (#3755).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { hasInternalDB, internalExecute, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("durable-state");

/**
 * Reserved slot-name namespace. Names beginning with this prefix are reserved
 * for Atlas-internal slots, so a caller's {@link defineDurableState} for a
 * reserved name is rejected — preventing a tenant slot from colliding with (or
 * shadowing) an internal one.
 */
export const RESERVED_NAMESPACE_PREFIX = "atlas:";

// ── SQL (exported for the real-Postgres tests so they exercise the EXACT SQL) ──

/** Load every persisted slot for a session (the hot per-conversation read). */
export const SESSION_MEMORY_LOAD_SQL =
  `SELECT namespace, value FROM agent_session_memory WHERE conversation_id = $1`;

/**
 * Upsert one named slot. `value` is overwritten unconditionally. `org_id` is
 * COALESCEd so a later write that happens to carry a null org can never regress a
 * known tenant scope to null (the tenant scope later slices enforce on).
 *
 * ORDERING CAVEAT: writes ride the fire-and-forget `internalExecute` path, which
 * does NOT order concurrent dispatches. Cross-turn ordering is safe (turn N+1
 * loads its slots only after turn N has drained + committed). But two writes to
 * the SAME slot within ONE turn (committed at successive step boundaries) are
 * independent upserts with no monotonic guard — unlike the transcript checkpoint,
 * whose `step_index = GREATEST` guard makes it reorder-safe, this row is keyed on
 * the conversation and spans turns, so a per-turn step index can't serve as that
 * guard. If two same-slot writes within a turn land out of order the earlier
 * value can win (a lost update). Bounded + acceptable for slice 1 (off by
 * default; same-slot repeat-within-a-turn is the only exposure); a
 * conversation-global monotonic guard is deferred to the bounds/safety slice
 * (#3757).
 */
export const SESSION_MEMORY_UPSERT_SQL =
  `INSERT INTO agent_session_memory (conversation_id, org_id, namespace, value, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (conversation_id, namespace) DO UPDATE SET
         value = EXCLUDED.value,
         org_id = COALESCE(EXCLUDED.org_id, agent_session_memory.org_id),
         updated_at = now()`;

// ── Store ────────────────────────────────────────────────────────────────────

/** A single named slot pending persistence. */
export interface DurableStateSlot {
  readonly namespace: string;
  readonly value: unknown;
}

/**
 * The per-turn handle backing for the active session's memory. The agent loop
 * builds one per turn (Live when memory is active, the shared Noop otherwise),
 * makes it the ambient store for tool execution, and commits its dirty slots at
 * step boundaries.
 */
export interface DurableStateStore {
  /** `true` for a real internal-DB-backed store; `false` for the Noop store. */
  readonly available: boolean;
  readonly conversationId: string | null;
  readonly orgId: string | null;
  /** Current value of a slot, or `undefined` if unset (or on the Noop store). */
  get(namespace: string): unknown;
  /** Stage a slot value; marks it dirty for the next {@link drainDirty}. */
  set(namespace: string, value: unknown): void;
  /** Return + clear the slots changed since the last drain (commit boundary). */
  drainDirty(): DurableStateSlot[];
}

/** Real, internal-DB-backed store: an in-memory slot map with dirty tracking. */
class LiveDurableStateStore implements DurableStateStore {
  readonly available = true;
  private readonly slots: Map<string, unknown>;
  private readonly dirty = new Set<string>();

  constructor(
    readonly conversationId: string,
    readonly orgId: string | null,
    initial: Map<string, unknown>,
  ) {
    // Defensive copy: the store owns its slot map for the turn's lifetime, so a
    // caller's map can't alias internal state (today `buildDurableStateStore`
    // always hands us a fresh map, but the copy keeps that an invariant of the
    // type, not of the single call site).
    this.slots = new Map(initial);
  }

  get(namespace: string): unknown {
    return this.slots.get(namespace);
  }

  set(namespace: string, value: unknown): void {
    this.slots.set(namespace, value);
    this.dirty.add(namespace);
  }

  drainDirty(): DurableStateSlot[] {
    if (this.dirty.size === 0) return [];
    const out: DurableStateSlot[] = [];
    for (const namespace of this.dirty) {
      out.push({ namespace, value: this.slots.get(namespace) });
    }
    this.dirty.clear();
    return out;
  }
}

/**
 * Shared no-op store selected when memory is off or no internal DB is present.
 * Reads return `undefined`, writes are dropped, nothing is ever dirty — so a
 * tool reading the handle behaves exactly as it does today. Frozen + stateless,
 * so it is safe to share across all turns.
 */
export const NOOP_DURABLE_STATE_STORE: DurableStateStore = Object.freeze({
  available: false,
  conversationId: null,
  orgId: null,
  get: () => undefined,
  set: () => {},
  drainDirty: () => [],
});

// ── Ambient context + handle ───────────────────────────────────────────────────

const durableStateStorage = new AsyncLocalStorage<DurableStateStore>();

/** Thrown when the handle is accessed outside an active session context, or a slot name is invalid/reserved. */
export class DurableStateContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableStateContextError";
  }
}

/**
 * Run `fn` with `store` as the ambient durable-state context. The agent loop
 * wraps each tool's `execute` with this so {@link defineDurableState} handles
 * resolve to the turn's store no matter when the AI SDK invokes the tool.
 */
export function runWithDurableState<T>(store: DurableStateStore, fn: () => T): T {
  return durableStateStorage.run(store, fn);
}

function requireStore(): DurableStateStore {
  const store = durableStateStorage.getStore();
  if (!store) {
    throw new DurableStateContextError(
      "Durable state accessed outside an active agent session context (use runWithDurableState, or access from within a tool/agent step)",
    );
  }
  return store;
}

/** A typed accessor over one named per-session slot. Declared once at module scope. */
export interface DurableStateHandle<T> {
  readonly name: string;
  /** Read the slot for the active session — the declared default if unset. */
  get(): T | undefined;
  /** Write the slot for the active session (staged; committed at step boundary). */
  set(value: T): void;
  /** Read-modify-write the slot for the active session. */
  update(fn: (prev: T | undefined) => T): void;
}

/**
 * Module-level registry of declared slot names. Catches two distinct
 * declarations of the same name (a collision that would silently share storage
 * with mismatched types). Reset between tests via {@link _resetDurableStateRegistry}.
 */
const declaredSlots = new Set<string>();

/**
 * Declare a typed, named per-session memory slot. Call once at module scope:
 *
 * ```ts
 * const lastTable = defineDurableState<string>("analyst.lastTable");
 * // inside a tool: lastTable.set("orders"); ... next turn: lastTable.get()
 * ```
 *
 * Rejects an empty name, a {@link RESERVED_NAMESPACE_PREFIX reserved}-namespace
 * name, and a duplicate declaration. The returned handle reads/writes the active
 * session's store and throws ({@link DurableStateContextError}) if accessed
 * outside one.
 *
 * KNOWN LIMITATION (slice 1): the declared `T` is NOT validated on read. Slots
 * round-trip through JSONB, and `get()` trusts the persisted value as `T` (an
 * unchecked cast) — a slot read back from an older deploy, a different declared
 * type, or hand-edited data could violate `T` at runtime, and non-JSON types
 * (`Date`, `Map`, `bigint`, `undefined`-valued fields) do not survive the
 * round-trip. Use JSON-serializable, stable-shaped values. A validating variant
 * (`{ schema }` → `schema.parse` on read) is future work. Relatedly, an explicit
 * `set(null)` persists as JSON `null` and reads back as `null`, NOT the declared
 * `default` (the default fires only when a slot is unset, i.e. truly `undefined`).
 */
export function defineDurableState<T = unknown>(
  name: string,
  options?: { readonly default?: T },
): DurableStateHandle<T> {
  if (typeof name !== "string" || name.length === 0) {
    throw new DurableStateContextError("Durable state slot name must be a non-empty string");
  }
  if (name.startsWith(RESERVED_NAMESPACE_PREFIX)) {
    throw new DurableStateContextError(
      `Durable state slot name "${name}" uses the reserved "${RESERVED_NAMESPACE_PREFIX}" namespace`,
    );
  }
  if (declaredSlots.has(name)) {
    throw new DurableStateContextError(`Durable state slot "${name}" is already declared`);
  }
  declaredSlots.add(name);

  const read = (): T | undefined => {
    const value = requireStore().get(name);
    return value === undefined ? options?.default : (value as T);
  };

  return {
    name,
    get: read,
    set: (value: T) => {
      requireStore().set(name, value);
    },
    update: (fn: (prev: T | undefined) => T) => {
      requireStore().set(name, fn(read()));
    },
  };
}

/** Test-only: clear the declared-slot registry (call in `beforeEach`, never at module top level). */
export function _resetDurableStateRegistry(): void {
  declaredSlots.clear();
}

// ── Plain load / commit helpers (the persistence seam) ─────────────────────────

/**
 * Load a session's persisted slots into a map. Fail-soft: a load failure (or no
 * internal DB) yields an empty map — the turn proceeds with empty memory rather
 * than failing. Restores memory across turn boundaries and on crash/resume.
 */
export async function loadSessionMemory(conversationId: string): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  if (!hasInternalDB()) return map;
  try {
    const rows = await internalQuery<{ namespace: string; value: unknown }>(
      SESSION_MEMORY_LOAD_SQL,
      [conversationId],
    );
    for (const row of rows) map.set(row.namespace, row.value);
    return map;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId },
      "Failed to load durable session memory — starting empty",
    );
    return map;
  }
}

/**
 * Persist a batch of dirty slots (fire-and-forget). Each upsert is dispatched
 * through `internalExecute`, whose own circuit breaker swallows + logs ASYNC DB
 * failures (the row is lost, the stream is not disrupted). The per-slot
 * `try/catch` here guards only the SYNCHRONOUS `JSON.stringify` throw (a circular
 * slot value), and — because it wraps each iteration — a single un-serializable
 * slot is logged and skipped without stranding the others in the batch. Either
 * way a degraded memory store costs continuity, never the current answer
 * (ADR-0020). No-op without an internal DB or with no slots.
 */
export function commitSessionMemory(args: {
  conversationId: string;
  orgId: string | null;
  slots: DurableStateSlot[];
}): void {
  if (!hasInternalDB() || args.slots.length === 0) return;
  for (const slot of args.slots) {
    try {
      internalExecute(SESSION_MEMORY_UPSERT_SQL, [
        args.conversationId,
        args.orgId,
        slot.namespace,
        // Serialize inside the try so a circular value throws here (caught)
        // rather than disrupting the stream. `?? null` keeps an explicit
        // `undefined` write valid JSONB.
        JSON.stringify(slot.value ?? null),
      ]);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId: args.conversationId,
          namespace: slot.namespace,
        },
        "Failed to commit durable session memory slot",
      );
    }
  }
}

/**
 * Build the per-turn durable-state store for the agent loop. When memory is
 * active — durability on (`active`) + a conversation/session key + an internal
 * DB — loads the session's persisted slots into a Live store; otherwise returns
 * the shared {@link NOOP_DURABLE_STATE_STORE} so tools reading the handle behave
 * identically to today.
 */
export async function buildDurableStateStore(args: {
  conversationId: string | null;
  orgId: string | null;
  active: boolean;
}): Promise<DurableStateStore> {
  if (!args.active || !args.conversationId || !hasInternalDB()) {
    return NOOP_DURABLE_STATE_STORE;
  }
  const initial = await loadSessionMemory(args.conversationId);
  return new LiveDurableStateStore(args.conversationId, args.orgId, initial);
}
