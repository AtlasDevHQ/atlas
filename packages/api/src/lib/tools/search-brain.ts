/**
 * `searchBrain` — the agent-facing wrapper over the fused company-brain read
 * (#4773, ADR-0036 §Retrieval & agent interface).
 *
 * The query layer is `lib/brain/search.ts`; this module is the adapter that
 * resolves the caller's workspace, content mode, and principal set out of
 * request context, and turns a failure into something an agent can act on. It
 * carries no SQL and no gating logic of its own — a second place that decided
 * what a reader may see is exactly the drift `acl.ts` exists to prevent.
 *
 * ## This tool replaces `searchKnowledge`
 *
 * `searchKnowledge` (#4210, ADR-0028) searched hosted documents. `searchBrain`
 * searches those documents PLUS the tier-2/tier-3 brain substrate, and labels
 * every row with its trust tier. The document behaviour is unchanged —
 * frontmatter filters, FTS, 1-hop expansion — it is now one of three stores
 * rather than the whole tool.
 *
 * The old name is gone rather than aliased, and the policy is stated in three
 * parts because the three surfaces have different contracts:
 *
 *   1. **Agent registry** — hard rename. Agent tool names carry no stability
 *      contract (`shared/reference/stability.mdx` names tool selection
 *      explicitly as a no-contract surface). Registering both names would
 *      double the agent's choice surface for one capability, and the
 *      description is where routing is supposed to happen.
 *   2. **`atlas.config.ts` `tools: []`** — a CONFIGURATION surface, where the
 *      failure mode is `validateToolConfig` throwing at boot on upgrade. The
 *      old spelling is accepted there and normalized, with a warning. See
 *      `RENAMED_TOOLS` in `lib/tools/registry.ts`.
 *   3. **MCP** — purely additive. `searchKnowledge` was never an MCP tool, so
 *      nothing is removed and the frozen-tool-name rule is untouched;
 *      `searchBrain` is a new tool on that surface.
 *
 * ## Degraded paths, and why none of them is a bare empty result
 *
 * Every degraded path carries a machine-readable {@link BrainToolReason}.
 * That field is the contract with the MCP edge, which maps it to a typed error
 * envelope — an earlier cut recovered the same distinction by prefix-matching
 * the English prose across a package boundary, so a copy edit would have
 * silently demoted an ACL refusal to `internal_error`.
 *
 *   - **No internal database** (`no_internal_db`) — a user-facing `{ error }`.
 *     The brain lives entirely in the internal Postgres; without one there is
 *     nothing to search and no amount of retrying changes that.
 *   - **No active workspace** (`no_workspace`) — a fully-shaped EMPTY response
 *     carrying `unavailable: "no_workspace"`. Shaped rather than an error
 *     because a workspace-less deployment is a legitimate configuration the
 *     agent loop should move past, not retry — but NOT bare, because a bare
 *     `{ results: [] }` reads as "the brain knows nothing" and is the single
 *     most likely thing an agent will believe. This path is reachable in
 *     practice: an unbound stdio MCP actor (`system:mcp`, no
 *     `activeOrganizationId`) takes it on every call.
 *   - **Unresolvable reader identity** (`reader_unresolved`) — an `{ error }`,
 *     NEVER an empty result set. Every `BrainReaderIdentityError` means the ACL
 *     narrowed on a defect; reporting that as "the brain holds nothing about
 *     this" would send the agent to answer from its own priors, which is the
 *     exact failure a trust-labeled surface exists to prevent.
 *   - **Anything else** (`search_failed`) — a generic, secret-free `{ error }`
 *     with retry guidance.
 */

