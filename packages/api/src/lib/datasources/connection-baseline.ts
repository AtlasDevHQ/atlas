/**
 * Baseline-profile orchestration (#4509) — the seam that turns a connection into
 * a tracked baseline profile:
 *
 *   • {@link profileConnectionOnCreate} — the on-create hook. Called from the
 *     native datasource-install seam (`WorkspaceInstaller.installDatasource`)
 *     when a connection is created. Capability-gated: a *profilable* connection
 *     (native pg/mysql or a plugin that builds a connection) kicks off a
 *     background baseline; a REST/OpenAPI or OAuth-managed type is skipped. Never
 *     blocks or fails the install. Connections that persist through the plugin
 *     form-install spine instead (which bypasses `installDatasource`) are covered
 *     by the lazy backfill below.
 *
 *   • {@link ensureConnectionBaseline} — the lazy backfill. A pre-existing
 *     unprofiled connection is baseline-profiled the first time something needs
 *     it (a briefing, the coverage view), NOT via a bulk sweep. A no-op when a
 *     baseline already exists.
 *
 *   • {@link runBaselineProfile} — resolve the live connection → run the
 *     deterministic profiler → store the payload; a failure is recorded as a
 *     VISIBLE `baseline_error`, never silent.
 *
 * The store (DB seam) is `lib/semantic/connection-profile.ts`. Dependencies are
 * injectable so the hook + run seams are unit-testable without a live DB or a
 * real connection.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import type {
  ProfileCapability,
  ResolveLiveConnectionResult,
} from "@atlas/api/lib/datasources/mcp-lifecycle";
import {
  claimBaselineSlot,
  getConnectionProfileState,
  recordBaselineError,
  upsertBaselineProfile,
  type ConnectionProfileState,
} from "@atlas/api/lib/semantic/connection-profile";

const log = createLogger("datasources:connection-baseline");

// Lazy-import the mcp-lifecycle resolvers so this module's static graph stays
// light (db/internal + the store) — the heavy `mcp-lifecycle` graph is pulled
// only when a default dependency is actually invoked, mirroring how
// `profiling-connection.ts` keeps that graph out of its consumers' load path.
// Tests inject `deps` and never touch these.
async function defaultResolveCapability(dbType: string): Promise<ProfileCapability> {
  const { resolveProfileCapabilityByDbType } = await import("@atlas/api/lib/datasources/mcp-lifecycle");
  return resolveProfileCapabilityByDbType(dbType);
}
async function defaultResolveConnection(
  orgId: string,
  installId: string,
): Promise<ResolveLiveConnectionResult> {
  const { resolveLiveConnection } = await import("@atlas/api/lib/datasources/mcp-lifecycle");
  return resolveLiveConnection(orgId, installId);
}

/** Identity + type of the connection to baseline-profile. */
export interface BaselineProfileTarget {
  readonly orgId: string;
  readonly installId: string;
  readonly connectionGroupId?: string | null;
  readonly dbType: string;
}

/** Whether a dbType is baseline-profilable, from the unified profiler capability. */
export interface BaselinePlan {
  readonly profilable: boolean;
  readonly capabilityKind: ProfileCapability["kind"];
}

/**
 * Decide whether a dbType gets a baseline profile — the connection-creation hook
 * seam's policy, keyed on the SAME `resolveProfileCapabilityByDbType` predicate
 * provisioning + live-connection resolution use, so "profilable at create" can
 * never drift from "profilable at query/profile time". REST/OpenAPI and OAuth-
 * managed types resolve to `unsupported` → not profilable.
 */
export async function planConnectionBaseline(
  dbType: string,
  deps: {
    resolveCapability?: (dbType: string) => Promise<ProfileCapability>;
  } = {},
): Promise<BaselinePlan> {
  const resolveCapability = deps.resolveCapability ?? defaultResolveCapability;
  const capability = await resolveCapability(dbType);
  return { profilable: capability.kind !== "unsupported", capabilityKind: capability.kind };
}

/**
 * Resolve the connection's live introspection surface and run the deterministic
 * baseline profiler (schema/types/counts/samples), storing the payload. A
 * resolution or profiling failure is recorded as a VISIBLE `baseline_error`
 * (DSN-scrubbed via {@link errorMessage} — the raw driver message can echo the
 * connection string). This function NEVER throws: an unexpected resolver throw
 * or a DB-write failure is logged (and best-effort recorded), never propagated —
 * `ensureConnectionBaseline` awaits it inline off a briefing/coverage render,
 * which must not fail on an infra hiccup. The lazy backfill retries on next need.
 */
