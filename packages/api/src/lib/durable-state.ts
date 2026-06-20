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
import type { SessionMemorySlot, SessionMemoryView } from "@useatlas/types";
import { hasInternalDB, internalExecute, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { findSecretLike } from "@atlas/api/lib/memory-secret-scan";
// The retention-window default is owned by the durable-session module (the
// runs sweep). Memory rides the SAME window, so it reuses that constant rather
// than a second magic number that could drift. Type/value-only import — no
// cyclic risk (durable-session never imports durable-state).
import { DEFAULT_RETENTION_DAYS } from "@atlas/api/lib/durable-session";

const log = createLogger("durable-state");

/**
 * Reserved slot-name namespace. Names beginning with this prefix are reserved
 * for Atlas-internal slots, so a caller's {@link defineDurableState} for a
 * reserved name is rejected — preventing a tenant slot from colliding with (or
 * shadowing) an internal one.
 */
export const RESERVED_NAMESPACE_PREFIX = "atlas:";

// ── Bounds & safety: caps + secrets prohibition (#3757, ADR-0020, slice 4) ─────
//
// Working memory must stay BOUNDED (so a session can't accumulate unbounded
// state) and must never become a credential exfiltration surface. Both controls
// run at WRITE/STAGING time in `LiveDurableStateStore.set`, NOT at commit: the
// commit is fire-and-forget (rides the `internalExecute` circuit breaker, never
// throws), so a rejection there could not surface to the caller. Staging is
// reached synchronously from a tool's `defineDurableState(...).set()` inside
// `runWithDurableState`, so a thrown rejection propagates up through the tool's
// `execute` to the agent/caller — exactly the "surfaced, never truncated"
// contract the issue requires.

/** Settings key: max number of slots a single session may hold. */
export const MEMORY_MAX_SLOTS_SETTING = "ATLAS_MEMORY_MAX_SLOTS";
/** Settings key: max serialized byte length of a single slot value. */
export const MEMORY_MAX_VALUE_BYTES_SETTING = "ATLAS_MEMORY_MAX_VALUE_BYTES";

/** Fallback slot cap when the setting is unset/unparseable. */
export const DEFAULT_MEMORY_MAX_SLOTS = 64;
/** Fallback per-value byte cap when the setting is unset/unparseable (16 KiB). */
export const DEFAULT_MEMORY_MAX_VALUE_BYTES = 16_384;

/**
 * Clamp a raw settings string to a sane positive integer, else `fallback`.
 * Mirrors the durability knobs' `clampPositiveInt` (lib/durable-session.ts) so a
 * non-positive / unparseable override can never weaken a cap to 0 or NaN.
 */
function clampPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Resolve the per-session slot cap from the settings registry, clamped to a sane
 * positive integer. Workspace > platform > env > default (the `getSettingAuto`
 * tier chain), so an operator/admin can tune it from Admin → Settings with no
 * redeploy. The READ stays inline at the resolver (the settings-reader parity
 * check — check-settings-readers.sh — sees the const-bound key next to its
 * reader).
 */
export function getMemoryMaxSlots(orgId?: string): number {
  return clampPositiveInt(getSettingAuto(MEMORY_MAX_SLOTS_SETTING, orgId), DEFAULT_MEMORY_MAX_SLOTS);
}

/** Resolve the per-value byte cap from the settings registry, clamped positive. */
export function getMemoryMaxValueBytes(orgId?: string): number {
  return clampPositiveInt(
    getSettingAuto(MEMORY_MAX_VALUE_BYTES_SETTING, orgId),
    DEFAULT_MEMORY_MAX_VALUE_BYTES,
  );
}

/**
 * Thrown when a slot write would exceed a configured cap (value bytes or slot
 * count). Distinct from {@link DurableStateContextError} so a caller / tool can
 * tell "you violated a bound" from "you used the handle wrong". The message is
 * value-free (it names the cap, never the rejected value).
 */
export class DurableStateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableStateLimitError";
  }
}