import { tool } from "ai";
import { z } from "zod";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { getInternalDB, hasInternalDB } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { rootCauseMessage } from "@atlas/api/lib/error-cause";
import {
  searchBrainCore,
  BrainAsOfInvalidError,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from "@atlas/api/lib/brain/search";
import {
  BrainReaderIdentityError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";
import { SEARCH_BRAIN_TOOL_DESCRIPTION } from "@atlas/api/lib/tools/descriptions";
import { BRAIN_RESULT_TIERS, isBrainResultTier } from "@useatlas/schemas";
import type { AtlasMode } from "@useatlas/types/auth";
import type {
  BrainResultTier,
  BrainSearchResponse,
  BrainSearchUnavailable,
} from "@useatlas/types";

const log = createLogger("search-brain");

/**
 * Why a call degraded — the discriminator every consumer branches on.
 *
 * Machine-readable on purpose: the MCP edge turns `reader_unresolved` into a
 * `forbidden` envelope and the rest into `internal_error`, and it must not
 * recover that from prose it does not own.
 */
export const BRAIN_TOOL_REASONS = {
  noInternalDb: "no_internal_db",
  noWorkspace: "no_workspace",
  readerUnresolved: "reader_unresolved",
  searchFailed: "search_failed",
  /**
   * The caller's `asOf` could not be honored (#4916) — malformed or in the
   * future. Its own reason rather than `search_failed` because the recovery is
   * different: fix the argument, don't retry — and the MCP edge maps it to
   * `validation_failed`, not `internal_error`.
   */
  invalidAsOf: "invalid_as_of",
} as const;

export type BrainToolReason = (typeof BRAIN_TOOL_REASONS)[keyof typeof BRAIN_TOOL_REASONS];

/**
 * Compile error if `BrainSearchUnavailable` ever widens past this vocabulary.
 *
 * The two lists are duplicated because `@useatlas/types` cannot import from
 * `@atlas/api`. Today the only thing holding them together is the
 * `emptyResponse(BRAIN_TOOL_REASONS.noWorkspace)` call site; this makes the
 * relation itself the pin, so a new `unavailable` value fails HERE rather than
 * at whichever call site eventually tries to use it.
 */
type _UnavailableIsReason = BrainSearchUnavailable extends BrainToolReason ? true : never;
const _unavailableIsReason: _UnavailableIsReason = true;
void _unavailableIsReason;

/**
 * Prose for the identity refusal.
 *
 * Says the read was REFUSED, not that nothing matched. An agent that reads
 * "no results" stops looking; an agent that reads "could not be established"
 * surfaces the problem to the user, which is what should happen when the ACL
 * narrowed because of a defect upstream. Carried alongside
 * `reason: "reader_unresolved"` — the prose is for the human, the reason is the
 * contract.
 */
const READER_UNRESOLVED_MESSAGE =
  "Company-brain search was refused: your identity could not be resolved for this workspace, " +
  "so results cannot be filtered safely. This is a configuration or session problem, not an " +
  "empty knowledge base — do not treat it as 'nothing is known'. Report it and continue without brain results.";

/**
 * The fully-shaped empty response — every store reported, nothing invented.
 *
 * `unavailable` is the difference between "searched, found nothing" and "could
 * not search". Without it an unbound stdio MCP actor gets a `200`-shaped
 * `{ results: [] }` on every call, forever, and the agent concludes the company
 * brain is empty.
 */
function emptyResponse(unavailable: BrainSearchUnavailable | null = null): BrainSearchResponse {
  const store = { queried: false } as const;
  return {
    results: [],
    neighbors: [],
    stores: { fact: store, "raw-episode": store, document: store },
    tensionsTruncated: false,
    unavailable,
  };
}

/** Workflow-guidance block injected into the agent system prompt via `describe()`. */
export const SEARCH_BRAIN_DESCRIPTION = `### Search the Company Brain
Use the searchBrain tool for decisions, rationale, ownership, policy, and history:
- Pass a natural-language \`query\`; narrow the document store with \`type\`, \`tags\`, \`collection\`, or \`since\`, and narrow the stores themselves with \`include\`
- Every result is labelled: \`tier: "fact"\` (reviewed claim), \`"raw-episode"\` (the source record), \`"document"\` (hosted knowledge). Cite the tier and the provenance when you use one — a raw episode is what someone SAID, not what is true
- An episode tagged \`extraction: "pending"\` has not been distilled into facts yet; quote it as raw evidence
- A fact whose \`provenance.attribution\` is \`{ "visible": false }\` is one you may read but whose author, source id, and original timestamp are withheld from this reader. Use the claim; say attribution is restricted if asked who said it. Do NOT report it as anonymous, undated, or unsourced — and never infer the author from anything else in the response
- Every fact carries its age: \`validFrom\`, \`corroborationCount\`, \`provenance.attribution.occurredAt\` (when visible), and a read-time \`decay\` signal (\`fresh\`/\`aging\`/\`stale\`/\`unknown\`). Staleness is advisory — a \`stale\` fact is still the reviewed record. Present its age ("as of March…") instead of asserting it as current, and never discard or overrule a fact because of age
- \`tensions\` is the fact's conflict cluster, listed in both directions and deliberately unranked — each visible counterpart carries its own claim and provenance, so surface both sides with their evidence and never pick a winner; recency and corroboration are context for the reader, not a verdict. A \`{ "visible": false, "withheldCount": N }\` entry means N conflicting claims exist that you cannot see — treat the claim as contested, never as settled
- To answer "what did we believe at <time>", pass \`asOf\` (ISO-8601, in the past): facts are then the versions valid AT that instant, including ones since superseded. A response carrying \`asOf\` is HISTORICAL — frame every fact in it as "as of <time>", never as current; a response without \`asOf\` is current belief. Retracted facts never appear, at any time
- If the response carries \`unavailable\`, the brain could NOT be searched (e.g. no workspace is bound). Say so — do NOT report it as "nothing is known"
- Read-only, and never the SQL whitelist, metrics, or glossary. For quantitative current state use \`executeSQL\`; for the on-disk semantic layer use \`explore\``;

/**
 * Append the request id so the user has something to quote.
 *
 * These messages are the only thing standing between an incident and an
 * operator grepping blind — the server-side `log.error` is the only other
 * trace, and nothing correlates the two without this.
 */
function withRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (request ${requestId})` : message;
}

export interface SearchBrainInput {
  query?: string;
  include?: string[];
  type?: string;
  tags?: string[];
  collection?: string;
  since?: string;
  asOf?: string;
  limit?: number;
  expand?: boolean;
}

/**
 * Clamp + normalize raw tool input. Exported for tests.
 *
 * An `include` list containing no recognized tier is treated as ABSENT (all
 * stores) rather than as "read nothing": the alternative silently returns an
 * empty result set for a typo, which is indistinguishable from an empty brain
 * — the failure this whole surface is built to avoid.
 */
export function normalizeSearchInput(input: SearchBrainInput): {
  query?: string;
  include?: readonly BrainResultTier[];
  type?: string;
  tags?: readonly string[];
  collection?: string;
  since?: string;
  asOf?: string;
  limit: number;
  expand: boolean;
} {
  const rawLimit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(rawLimit)));
  const tags = input.tags?.map((t) => t.trim()).filter((t) => t !== "");
  const include = input.include?.filter(isBrainResultTier);
  if (input.include && include && include.length !== input.include.length) {
    log.debug(
      { requested: input.include, recognized: include },
      "searchBrain: dropped unrecognized `include` entries",
    );
  }
  return {
    query: input.query,
    include: include && include.length > 0 ? include : undefined,
    type: input.type?.trim() || undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    collection: input.collection?.trim() || undefined,
    since: input.since?.trim() || undefined,
    // Passed through VERBATIM, deliberately unlike `since` above: `'   '.trim()
    // || undefined` would silently turn an explicit-but-blank asOf into the
    // as-of-now read — exactly the fall-through #4916 forbids. The core's
    // parseBrainAsOf owns the judgment and REJECTS a blank instead.
    asOf: input.asOf,
    limit,
    expand: input.expand ?? true,
  };
}

