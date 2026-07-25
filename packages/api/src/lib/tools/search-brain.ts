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
 * ## Degraded paths have deliberately different shapes
 *
 *   - **No internal database** — a user-facing `{ error }`. The brain lives
 *     entirely in the internal Postgres; without one there is nothing to search
 *     and no amount of retrying changes that.
 *   - **No active workspace** — an empty, fully-shaped response plus a debug
 *     log. The brain is workspace-scoped, so this is "nothing to search" rather
 *     than a failure, and the agent should move on instead of retrying.
 *   - **Unresolvable reader identity** — an `{ error }`, NEVER an empty result
 *     set. `BrainReaderUnresolvedError` and `BrainRoleUnresolvedError` both
 *     mean the ACL narrowed on a defect; reporting that as "the brain holds
 *     nothing about this" would send the agent to answer from its own priors,
 *     which is the exact failure a trust-labeled surface exists to prevent.
 */

import { tool } from "ai";
import { z } from "zod";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { getInternalDB, hasInternalDB } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { searchBrainCore, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "@atlas/api/lib/brain/search";
import {
  BrainReaderUnresolvedError,
  BrainRoleUnresolvedError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";
import { SEARCH_BRAIN_TOOL_DESCRIPTION } from "@atlas/api/lib/tools/descriptions";
import { BRAIN_RESULT_TIERS } from "@useatlas/schemas";
import type { AtlasMode } from "@useatlas/types/auth";
import type { BrainResultTier, BrainSearchResponse } from "@useatlas/types";

const log = createLogger("search-brain");

/**
 * Message returned when the reader's identity could not be resolved.
 *
 * Says the read was REFUSED, not that nothing matched. An agent that reads
 * "no results" stops looking; an agent that reads "could not be established"
 * surfaces the problem to the user, which is what should happen when the ACL
 * narrowed because of a defect upstream.
 */
const READER_UNRESOLVED_MESSAGE =
  "Company-brain search was refused: your identity could not be resolved for this workspace, " +
  "so results cannot be filtered safely. This is a configuration or session problem, not an " +
  "empty knowledge base — do not treat it as 'nothing is known'. Report it and continue without brain results.";

/** The fully-shaped empty response — every store reported, nothing invented. */
function emptyResponse(): BrainSearchResponse {
  const store = { queried: false, matched: 0, truncated: false } as const;
  return {
    results: [],
    neighbors: [],
    stores: { facts: store, episodes: store, documents: store },
    tensionsTruncated: false,
  };
}

/** Workflow-guidance block injected into the agent system prompt via `describe()`. */
export const SEARCH_BRAIN_DESCRIPTION = `### Search the Company Brain
Use the searchBrain tool for decisions, rationale, ownership, policy, and history:
- Pass a natural-language \`query\`; narrow the document store with \`type\`, \`tags\`, \`collection\`, or \`since\`, and narrow the stores themselves with \`include\`
- Every result is labelled: \`tier: "fact"\` (reviewed claim), \`"raw-episode"\` (the source record), \`"document"\` (hosted knowledge). Cite the tier and the provenance when you use one — a raw episode is what someone SAID, not what is true
- An episode tagged \`extraction: "pending"\` has not been distilled into facts yet; quote it as raw evidence
- \`tensions\` lists conflicting claims in both directions and is deliberately unranked — surface both sides, never pick a winner
- Read-only, and never the SQL whitelist, metrics, or glossary. For quantitative current state use \`executeSQL\`; for the on-disk semantic layer use \`explore\``;

export interface SearchBrainInput {
  query?: string;
  include?: string[];
  type?: string;
  tags?: string[];
  collection?: string;
  since?: string;
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
  limit: number;
  expand: boolean;
} {
  const rawLimit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(rawLimit)));
  const tags = input.tags?.map((t) => t.trim()).filter((t) => t !== "");
  const include = input.include?.filter((t): t is BrainResultTier =>
    (BRAIN_RESULT_TIERS as readonly string[]).includes(t),
  );
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
      };
    }
    if (!workspaceId) {
      // The brain is workspace-scoped; without a workspace there is nothing to
      // search. An empty result set (not an error) so the agent moves on rather
      // than retrying — but logged, since a misconfigured deployment that lost
      // workspace context would otherwise be indistinguishable from an empty
      // brain. Same shape `searchKnowledge` used for the same reason.
      log.debug(
        { hasRequestContext: Boolean(reqCtx) },
        "searchBrain: no active workspace in request context — returning empty results",
      );
      return emptyResponse();
    }

    const db = getInternalDB();
    try {
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
      // The two identity failures are reported as a REFUSAL, distinctly from a
      // generic search failure — see the module header on why an empty result
      // set would be the dangerous answer here.
      if (err instanceof BrainReaderUnresolvedError || err instanceof BrainRoleUnresolvedError) {
        log.error(
          { err: err.message, workspaceId, requestId: reqCtx?.requestId },
          "searchBrain refused: reader identity could not be resolved",
        );
        return { error: READER_UNRESOLVED_MESSAGE };
      }
      log.error(
        { err: err instanceof Error ? err.message : String(err), workspaceId },
        "searchBrain failed",
      );
      return {
        error:
          "Company-brain search failed. Retry with a simpler query or fewer filters; " +
          "if it persists, the brain store may be temporarily unavailable.",
      };
    }
  },
});