/**
 * Thrown when a slot write carries a value that looks like a secret/credential
 * ({@link findSecretLike}). Rejected BEFORE persistence so memory never becomes
 * an exfiltration surface. The message names the credential SHAPE that tripped,
 * never the value, so the rejection itself can't leak the secret into a log.
 */
export class DurableStateSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableStateSecretError";
  }
}

/** UTF-8 byte length of a string (a multi-byte char counts its full encoded length). */
const utf8ByteLength =
  typeof Buffer !== "undefined"
    ? (s: string): number => Buffer.byteLength(s, "utf8")
    : (s: string): number => new TextEncoder().encode(s).length;

/**
 * The cap + secret bounds a Live store enforces on every write. Resolved ONCE
 * per turn at {@link buildDurableStateStore} (so the per-workspace settings
 * override is honored, and a write within a turn doesn't re-read settings on the
 * hot path), then carried by the store.
 */
interface MemoryBounds {
  readonly maxSlots: number;
  readonly maxValueBytes: number;
}

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
 * value can win (a lost update). Bounded + acceptable (off by default; same-slot
 * repeat-within-a-turn is the only exposure). A conversation-global monotonic
 * guard remains future work — out of scope for the bounds/safety slice (#3757),
 * whose contract is caps + secrets + tenant scoping + lifecycle sweep, not write
 * ordering.
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
  /**
   * Read-only view of EVERY current slot (not just dirty ones), for deterministic
   * prompt threading (#3755). The agent loop renders this into the memory block
   * once per turn via {@link renderDurableMemoryBlock}. Empty on the Noop store,
   * so an inactive turn threads nothing. The map is a defensive copy (mutating it
   * does not touch the store), but slot VALUES are shared by reference — read-only
   * by contract, never mutate them in place.
   */
  snapshot(): ReadonlyMap<string, unknown>;
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
    private readonly bounds: MemoryBounds,
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

  /**
   * Stage a slot value after enforcing the bounds (#3757). The order is
   * deliberate: the rejecting checks run BEFORE any mutation, so a rejected
   * write leaves the store byte-identical (no partial/truncated state):
   *   1. secrets — a credential-shaped value never persists;
   *   2. size — the serialized value must fit the per-value byte cap;
   *   3. slot count — a NEW slot must not push the session past the slot cap
   *      (overwriting an EXISTING slot never grows the count, so it is exempt).
   * Each violation throws (surfaced to the caller via the tool's `execute`),
   * never truncates. Serialization here is the same `JSON.stringify` the commit
   * path uses, so the measured size matches what would be persisted; a value
   * that can't serialize (a cycle) is rejected as a limit violation rather than
   * deferring the throw to the fire-and-forget commit where it would be lost.
   */
  set(namespace: string, value: unknown): void {
    const secret = findSecretLike(value);
    if (secret) {
      throw new DurableStateSecretError(
        `Durable memory rejected slot "${namespace}": value looks like a credential (${secret.kind}) and cannot be stored`,
      );
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(value ?? null) ?? "null";
    } catch (err) {
      throw new DurableStateLimitError(
        `Durable memory rejected slot "${namespace}": value is not serializable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const bytes = utf8ByteLength(serialized);
    if (bytes > this.bounds.maxValueBytes) {
      throw new DurableStateLimitError(
        `Durable memory rejected slot "${namespace}": value is ${bytes} bytes, over the ${this.bounds.maxValueBytes}-byte limit`,
      );
    }

    if (!this.slots.has(namespace) && this.slots.size >= this.bounds.maxSlots) {
      throw new DurableStateLimitError(
        `Durable memory rejected slot "${namespace}": the session already holds ${this.slots.size} slots, at the ${this.bounds.maxSlots}-slot limit`,
      );
    }

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

  snapshot(): ReadonlyMap<string, unknown> {
    // Defensive copy so a caller can't mutate the store's slot map for the turn.
    return new Map(this.slots);
  }
}

/** Shared empty snapshot for the Noop store — reused so it allocates nothing per turn. */
const EMPTY_SLOTS_SNAPSHOT: ReadonlyMap<string, unknown> = new Map();

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
  snapshot: () => EMPTY_SLOTS_SNAPSHOT,
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
 *
 * SUBAGENT ISOLATION (#3756, PRD #3752): working memory is per-session and
 * NEVER crosses the parent/subagent boundary. A delegated child run passes
 * `subagent: true`, which forces the Noop store UNCONDITIONALLY — short-circuited
 * before the conversation/internal-DB checks AND before any load query — so the
 * child:
 *   - starts EMPTY: it never loads the parent's persisted slots (a read of a
 *     parent-written slot returns the declared default / `undefined`), and
 *   - cannot reach back: the Noop store's `set` is a no-op (nothing is ever
 *     staged dirty) and the agent loop's commit path early-returns on the store's
 *     `available === false`, so no upsert is ever issued.
 * The isolation is structural at this build seam — a subagent run never
 * CONSTRUCTS a `LiveDurableStateStore`, so the parent's session key never reaches
 * a child store; there is no representable child store keyed to a parent session.
 */
export async function buildDurableStateStore(args: {
  conversationId: string | null;
  orgId: string | null;
  active: boolean;
  /**
   * `true` for a delegated subagent run — forces the Noop store so the child
   * starts empty and can never read or write the parent's session memory
   * (#3756). Absent / `false` ⇒ a normal (parent / top-level) run.
   */
  subagent?: boolean;
}): Promise<DurableStateStore> {
  if (args.subagent || !args.active || !args.conversationId || !hasInternalDB()) {
    return NOOP_DURABLE_STATE_STORE;
  }
  const initial = await loadSessionMemory(args.conversationId);
  // Resolve the caps ONCE per turn against the session's org (so the per-
  // workspace settings override is honored), then carry them on the store so a
  // write doesn't re-read settings on the hot path. Hot-reload is per-turn — a
  // mid-turn settings change applies on the next turn's build (#3757).
  const orgId = args.orgId ?? undefined;
  const bounds: MemoryBounds = {
    maxSlots: getMemoryMaxSlots(orgId),
    maxValueBytes: getMemoryMaxValueBytes(orgId),
  };
  return new LiveDurableStateStore(args.conversationId, args.orgId, initial, bounds);
}

// ── Deterministic prompt threading (#3755, ADR-0020, slice 2) ──────────────────

/**
 * Heading of the working-memory block threaded into the system prompt. Exported
 * so a test can pin the deterministic position without matching prose.
 */
export const DURABLE_MEMORY_BLOCK_HEADING = "## Working Memory";

const DURABLE_MEMORY_BLOCK_PREAMBLE =
  "Values you recorded earlier in this conversation, carried forward automatically. " +
  "Treat them as authoritative and use them directly — do NOT re-derive or re-look-up " +
  "anything already recorded here.";

/**
 * Render a single slot value for the memory block. Fail-soft: a circular / non-
 * serializable value yields a placeholder rather than throwing and stranding the
 * whole prompt (`JSON.stringify` is the only throw site). `?? null` keeps an
 * explicit `undefined` valid, mirroring {@link commitSessionMemory}; compact JSON
 * is unambiguous across strings, numbers, and nested objects alike. The `?? "…"`
 * also covers the non-throwing case where `JSON.stringify` returns the JS value
 * `undefined` (a top-level function/symbol) so a stray literal `"undefined"`
 * never lands in the block — defensive only: a loaded snapshot is JSONB-parsed
 * data, which is never a function/symbol.
 */
function renderSlotValue(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "[unserializable]";
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Durable memory slot value is not serializable — rendering placeholder",
    );
    return "[unserializable]";
  }
}

/**
 * Render the deterministic working-memory block for prompt assembly (#3755).
 *
 * Returns the block as one markdown section, or `""` when there are no slots — an
 * empty store (Noop / no internal DB / nothing written yet) threads NOTHING, so
 * the assembled prompt is byte-identical to today (no empty block). Slots are
 * sorted by name so the block is STABLE regardless of load/insertion order (the
 * load query carries no `ORDER BY`); a stable rendering keeps the prompt cache
 * warm across turns that don't mutate memory.
 *
 * The agent loop threads this into the SYSTEM prompt — passed to the model
 * separately from the message transcript — so a context-compaction pass (#3759),
 * which only rewrites the message array, can never summarize or evict it. That
 * out-of-band placement is the critical invariant of this slice (ADR-0020).
 */
export function renderDurableMemoryBlock(slots: ReadonlyMap<string, unknown>): string {
  if (slots.size === 0) return "";
  const lines = [...slots.keys()]
    .sort()
    .map((name) => `- \`${name}\`: ${renderSlotValue(slots.get(name))}`);
  return `${DURABLE_MEMORY_BLOCK_HEADING}\n\n${DURABLE_MEMORY_BLOCK_PREAMBLE}\n\n${lines.join("\n")}`;
}

// ── Read / reset affordance (admin + in-conversation) — #3758, ADR-0020 ────────
//
// The slots a session accumulates are otherwise invisible + sticky: a wrong
// remembered fact ("the user means EU revenue") rides every subsequent turn with
// no way to see or clear it. These helpers back two surfaces — an admin
// view/reset (org-scoped) and an in-conversation reset (the owner clears their
// own chat). Tenant scoping is enforced by JOINing to `conversations`: a
// read/reset only touches slots whose owning conversation matches the caller's
// scope, so neither surface can reach another org's (or another user's) memory.
// Unlike `commitSessionMemory`, these are AWAITED (not the fire-and-forget
// circuit-breaker path) so a reset is observable on the very next read — the
// runAgent seam (`loadSessionMemory` at turn start) then threads nothing.
// Noop-safe: no internal DB → empty read, zero-clear reset, no throw — behavior
// identical to today.

// The read/reset surfaces produce the shared wire shapes {@link SessionMemorySlot}
// / {@link SessionMemoryView} from `@useatlas/types` directly — no api-local
// re-declaration — so the producer is compiler-pinned to the same type the route
// validates against (`SessionMemoryViewSchema`), and a new wire field can't drift
// the producer out of sync.

/**
 * Ownership scope a scoped read/reset is bound to (see {@link conversationScopeClause}).
 *
 * The two surfaces are distinguished structurally by whether a `userId` is
 * present, NOT by a remembered flag — so the unsafe state ("admin scope that
 * forgot to be strict") is unrepresentable:
 *   - `userId` present (the in-conversation OWNER surface): the row is pinned to
 *     that user, so the `org_id IS NULL` legacy fallback is safe and applied.
 *   - `userId` absent (the ADMIN surface, org-only): the org match is STRICT
 *     (`c.org_id = $`, no NULL fallback) so it can never reach another tenant's
 *     legacy NULL-org conversation.
 */
interface ConversationScope {
  readonly userId?: string | null;
  readonly orgId?: string | null;
}

/**
 * Build the conversation-ownership WHERE suffix shared by the scoped read/reset,
 * mirroring `scopeClause` in lib/conversations.ts but against the joined
 * `conversations c` alias. Soft-deleted conversations are always excluded. With
 * neither id (auth disabled / self-hosted no-auth) the scope is just the
 * soft-delete guard — matching the unscoped behavior of the conversations CRUD
 * helpers when auth is off. The returned `sql` is never empty, so callers append
 * it after `AND` safely.
 */
function conversationScopeClause(
  startIdx: number,
  scope: ConversationScope,
): { sql: string; params: unknown[] } {
  const parts = ["c.deleted_at IS NULL"];
  const params: unknown[] = [];
  // Each placeholder index is `startIdx + (params already pushed)`, derived just
  // before pushing — no mutable counter, so adding/removing a clause can't desync.
  if (scope.userId) {
    parts.push(`c.user_id = $${startIdx + params.length}`);
    params.push(scope.userId);
  }
  if (scope.orgId) {
    const ph = startIdx + params.length;
    // The `org_id IS NULL` legacy fallback is sound ONLY when a userId also pins
    // the row (owner surface). An org-only scope (admin) stays strict, so it can
    // never reach another tenant's legacy NULL-org conversation — the strictness
    // derives from the surface, not a caller-supplied flag that could be forgotten.
    parts.push(
      scope.userId ? `(c.org_id = $${ph} OR c.org_id IS NULL)` : `c.org_id = $${ph}`,
    );
    params.push(scope.orgId);
  }
  return { sql: parts.join(" AND "), params };
}

/** Coerce a pg `timestamptz` (a `Date`, or an already-stringified value) to an ISO-8601 string. */
function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Read one session's persisted slots, ownership-scoped. Returns `[]` when the
 * conversation is outside the caller's scope (a cross-org / cross-user read sees
 * nothing — no existence oracle), already empty, or there is no internal DB.
 * Fail-soft: a query failure logs + yields `[]`.
 */
export async function readSessionMemorySlots(args: {
  conversationId: string;
  userId?: string | null;
  orgId?: string | null;
}): Promise<SessionMemorySlot[]> {
  if (!hasInternalDB()) return [];
  const scope = conversationScopeClause(2, args);
  try {
    const rows = await internalQuery<{ namespace: string; value: unknown; updatedAt: unknown }>(
      `SELECT m.namespace, m.value, m.updated_at AS "updatedAt"
         FROM agent_session_memory m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1 AND ${scope.sql}
        ORDER BY m.namespace`,
      [args.conversationId, ...scope.params],
    );
    return rows.map((r) => ({ namespace: r.namespace, value: r.value, updatedAt: toIso(r.updatedAt) }));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId: args.conversationId },
      "Failed to read durable session memory slots",
    );
    return [];
  }
}

