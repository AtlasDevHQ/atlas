/**
 * EE read/write combinators — the enterprise-gate + internal-DB guard preamble,
 * composed once.
 *
 * Every EE read/write function opens with the same two-step preamble:
 *
 *   // read:
 *   yield* requireEnterpriseEffect("<feature>");   // 403 when unlicensed
 *   if (!hasInternalDB()) return []/null/0/…;        // graceful empty, no DB
 *
 *   // write:
 *   yield* requireEnterpriseEffect("<feature>");   // 403 when unlicensed
 *   yield* requireInternalDBEffect("<label>");       // fail loud, no DB
 *
 * The individual guards were extracted long ago (`requireEnterpriseEffect` in
 * `../index`, `requireInternalDBEffect` in `./db-guard`, `hasInternalDB` in
 * core); this composes the *combination* so the dozens of read/write functions
 * that re-type it stop doing so by hand. Because the gate + guard now live in
 * one wrapper rather than a hand-copied preamble, a reviewer can tell at a
 * glance whether a new gated EE query routes through it — the point is that
 * skipping the gate or DB guard becomes visually obvious in review, not that
 * it's mechanically impossible. (Deliberately-ungated helpers — public getters
 * like `getWorkspaceBrandingPublic`, provisioning-hot-path lookups like
 * `resolveGroupToRole` — stay explicit `Effect.gen`s and are the documented
 * exceptions.)
 *
 * These are leverage-via-composition, NOT a full collapse. The per-function
 * empty-value variance (`[]` vs `null` vs `0` vs `{ allowed: true }`) is
 * deliberate and passed EXPLICITLY as `whenNoDb`; likewise the write path's
 * per-module typed error is preserved via the optional `errorFactory`. This is
 * on purpose: papering over that variance — or over the per-method fail-loud
 * policies baked into the Noop layers (#2594) — would erase intended semantics.
 *
 * @module
 */

import { Effect } from "effect";
import type { EnterpriseError } from "@atlas/api/lib/effect/errors";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { requireEnterpriseEffect } from "../index";
import { requireInternalDBEffect } from "./db-guard";

/**
 * Read-path combinator: enterprise gate → internal-DB short-circuit → query.
 *
 * Runs `query` only when enterprise is enabled AND an internal DB is present.
 * When unlicensed, fails with `EnterpriseError` (never touching the DB). When
 * licensed but DB-less, returns `whenNoDb` without running `query`.
 *
 * `whenNoDb` is the per-function empty value (`[]`, `null`, `0`, `false`,
 * `{ allowed: true }`, …) and is passed explicitly — it is `NoInfer` so the
 * result type `A` is driven by `query`, and `whenNoDb` is merely checked
 * against it (e.g. `null` against `CustomRole | null`).
 *
 * @param feature - Feature label forwarded to `requireEnterpriseEffect` (drives the 403 message).
 * @param whenNoDb - Value returned when no internal DB is configured.
 * @param query - The DB-backed read; only evaluated when gate + guard pass.
 */
export const eeRead = <A, E, R>(
  feature: string,
  whenNoDb: NoInfer<A>,
  query: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | EnterpriseError, R> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect(feature);
    if (!hasInternalDB()) return whenNoDb;
    return yield* query;
  });

/**
 * Write-path combinator: enterprise gate → internal-DB requirement → query.
 *
 * Runs `query` only when enterprise is enabled AND an internal DB is present.
 * Unlike reads, the write path fails loud when DB-less rather than returning an
 * empty value: `requireInternalDBEffect(label, errorFactory)` fails with the
 * per-module typed error (`ApprovalError`, `ReportError`, …) when `errorFactory`
 * is supplied, or a plain `Error(`Internal database required for ${label}.`)`
 * otherwise — identical to the hand-written preamble.
 *
 * @param feature - Feature label forwarded to `requireEnterpriseEffect` (drives the 403 message).
 * @param label - Operation label forwarded to `requireInternalDBEffect` (drives the no-DB message).
 * @param query - The DB-backed write; only evaluated when gate + guard pass.
 * @param errorFactory - Optional factory for a domain-specific no-DB error, preserving per-module typing.
 */
export const eeWrite = <A, E, R>(
  feature: string,
  label: string,
  query: Effect.Effect<A, E, R>,
  errorFactory?: () => Error,
): Effect.Effect<A, E | EnterpriseError | Error, R> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect(feature);
    yield* requireInternalDBEffect(label, errorFactory);
    return yield* query;
  });