export const searchBrain = tool({
  description: SEARCH_BRAIN_TOOL_DESCRIPTION,

  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Free-text search across claims, source records, and document bodies. Omit to browse the most recent entries in each store.",
      ),
    include: z
      .array(z.enum(BRAIN_RESULT_TIERS))
      .optional()
      .describe(
        `Restrict to specific result classes (${BRAIN_RESULT_TIERS.join(", ")}). Omit to search all three.`,
      ),
    type: z.string().optional().describe("Documents only: filter to one OKF document type, e.g. 'Runbook'."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Documents only: filter to documents carrying ALL of these OKF tags."),
    collection: z
      .string()
      .optional()
      .describe("Documents only: restrict to a single knowledge collection (install slug)."),
    since: z
      .string()
      .optional()
      .describe("Documents only: ISO-8601 date; documents at or after this timestamp."),
    asOf: z
      .string()
      .optional()
      .describe(
        "Facts only: historical point read — returns the reviewed facts valid at that moment (later-superseded versions included; retracted facts never). An ISO-8601 date (2026-07-27) or a timestamp with an EXPLICIT zone (2026-07-27T09:00:00Z); zone-less times, non-ISO forms, and future instants are rejected. Requires the fact store in `include`. Omit for current beliefs.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .optional()
      .describe(`Max fused results to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`),
    expand: z
      .boolean()
      .optional()
      .describe("Include 1-hop linked neighbors of the matched documents (default true)."),
  }),

  execute: async (input) => {
    const reqCtx = getRequestContext();
    const workspaceId = reqCtx?.user?.activeOrganizationId;
    const mode: AtlasMode = reqCtx?.atlasMode ?? "published";

    if (!hasInternalDB()) {
      return {
        error:
          "Company-brain search is unavailable — this deployment has no internal database configured.",
        reason: BRAIN_TOOL_REASONS.noInternalDb,
      };
    }
    if (!workspaceId) {
      // The brain is workspace-scoped; without a workspace there is nothing to
      // search. Shaped-empty rather than an error so the agent loop moves on —
      // but LABELLED, so "could not search" is distinguishable from "searched,
      // found nothing", and at `warn` rather than `debug` because the reachable
      // cause is a misconfiguration (an unbound stdio MCP actor, or a
      // deployment that lost workspace context), not a routine state.
      log.warn(
        { hasRequestContext: Boolean(reqCtx), requestId: reqCtx?.requestId },
        "searchBrain: no active workspace in request context — the brain cannot be searched",
      );
      return emptyResponse(BRAIN_TOOL_REASONS.noWorkspace);
    }

    try {
      // Inside the try: `hasInternalDB()` was checked above, but a pool torn
      // down between the two (shutdown, re-init, config reload) would otherwise
      // throw straight out of `execute` and reach the agent as a raw error,
      // bypassing every degraded shape this module defines.
      const db = getInternalDB();
      const ctx = await resolveBrainReaderContext(db, {
        workspaceId,
        mode: detectAuthMode(),
        user: reqCtx?.user,
        requestId: reqCtx?.requestId,
      });
      return await searchBrainCore(db, {
        ctx,
        mode,
        ...normalizeSearchInput(input),
        requestId: reqCtx?.requestId,
      });
    } catch (err) {
      const requestId = reqCtx?.requestId;
      // The caller's own argument, refused (#4916) — warn, not error: nothing
      // is wrong server-side, and the message already tells the agent the fix.
      // The core's prose IS the user-facing message; it names the offending
      // value and the recovery, per the no-generic-errors rule.
      if (err instanceof BrainAsOfInvalidError) {
        log.warn(
          { err: err.message, workspaceId, requestId },
          "searchBrain rejected an unusable asOf — refusing rather than answering as-of-now",
        );
        return {
          error: withRequestId(err.message, requestId),
          reason: BRAIN_TOOL_REASONS.invalidAsOf,
        };
      }
      // Identity failures are reported as a REFUSAL, distinctly from a generic
      // search failure — see the module header on why an empty result set would
      // be the dangerous answer here. ONE `instanceof` against the shared base,
      // so a future identity failure is covered by construction rather than by
      // somebody remembering to extend this condition.
      if (err instanceof BrainReaderIdentityError) {
        log.error(
          {
            err: err.message,
            errorName: err.name,
            // The ROOT cause, not `err.cause`. This chain is two deep
            // (`BrainRoleUnresolvedError` → `MemberRoleLookupError` → driver
            // error), and the middle link's message only restates the workspace
            // and user already in this payload — so a single unwrap logs
            // nothing new and the driver text never surfaces.
            cause: rootCauseMessage(err),
            workspaceId,
            requestId,
          },
          "searchBrain refused: reader identity could not be resolved",
        );
        return {
          error: withRequestId(READER_UNRESOLVED_MESSAGE, requestId),
          reason: BRAIN_TOOL_REASONS.readerUnresolved,
        };
      }
      log.error(
        { err: err instanceof Error ? err.message : String(err), workspaceId, requestId },
        "searchBrain failed",
      );
      return {
        error: withRequestId(
          "Company-brain search failed. Retry with a simpler query or fewer filters; " +
            "if it persists, the brain store may be temporarily unavailable.",
          requestId,
        ),
        reason: BRAIN_TOOL_REASONS.searchFailed,
      };
    }
  },
});