/**
 * List every session in the org that has accumulated memory, each with its
 * slots — the admin overview, most-recently-active first. Strict org scope
 * (never another tenant's legacy NULL-org rows). Noop-safe → `[]`; fail-soft →
 * `[]`.
 */
export async function listSessionMemory(orgId: string): Promise<SessionMemoryView[]> {
  if (!hasInternalDB()) return [];
  try {
    const rows = await internalQuery<{
      conversationId: string;
      title: string | null;
      namespace: string;
      value: unknown;
      updatedAt: unknown;
    }>(
      `SELECT m.conversation_id AS "conversationId", c.title, m.namespace, m.value, m.updated_at AS "updatedAt"
         FROM agent_session_memory m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.org_id = $1 AND c.deleted_at IS NULL
        ORDER BY m.conversation_id, m.namespace`,
      [orgId],
    );
    type MutableView = {
      conversationId: string;
      title: string | null;
      updatedAt: string;
      slots: SessionMemorySlot[];
    };
    const bySession = new Map<string, MutableView>();
    for (const row of rows) {
      const updatedAt = toIso(row.updatedAt);
      let view = bySession.get(row.conversationId);
      if (!view) {
        view = { conversationId: row.conversationId, title: row.title, updatedAt, slots: [] };
        bySession.set(row.conversationId, view);
      }
      view.slots.push({ namespace: row.namespace, value: row.value, updatedAt });
      // The session's updatedAt tracks its most recently written slot. ISO-8601
      // strings sort lexically, so a plain compare picks the latest.
      if (updatedAt > view.updatedAt) view.updatedAt = updatedAt;
    }
    return [...bySession.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to list durable session memory",
    );
    return [];
  }
}

