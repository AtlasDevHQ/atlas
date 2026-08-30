/**
 * Stage-0 triage oversight and the re-queue verb (#5534).
 *
 * Mounted under `/api/v1/admin/brain-triage`:
 *
 *   GET  /        — what the gate is holding, per rule, plus the rule list
 *   POST /requeue — clear those marks, all rules or one, and say how many
 *
 * ## Why this is an ADMIN ROUTE and not an `atlas-operator` subcommand
 *
 * #5534's fourth acceptance criterion asks for the decision to be made and
 * recorded rather than defaulted into. Three reasons, in the order they bind:
 *
 * **1. The audit obligation is only satisfiable here.** The act's second
 * criterion is "who re-queued, which rule scope, how many rows", and after the
 * write no query can answer it — clearing a mark NULLs both triage columns, so
 * `brain_episodes` keeps no trace the rows were ever triaged. The audit row is
 * the whole record. The operator binary talks to tenant Postgres directly with
 * no request context and no admin principal; its subcommands audit as
 * `systemActor: "system:atlas-operator"`, which records that SOME operator ran
 * something. For an act whose only record is that row, "an operator" is not an
 * answer to "who".
 *
 * **2. It is not an operator-shaped act.** ADR-0025 step 4 (#4045) split the
 * binary out so the workspace-facing CLI "never ships tenant-destructive
 * direct-DB tooling", and what landed there matches: `ops wipe`,
 * `teardown-verify-accounts`, `gate-export` — destructive, cross-tenant, or
 * outside the gate chain. Re-queueing is none of those: single-workspace,
 * additive (it restores a queue position, deletes nothing), and something the
 * WORKSPACE's own admin is the right person to judge, because the judgement is
 * "our ack list was wrong" or "that rule is eating our messages". Routing it
 * through an operator would make a tenant open a support ticket to undo a
 * default-off gate we turned on for them.
 *
 * **3. The numbers that motivate it are already an admin surface.** The issue
 * is explicit that a re-queue "belongs near the numbers that motivate it".
 * `GET /` is those numbers; the verb is one POST away from them, in one
 * session, for the person who read them.
 *
 * ⚠️ NOT "both". A second entry point would be a second audit vocabulary for
 * one act, and the operator arm would be the one that cannot say who. If an
 * operator ever needs to re-queue on a tenant's behalf, the answer is the
 * existing support path onto the admin surface, not a second writer.
 *
 * ## Its own router, not two more routes on `admin-brain-facts.ts`
 *
 * Every read on that router is READER-scoped against the caller's grants, and
 * its one unscoped surface (`/oversight`) is fenced by a module-level rule that
 * forbids selecting "anything off `brain_episodes`". Triage is episode-grained
 * and workspace-scoped, so both routes here would be exceptions to the
 * neighbouring file's stated invariants. `lib/brain/triage-requeue.ts` carries
 * the same argument for the store layer.
 *
 * ## What this router adds to the admin app's module graph
 *
 * `lib/brain/triage-requeue.ts` imports `extract.ts` for the re-queue statement
 * (composing it, rather than keeping a second copy — see that module), and this
 * file imports the gate's own switch from there. `admin.ts` is imported
 * eagerly, so that makes `extract.ts` reachable from the admin API for the
 * first time; `lib/effect/layers.ts` deliberately reaches it through `require`
 * to keep the extraction fiber lazy, so the question is fair.
 *
 * Measured rather than worried about: 600 → 607 modules, and four of the seven
 * are the triage/extract files themselves. The heavy shared graph underneath —
 * `reconcile.ts`, `identity.ts`, `lib/db` — was already reachable through
 * `admin-brain-facts.ts`. Restructuring to save four modules would mean moving
 * a statement out of the module that owns the drain it undoes, which costs more
 * than it buys. Re-measure before adding a fifth edge into `lib/brain/extract`.
 *
 * ## Counts without content, on a table that holds raw text
 *
 * `brain_episodes.body` is the rawest content Atlas stores — whatever a chat
 * channel said, gated by no claim-level review. Nothing on this router selects
 * it, or the locator, actor, source id, or episode id. What travels is a count
 * and a rule id, and a rule id says only "some deterministic rule matched this
 * episode's shape" — the same thing `TRIAGE_RULES` says in public. The wire
 * schemas are `z.strictObject`, so a producer that later attached a sample
 * fails at this boundary rather than in a browser.
 */

