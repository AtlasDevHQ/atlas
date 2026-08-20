/**
 * The **Coverage Surface**'s read (#5215, ADR-0041).
 *
 * Mounted under `/api/v1/admin/brain-coverage`:
 *
 *   GET  /  — what Atlas surveys, what it merely knows exists, and where the map ends
 *
 * ## One route, because condition 6 demands one page
 *
 * PRD condition 6 asks for one surface from which an admin states what Atlas
 * knows, how much of the company it covers, and what it does not — *"every part
 * correct, at 4% as clearly as at 80%"*. `lib/brain/coverage.ts` composes both
 * arms into a single shape (the availability arm it computes, the authority arm
 * it carries through from `oversight.ts` unchanged), and this route is the one
 * door onto it. Splitting the arms across two endpoints would let the page
 * render half a statement — and half of this statement is the flattering half.
 *
 * ## Deliberately NO new permission flag
 *
 * `adminAuth` (via `createAdminRouter`) is the whole perimeter, exactly as it is
 * for the rest of `/admin/brain`. ADR-0041 § The surface records the reason and
 * it is not laziness: the unscoped counts on this surface exist under the #4825
 * sanction argued for admins specifically, and a NEW workspace-permission flag
 * is implicitly denied to every already-seeded workspace's built-in roles — the
 * #5188 regression class, where the feature ships and nobody can see it. Making
 * coverage member-visible would be a separate decision with its own disclosure
 * argument.
 *
 * The reader context is still re-resolved per request, for
 * `admin-brain-facts.ts`'s reason: `loadCoverage`'s authority arm is
 * reader-scoped in one number (`reviewableAwaitingReview`), and an identity the
 * deploy cannot resolve must be a 500 rather than a workspace shape served to a
 * session Atlas could not identify.
 *
 * ## Read-only, and it never calls a vendor
 *
 * Every denominator on this response comes from a dated snapshot a scheduled
 * cycle wrote (`lib/brain/coverage-enumeration.ts`), never from a live vendor
 * enumeration on page view — ADR-0041 refuses to couple the page's availability
 * to five vendors' rate limits, and the "as of" date is part of the statement
 * rather than an apology for it.
 *
 * ## Why the response is parsed on the way out
 *
 * `admin-brain-facts.ts`'s `checked()`, one surface over. `BrainCoverageSchema`
 * carries the honesty identities as refinements — a denominator that is not its
 * own two states, a freshness tally that under-reports how much of a class is
 * stale, a `stale` verdict with no arithmetic behind it — so a producer that
 * broke one gets a 500 with a requestId here, rather than a page that renders
 * the flattering reading of its own disagreement.
 */

import { Effect } from "effect";
import { createRoute } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import { loadCoverage } from "@atlas/api/lib/brain/coverage";
import { BrainCoverageSchema } from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, noActiveOrgBody, requireOrgContext } from "./admin-router";

const coverageRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Brain"],
  summary: "What Atlas surveys, what it can see and does not survey, and where the map ends",
  description:
    "The Coverage Surface (ADR-0041). Two arms in one response: `availability` answers *is it surveyed at all*, per source class and per survey unit; `authority` is the existing fact-oversight disclosure — observed, awaiting review, and the backlog federated to somebody else — carried through unchanged. " +
    "**There is no company-wide coverage percentage here, and there never will be.** Ratios exist only where numerator and denominator share one real unit, and every ratio carries that unit (`chat-channel-roster`, `mailbox-list`, `semantic-layer-enrollment`, `granted-recording-scopes`); no two classes share one, so a blend would have to add two quantities of different kinds. Every denominator is CREDENTIAL-RELATIVE — what the granted credentials can enumerate, never what the company has — so connecting more sources can make a ratio go down. " +
    "The third state is a MARK, never a number: `mapEdges` names arms of an enumeration that could not be performed, because any denominator that included the unenumerable would be fabricated. " +
    "Counts are always disclosed; a LABEL appears only where a deliberate act put the unit in scope or the vendor makes its existence workspace-public. Mailboxes, people and private channels are therefore counted (`unitsWithheld`) and never listed — and their staleness is still disclosed, through the per-class `freshness` tally that covers named and withheld units alike. " +
    "Every count is stamped `asOf` the cycle that produced it — read from dated snapshots, never from a live vendor call on page view. `stale` is a MEASURED lag (vendor activity newer than our newest evidence by more than the class's sync cadence) and carries its own arithmetic; where a class cannot ask, or the pipe is sick, the unit is `unverified-since` with a real date instead. A source that has not moved is `current`, however old its newest evidence. " +
    "Degradation is never a reassuring zero: a class with no successful cycle answers `never-enumerated` with no counts on it, a class this deploy cannot resolve answers `cannot-establish`, and `countsConsistent: false` says some part of this response cannot be trusted to add up — a banner, not a blank page.",
  responses: {
    200: {
      description: "Both arms of the coverage statement, each part separately true",
      content: { "application/json": { schema: BrainCoverageSchema } },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Not authenticated, or not an admin",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "No internal database configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description:
        "The coverage statement could not be composed — including the one false-all-clear this surface throws on, a class that declares an enumerable universe but holds no roster in this deploy. The requestId correlates it to the log line naming the class",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const adminBrainCoverage = createAdminRouter();

adminBrainCoverage.use(requireOrgContext());

adminBrainCoverage.openapi(coverageRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const coverage = yield* Effect.tryPromise({
        try: async () => {
          const db = getInternalDB();
          // Resolved INSIDE the same promise as the load so the two share one
          // failure path: `resolveBrainReaderContext` throws rather than
          // degrading when a session that carries a role cannot have it
          // re-resolved against this workspace, and `loadCoverage` throws on
          // the one false-all-clear it admits. Both are 500s with a requestId,
          // which is the correct answer to "Atlas cannot stand behind this
          // statement" — the alternative is a coverage page missing an arm.
          const ctx = await resolveBrainReaderContext(db, {
            workspaceId: orgId,
            mode,
            user,
            requestId,
          });
          return loadCoverage(db, ctx, requestId);
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(BrainCoverageSchema.parse(coverage), 200);
    }),
    { label: "load company atlas coverage" },
  );
});

export { adminBrainCoverage };