export async function runBaselineProfile(
  target: BaselineProfileTarget,
  deps: {
    resolveConnection?: (orgId: string, installId: string) => Promise<ResolveLiveConnectionResult>;
  } = {},
): Promise<void> {
  if (!hasInternalDB()) return; // nowhere to store the baseline
  const resolveConnection = deps.resolveConnection ?? defaultResolveConnection;

  try {
    const resolved = await resolveConnection(target.orgId, target.installId);
    if (resolved.kind !== "ok") {
      // The non-ok variants are exhaustive: `not_found` (no message) plus
      // `unsupported` / `reconnect_required` (both carry an actionable message).
      const reason = resolved.kind === "not_found" ? "the connection was not found" : resolved.message;
      await recordBaselineError({
        orgId: target.orgId,
        installId: target.installId,
        connectionGroupId: target.connectionGroupId,
        dbType: target.dbType,
        error: `Baseline profile could not resolve a live connection: ${reason}.`,
      });
      return;
    }

    const conn = resolved.connection;
    try {
      const result = await conn.profile({ logger: log });
      await upsertBaselineProfile({
        orgId: target.orgId,
        installId: target.installId,
        // Prefer the resolved connection's own group scope when the caller didn't
        // thread one (it is authoritative for the built connection).
        connectionGroupId: target.connectionGroupId ?? conn.connectionGroupId,
        dbType: target.dbType,
        profiles: result.profiles,
      });
      if (result.errors.length > 0) {
        log.info(
          { installId: target.installId, failed: result.errors.length, profiled: result.profiles.length },
          "Baseline profile completed with per-table failures below the abort threshold",
        );
      }
    } catch (err) {
      // Profiling threw — scrub before storing: a pg/mysql driver error message
      // can echo the DSN, one column away from an agent-visible briefing.
      await recordBaselineError({
        orgId: target.orgId,
        installId: target.installId,
        connectionGroupId: target.connectionGroupId,
        dbType: target.dbType,
        error: errorMessage(err),
      });
    } finally {
      // Log (don't swallow) a close failure so a pool leak is visible without
      // failing the baseline (CLAUDE.md: no empty catch).
      await conn.close().catch((closeErr) =>
        log.warn(
          { err: errorMessage(closeErr), installId: target.installId },
          "Baseline profile: connection close failed",
        ),
      );
    }
  } catch (err) {
    // A thrown resolver (the default `resolveLiveConnection` throws on some
    // OAuth/reconnect paths) or a DB write that itself failed. Log it and make a
    // best-effort visible record — but never let a second failure escape.
    const message = errorMessage(err);
    log.warn({ err: message, installId: target.installId }, "Baseline profile failed unexpectedly");
    try {
      await recordBaselineError({
        orgId: target.orgId,
        installId: target.installId,
        connectionGroupId: target.connectionGroupId,
        dbType: target.dbType,
        error: message,
      });
    } catch (recordErr) {
      log.warn(
        { err: errorMessage(recordErr), installId: target.installId },
        "Baseline profile: could not record the failure reason",
      );
    }
  }
}

/**
 * Lazily backfill a connection's baseline profile — the "on first need" path for
 * a pre-existing unprofiled connection (a briefing, the coverage view). Memoizes
 * SUCCESS: returns the current state without re-profiling once a successful
 * baseline exists. A connection whose last attempt only FAILED (error row, no
 * success facts) is re-attempted, so a fixed-permission connection recovers on
 * the next need — callers should therefore invoke this on genuine need (a page
 * load), not on every conversational turn. This is one connection on demand, NOT
 * a bulk sweep. Returns `null` when there's no internal DB. Never throws
 * ({@link runBaselineProfile} is total).
 *
 * IN-FLIGHT DEDUP (migration 0174): before profiling, an atomic
 * {@link claimBaselineSlot} claims the connection. If the claim is lost — another
 * caller (this poll, another replica) already has a fresh claim in flight — this
 * returns the current state WITHOUT running a second profile. This is what stops
 * the coverage view's 4-second poll from launching overlapping full-schema
 * profiles that exhaust the target database's connection limit; the DB claim (not
 * an in-process mutex) makes the dedup hold across replicas.
 */