import { Effect } from "effect";
import { createRoute } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { TRIAGE_RULES } from "@atlas/api/lib/brain/triage";
import { isBrainExtractionTriageEnabled } from "@atlas/api/lib/brain/extract";
import {
  isKnownTriageRule,
  loadTriageBacklog,
  requeueTriagedEpisodes,
} from "@atlas/api/lib/brain/triage-requeue";
// The BARREL, like `admin-brain-facts.ts` — not the two leaf modules. The route
// tests `mock.module` `@atlas/api/lib/audit`, so a leaf import walks past the
// double and writes a real row.
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type {
  AuthMode,
  BrainTriageBacklogResponse,
  BrainTriageRequeueRequest,
  BrainTriageRequeueResponse,
} from "@useatlas/types";
import {
  BRAIN_TRIAGE_RULE_MAX_CHARS,
  BrainTriageBacklogResponseSchema,
  BrainTriageRequeueRequestSchema,
  BrainTriageRequeueResponseSchema,
} from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, noActiveOrgBody, requireOrgContext } from "./admin-router";

const log = createLogger("admin-brain-triage");

/** `admin-brain-facts.ts`'s `checked`, one surface over, and for its reason. */
function checked<T>(schema: { parse: (value: unknown) => T }, payload: unknown): T {
  return schema.parse(payload);
}

/** `admin-brain-facts.ts`'s `reviewerContext`, one surface over. */
function readerContext(
  mode: AuthMode,
  user: AtlasUser | undefined,
  orgId: string,
  requestId: string,
) {
  return Effect.tryPromise({
    try: () =>
      resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });
}

/**
 * The owner/admin bar, returning the WORKSPACE to act on or `null` —
 * `sweepTarget`'s shape in `admin-brain-facts.ts`, and for both of its reasons.
 *
 * Returning the target rather than a boolean is what makes "the workspace I
 * verified" and "the workspace I re-queued" one binding instead of two reads
 * that agree by habit. Switching on the ORIGIN rather than writing a role test
 * with a null guard is what makes a fourth arm on `BrainPrincipalContext` a
 * compile error here rather than an inherited default.
 *
 * ⚠️ Applied to the READ as well as the write, where the fact router applies it
 * to the write only. `adminAuth` gates this router on the SESSION's role, which
 * does not know which workspace is being read, so an admin of another org
 * clears it; the re-resolved context does not. The bar is the same on both
 * verbs because the read exists to arm the write — an admin who may not clear a
 * rule's marks has no use for its backlog, and a lower bar on the count would
 * be a way to learn how much a workspace's gate is holding without the
 * entitlement to do anything about it.
 */
function triageTarget(ctx: BrainPrincipalContext): string | null {
  switch (ctx.origin) {
    case "authenticated":
      return ctx.role === "owner" || ctx.role === "admin" ? ctx.workspaceId : null;
    case "unauthenticated-local":
      return ctx.workspaceId;
    case "unresolved":
      return null;
  }
}