// ── Session sweep (#3757) — memory rides the agent_runs retention window ───────
//
// "Swept with its session": a session's working memory must not outlive the
// session. It already FK-cascades on `conversations` deletion (migration 0145),
// but the durable-session RETENTION sweep deletes terminal `agent_runs` rows
// while the conversation lives on — so memory would survive the runs it belongs
// to. This sweep closes that gap on the SAME hourly fiber + SAME retention
// window as `sweepTerminalAgentRuns` (no separate sweeper/scheduler): it deletes
// memory for sessions whose runs are ALL terminal (no `running`/`parked` run is
// live) and whose newest run is past the window. It runs BEFORE the runs sweep
// in the tick (layers.ts) so the terminal runs are still present to date the
// session; a session with a live run keeps its memory (still in use).

/**
 * Delete working memory for sessions past the retention window — those whose
 * `agent_runs` are ALL terminal (`done`/`failed`) and whose most-recent run is
 * older than the window. A session with ANY non-terminal (`running`/`parked`)
 * run is never swept (its memory is still the live working set). Returns the
 * number of memory rows deleted, or -1 on error (mirrors
 * {@link sweepTerminalAgentRuns}). No-op without an internal DB.
 *
 * A conversation with NO `agent_runs` rows at all (durability was off, so memory
 * was never written either, OR the runs were already swept) is intentionally not
 * matched here — there is nothing to age it against. Such memory is cleaned up
 * by the FK cascade when the conversation itself is deleted.
 */