export async function ensureConnectionBaseline(
  target: BaselineProfileTarget,
  deps: {
    resolveConnection?: (orgId: string, installId: string) => Promise<ResolveLiveConnectionResult>;
    // Derived from the concrete signature (minus the caller-irrelevant TTL knob)
    // so the injectable can't drift from `claimBaselineSlot` — a renamed/added
    // required field breaks this at compile time rather than at runtime.
    claimSlot?: (input: Omit<Parameters<typeof claimBaselineSlot>[0], "ttlSeconds">) => Promise<boolean>;
  } = {},
): Promise<ConnectionProfileState | null> {
  // Total by contract: the two state reads (not just the profile run) are
  // wrapped so a transient internal-DB read failure degrades to `null` rather
  // than rejecting a briefing/coverage render (CLAUDE.md: never a 500 from a
  // read hiccup on a degradable surface).
  try {
    const existing = await getConnectionProfileState(target.orgId, target.installId);
    if (existing?.baseline) return existing; // successful baseline already — no re-run
    // Claim the in-flight slot atomically. A lost claim means another attempt is
    // already running (this poll re-fired, or a peer replica) — do NOT re-storm.
    const claimSlot = deps.claimSlot ?? claimBaselineSlot;
    const claimed = await claimSlot({
      orgId: target.orgId,
      installId: target.installId,
      connectionGroupId: target.connectionGroupId,
      dbType: target.dbType,
    });
    // Intentionally returns the pre-claim `existing` snapshot: if a peer replica
    // finished a baseline in the read→claim window, the coverage view's next 4s
    // poll converges — cheaper than an extra round-trip re-read here.
    if (!claimed) return existing;
    await runBaselineProfile(target, deps);
    return await getConnectionProfileState(target.orgId, target.installId);
  } catch (err) {
    // The try now spans the state read, the claim WRITE, and the profile run —
    // name all three so a claim/profile write failure isn't mislabelled as a read.
    log.warn(
      { err: errorMessage(err), installId: target.installId },
      "ensureConnectionBaseline failed (state read / claim / profile) — returning null",
    );
    return null;
  }
}

/** Outcome of the on-create hook — observable so the creation seam + tests can assert. */
export type OnCreateBaselineDecision =
  | { readonly action: "scheduled" }
  | {
      readonly action: "skipped";
      readonly reason: "not-profilable" | "no-internal-db" | "error" | "already-profiling";
    };

/**
 * On-create hook: baseline-profile a newly-created profilable connection without
 * operator action. Capability-gated (REST/OpenAPI + OAuth-managed types are
 * skipped) and FIRE-AND-FORGET — the baseline runs in the background so it never
 * blocks or fails the install; its own success/failure is recorded durably and
 * the lazy backfill retries on first need. Never throws.
 *
 * Claims the in-flight slot (migration 0174) BEFORE scheduling, so the create
 * hook and a concurrent coverage-view backfill can't both profile the same fresh
 * connection — the claim collapses ALL profile initiators to one, not just the
 * poll re-fires. A lost claim means a peer is already profiling → skip.
 */
export async function profileConnectionOnCreate(
  target: BaselineProfileTarget,
  deps: {
    resolveCapability?: (dbType: string) => Promise<ProfileCapability>;
    runBaseline?: (target: BaselineProfileTarget) => Promise<void>;
    claimSlot?: (input: Omit<Parameters<typeof claimBaselineSlot>[0], "ttlSeconds">) => Promise<boolean>;
  } = {},
): Promise<OnCreateBaselineDecision> {
  try {
    if (!hasInternalDB()) return { action: "skipped", reason: "no-internal-db" };
    const plan = await planConnectionBaseline(target.dbType, deps);
    if (!plan.profilable) return { action: "skipped", reason: "not-profilable" };

    // Claim before scheduling — a concurrent lazy backfill would otherwise launch
    // a second profile of the same connection. runBaselineProfile releases the
    // claim on its terminal write (success upsert / recorded error).
    const claimSlot = deps.claimSlot ?? claimBaselineSlot;
    if (!(await claimSlot(target))) return { action: "skipped", reason: "already-profiling" };

    const runBaseline = deps.runBaseline ?? runBaselineProfile;
    void runBaseline(target).catch((err) =>
      log.warn(
        { err: err instanceof Error ? err.message : String(err), installId: target.installId },
        "Baseline profile on create failed to run in background",
      ),
    );
    return { action: "scheduled" };
  } catch (err) {
    // The hook must never break a connection install. A capability-lookup or
    // scheduling error is logged, not thrown; the lazy backfill covers it later.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), installId: target.installId, dbType: target.dbType },
      "Baseline profile on create hook errored — deferring to lazy backfill",
    );
    return { action: "skipped", reason: "error" };
  }
}