/** Why a reader may not see or clear the triage backlog. */
function triageDenialMessage(ctx: BrainPrincipalContext): string {
  return ctx.origin === "authenticated"
    ? `Managing the extraction triage backlog needs the owner or admin entitlement; this reader is ` +
        `"${ctx.role ?? "no org role"}". Re-queueing puts episodes back in front of the extraction ` +
        "model, which spends model calls against this workspace, and the count exists to arm that decision."
    : `Managing the extraction triage backlog needs a resolved reader identity; this one is "${ctx.origin}".`;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const commonResponses = {
  400: {
    description: "Invalid request — unknown rule id or no active organization",
    content: { "application/json": { schema: ErrorSchema } },
  },
  401: {
    description: "Authentication required",
    content: { "application/json": { schema: AuthErrorSchema } },
  },
  403: {
    description: "Forbidden — the owner or admin entitlement is required",
    content: { "application/json": { schema: AuthErrorSchema } },
  },
  404: {
    description: "Internal database not configured",
    content: { "application/json": { schema: ErrorSchema } },
  },
  500: {
    description: "Internal server error",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const backlogRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Brain Triage"],
  summary: "What stage-0 extraction triage is holding",
  description:
    "Counts the episodes the deterministic pre-extraction triage gate routed out and has not released, grouped by the rule that decided each one, workspace-wide. These are episodes that never reached the extraction model and were never marked extracted — a visible backlog rather than a silent drop — and every one of them is re-queueable through `POST /requeue`. " +
    "Numbers and rule ids only: no episode body, locator, actor, source id or episode id reaches this response. A rule id discloses that some deterministic rule matched an episode's SHAPE, which is what the `rules` list beside it already states in public, and nothing about what the episode said. " +
    "`rules` is the vocabulary this deploy evaluates, in evaluation order, each with the rationale for why a matching body cannot carry a promotable claim — served here so a console does not carry a second copy that can drift from the rules the server actually runs. " +
    "⚠️ A bucket whose `known` is `false` was written by a deploy that knew a rule this one does not. It is a real backlog and it is re-queueable, but only through the all-rules arm: a per-rule request can name only a rule this deploy still evaluates. " +
    "⚠️ `enabled` reports whether the gate is currently routing episodes out at all. It is off by default, and a non-zero `total` beside `enabled: false` means marks a previous run left behind — a finite backlog, not a growing one. Reading them as the same state is the mistake this field exists to prevent. " +
    "Workspace-scoped and deliberately NOT reader-scoped: there is no claim here to gate, and composing a visibility predicate would report a smaller backlog to a reader holding fewer grants — a queue that looks drained because of who is looking, on the one surface whose job is to say it is not.",
  responses: {
    200: {
      description: "Per-rule backlog counts, the rule vocabulary, and the gate's state",
      content: { "application/json": { schema: BrainTriageBacklogResponseSchema } },
    },
    ...commonResponses,
  },
});

const requeueRoute = createRoute({
  method: "post",
  path: "/requeue",
  tags: ["Admin — Brain Triage"],
  summary: "Put triaged-out episodes back on the extraction drain",
  description:
    "Clears stage-0 triage marks so the extraction fiber picks the episodes up again at their ORIGINAL `ingested_at` position — no backfill, no repair sweep, no copy of the rows. Scoped to this workspace always, and to one rule when `rule` is given: an admin who corrects an acknowledgement list re-queues that rule's verdicts, while an admin who judges the whole gate too aggressive omits `rule` and re-queues everything. " +
    "⚠️ This spends money. Every re-queued episode is a model call the next cycles will make, and a workspace whose gate has been on for a while can be holding a large number of them — read `GET /` first, which is what the per-rule counts are for. " +
    "⚠️ Re-queueing does not change the RULES. If the rule that routed an episode out still matches it, the next cycle marks it again; the useful sequence is to change the rule (or turn the gate off) and then re-queue. " +
    "⚠️ Not undoable. The mark is set back to NULL, so nothing in the episode table records that these rows were ever triaged — the admin-action audit row this call writes is the only account of what moved, which is why a failure to write it is reported even though the re-queue itself committed. " +
    "The response carries a count and the scope, never episode ids: listing which rows a rule had held would be a workspace-wide episode projection on a surface that otherwise discloses only counts.",
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: BrainTriageRequeueRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "The marks were cleared. `requeued` is the number of episodes now back on the drain — `0` is a successful outcome meaning nothing matched the scope, not a failure",
      content: { "application/json": { schema: BrainTriageRequeueResponseSchema } },
    },
    ...commonResponses,
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const adminBrainTriage = createAdminRouter();

adminBrainTriage.use(requireOrgContext());

adminBrainTriage.openapi(backlogRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* readerContext(mode, user, orgId, requestId);
      const target = triageTarget(ctx);
      if (target === null) {
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Brain triage backlog refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          { error: "forbidden", message: triageDenialMessage(ctx), requestId },
          403,
        );
      }

      const backlog = yield* Effect.tryPromise({
        try: () => loadTriageBacklog(getInternalDB(), target),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(
        checked(BrainTriageBacklogResponseSchema, {
          total: backlog.total,
          byRule: backlog.byRule,
          // Projected from the live rule list rather than a constant, so the
          // rationale an admin reads before loosening a rule is the one beside
          // the predicate that fired. `matches` is deliberately not projected:
          // a predicate is not serialisable and a client that could see one
          // would be tempted to re-implement it.
          rules: TRIAGE_RULES.map((rule) => ({ id: rule.id, rationale: rule.rationale })),
          enabled: isBrainExtractionTriageEnabled(),
        } satisfies BrainTriageBacklogResponse),
        200,
      );
    }),
    { label: "load brain triage backlog" },
  );
});