// Exported (the SQL) for the real-Postgres sweep test so it exercises the EXACT
// interval/DELETE the helper runs, not a hand-copied reimplementation.
export const SESSION_MEMORY_SWEEP_SQL =
  `DELETE FROM agent_session_memory m
     WHERE EXISTS (
             SELECT 1 FROM agent_runs r
              WHERE r.conversation_id = m.conversation_id
            )
       AND NOT EXISTS (
             SELECT 1 FROM agent_runs r
              WHERE r.conversation_id = m.conversation_id
                AND r.status IN ('running', 'parked')
            )
       AND ($1 || ' days')::interval < now() - (
             SELECT max(r.updated_at) FROM agent_runs r
              WHERE r.conversation_id = m.conversation_id
            )
   RETURNING m.conversation_id`;

export async function sweepExpiredSessionMemory(retentionDays: number): Promise<number> {
  if (!hasInternalDB()) return 0;
  const days =
    Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_RETENTION_DAYS;
  try {
    const rows = await internalQuery<{ conversation_id: string }>(SESSION_MEMORY_SWEEP_SQL, [
      String(days),
    ]);
    // RETURNING is one row per deleted memory SLOT (the table is keyed on
    // (conversation_id, namespace)), so this is a count of ROWS, not sessions —
    // a session with N slots contributes N. Log the noun accurately; the return
    // value is documented as "memory rows deleted".
    const count = rows.length;
    if (count > 0) {
      log.info(
        { rowCount: count, retentionDays: days },
        "Swept expired working-memory rows for terminal sessions past retention window",
      );
    }
    return count;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to sweep expired session memory",
    );
    return -1;
  }
}

/**
 * Clear a session's slots (all, or a single `namespace`), ownership-scoped +
 * idempotent. Returns the number of slots cleared — `0` when the conversation is
 * outside the caller's scope, already empty, the namespace is absent, or there
 * is no internal DB (so a Noop reset is a clean no-op, never an error). Awaited
 * (not the fire-and-forget commit path) so the very next read deterministically
 * sees empty and the next turn threads nothing. Fail-soft → `0`.
 */
export async function resetSessionMemory(args: {
  conversationId: string;
  userId?: string | null;
  orgId?: string | null;
  namespace?: string;
}): Promise<number> {
  if (!hasInternalDB()) return 0;
  const scope = conversationScopeClause(2, args);
  const params: unknown[] = [args.conversationId, ...scope.params];
  let namespaceClause = "";
  if (args.namespace !== undefined) {
    namespaceClause = ` AND m.namespace = $${params.length + 1}`;
    params.push(args.namespace);
  }
  try {
    const rows = await internalQuery<{ namespace: string }>(
      `DELETE FROM agent_session_memory m
         USING conversations c
        WHERE m.conversation_id = c.id
          AND m.conversation_id = $1
          AND ${scope.sql}${namespaceClause}
       RETURNING m.namespace`,
      params,
    );
    return rows.length;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId: args.conversationId },
      "Failed to reset durable session memory",
    );
    return 0;
  }
}