adminBrainTriage.openapi(requeueRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* readerContext(mode, user, orgId, requestId);
      const target = triageTarget(ctx);
      if (target === null) {
        // LOGGED, like every other denial at this bar: an attempt to re-queue
        // without the entitlement is an attempt to spend a workspace's model
        // budget, which is exactly the event you want in the log.
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Brain triage re-queue refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          { error: "forbidden", message: triageDenialMessage(ctx), requestId },
          403,
        );
      }

      // `body: { required: false }`, so a bodyless POST is the all-rules arm.
      //
      // ⚠️ Measured against the pinned `@hono/zod-openapi`, because the
      // in-tree beliefs about this disagree: `admin-revoke.ts` records that
      // `c.req.valid` "would throw on an absent body" and parses by hand. What
      // actually happens on THIS shape is neither that nor `undefined` —
      // `required: false` plus no `content-type` makes zod-openapi call
      // `addValidatedData("json", {})`, so `c.req.valid("json")` is `{}`. The
      // `?? null` below is therefore the working path, not a fallback.
      //
      // ⚠️ The one shape that does NOT reach here: `content-type:
      // application/json` with an EMPTY body. The validator runs, `req.json()`
      // throws, and hono answers its own 400 ("Malformed JSON in request
      // body") with no `requestId`. That is a correct refusal of a malformed
      // request and it is deliberately not intercepted — hand-parsing to
      // reclaim the envelope would mean this route no longer validates against
      // the schema it publishes. Send no `content-type`, or send `{}`.
      //
      // `{}` and `{ rule: null }` then mean the same thing — see the request
      // schema's header on why admitting both is not a distinction without
      // meaning.
      const parsed = c.req.valid("json") as BrainTriageRequeueRequest;
      const rule = parsed.rule ?? null;

      // A typo guard, not a safety property — an unknown id can only match
      // zero rows, and the all-rules arm reaches every mark regardless. It
      // exists because the two answers are otherwise indistinguishable: an
      // admin who types `known_acks` gets `requeued: 0` and reads it as "the
      // backlog was already clear", which is the wrong lesson from a
      // successful-looking response. Named rules are echoed in the message so
      // the fix is one read away.
      //
      // ⚠️ It is deliberately NOT applied to a rule that this deploy has
      // retired: such an id never reaches here as a per-rule request, because
      // `GET /` marks its bucket `known: false` and the all-rules arm is what
      // clears it. Widening this check to accept any string the column holds
      // would mean querying the table to validate a parameter, and would admit
      // the typo it exists to catch.
      if (rule !== null && !isKnownTriageRule(rule)) {
        return c.json(
          {
            error: "unknown_triage_rule",
            message:
              `"${rule.slice(0, BRAIN_TRIAGE_RULE_MAX_CHARS)}" is not a triage rule this deploy evaluates. ` +
              `Valid rules: ${TRIAGE_RULES.map((r) => r.id).join(", ")}. ` +
              "Omit `rule` to re-queue every triaged-out episode, which is also the only arm that " +
              "reaches marks written under a rule that has since been retired.",
            requestId,
          },
          400,
        );
      }

      const { requeued } = yield* Effect.tryPromise({
        // `target`, not `orgId` — the value the entitlement was CHECKED
        // against, so "the workspace I verified" and "the workspace I
        // re-queued" are one binding rather than two reads that agree.
        try: () => requeueTriagedEpisodes(getInternalDB(), target, rule),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      // AWAITED, unlike the tension sweep's fire-and-forget row, and the
      // asymmetry is the one `actions.ts` records: the sweep's write leaves
      // `brain_edges` rows an auditor can still read, so its audit row is a
      // convenience. This write leaves NOTHING — both triage columns are back
      // to NULL — so if the row does not land, the act is unreconstructable.
      // Emitted for `requeued: 0` too, so "an admin re-queued and nothing
      // moved" is on the record rather than inferred from silence.
      const audited = yield* Effect.tryPromise({
        try: () =>
          logAdminActionAwait({
            actionType: ADMIN_ACTIONS.brain.triageRequeue,
            targetType: "brain",
            // The WORKSPACE, not an episode — the act names no single row.
            targetId: target,
            metadata: { workspaceId: target, rule, requeued },
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.as(true as const),
        Effect.catchAll((err) => {
          log.error(
            { workspaceId: target, rule, requeued, requestId, err: err.message },
            "Brain triage re-queue COMMITTED but its audit row failed to write",
          );
          return Effect.succeed(false as const);
        }),
      );

      if (!audited) {
        // 500, and the message says what happened. `logAdminActionAwait`'s
        // contract is "surface an error so the admin retries", and a bare
        // retry here would re-queue nothing (the marks are already clear) while
        // leaving the admin believing the first call did nothing — the
        // misreport `checkedWrite` exists one router over to prevent. The
        // status stays 500 because a generic client reads 200 as success and
        // the trail genuinely did not land; the message is what stops a human
        // reading it as "nothing happened".
        return c.json(
          {
            error: "audit_write_failed",
            message:
              `The re-queue COMMITTED — ${requeued} episode(s) are back on the extraction drain ` +
              `${rule === null ? "across every rule" : `for rule "${rule}"`} — but the admin-action ` +
              "audit row could not be written, and that row is the only durable record of this act. " +
              "Do not retry: the marks are already cleared, so a second call would report 0 and change " +
              "nothing. Record this manually and check the audit subsystem's health.",
            requestId,
          },
          500,
        );
      }

      return c.json(
        checked(BrainTriageRequeueResponseSchema, {
          requeued,
          rule,
        } satisfies BrainTriageRequeueResponse),
        200,
      );
    }),
    { label: "re-queue triaged brain episodes" },
  );
});

export { adminBrainTriage };
