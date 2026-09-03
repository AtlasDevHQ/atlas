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
import type { z } from "zod";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { withRequestId } from "@atlas/api/lib/tools/tool-message";
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
import { searchBrainInputSchema } from "@atlas/api/lib/tools/search-brain-schema";
import { isBrainResultTier } from "@useatlas/schemas";
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
  "Company Atlas search was refused: your identity could not be resolved for this workspace, " +
  "so results cannot be filtered safely. This is a configuration or session problem, not an " +
  "empty knowledge base — do not treat it as 'nothing is known'. Report it and continue without Atlas results.";

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
    stores: { attested: store, "on-record": store, document: store },
    tensionsTruncated: false,
    unavailable,
  };
}

/**
 * Workflow-guidance block injected into the agent system prompt via `describe()`.
 *
 * ## The tier clause stays, now that a UI renders the tier too (#5451)
 *
 * Until 2026-08-26 this prompt was the ONLY thing carrying ADR-0036's
 * "every UI surface must carry the tier label" invariant to a person —
 * `searchBrain` (as `searchAtlas` was then named) fell through the chat
 * surface's `default:` arm to a gray "Tool: searchBrain" box, and the
 * episode tier appeared zero times in
 * `packages/web/src`. That is the failure shape `lib/brain/segmentation.ts`
 * names: a property that must be TRUE carried by a model instruction holds
 * statistically, and nothing reports the turn where the model omits it.
 *
 * Both non-admin chat surfaces now render a tier chip per result, and
 * `executeSQL`'s card carries tier-1 SURVEYED. **The prompt clause is
 * deliberately NOT removed in exchange.** MCP, the CLI and the chat-platform
 * adapters render no Atlas UI at all, so deleting it would replace a
 * statistical carrier with nothing on every surface Atlas does not draw. The
 * two are not two sources of one claim: the badge STATES the tier, this tells
 * the model to CITE provenance and forbids presenting one tier as another.
 *
 * ⚠️ The badge LABELS still carry the pre-rename display words (`fact` /
 * `raw episode` / `document` / `warehouse`) even though the wire values moved
 * to `attested` / `on-record` with ADR-0038 Layer 2 (#5469). That is #5375's
 * to settle, and is deliberate rather than an oversight: #5375 says "do not
 * rename first and test after". If it adopts the proposed names, the labels in
 * `@useatlas/schemas/trust-tier` (and its widget mirror) are the entire edit.
 */
export const SEARCH_BRAIN_DESCRIPTION = `### Search the Company Atlas
Use the searchAtlas tool for decisions, rationale, ownership, policy, and history:
- Pass a natural-language \`query\`; narrow the document store with \`type\`, \`tags\`, \`collection\`, or \`since\`, and narrow the stores themselves with \`include\`
- Every result is labelled: \`tier: "attested"\` is an ATTESTED claim (a named person reviewed and stood behind it), \`"on-record"\` is ON THE RECORD (the source material — what someone SAID, not what is true), \`"document"\` is hosted knowledge. Cite the tier and the provenance when you use one. The third tier, SURVEYED — warehouse rows that are authoritative by construction because the query re-reads them live — is not in this tool at all; it is \`executeSQL\`. Never present an attested claim as if it were surveyed
- An episode tagged \`extraction: "pending"\` has not been distilled into facts yet; quote it as raw evidence
- WHO said it is \`provenance.attribution.actorIdentity\`, not \`attribution.actor\`. \`actor\` is the SOURCE VENDOR'S OWN HANDLE (\`slack:U0AQW6KF2EM\`) and naming a person by it is not an answer \u2014 quote it only as a reference, never as who someone is. The identity beside it is labelled: \`state: "atlas"\` carries a \`name\` read LIVE from that person's Atlas account, so state it plainly as current; \`"directory"\` carries a \`displayName\`/\`realName\` SNAPSHOT taken from the source's directory on \`snapshotAt\` \u2014 give the name AND its date ("Dana Okafor, as of April"), because that person has no Atlas account and the name may have changed since; \`"opaque"\` means Atlas cannot name them, so say so \u2014 do NOT substitute the handle, and do NOT infer a name from the claim's text; \`"machine"\` means NO PERSON produced this \u2014 a scheduled fiber read it out of the customer's own systems \u2014 so say a machine did it and name nobody, and never report it as an unnamed or restricted person. \`actorIdentity: null\` means the evidence had no author at all (a warehouse reading), which is different from an author who cannot be named and different again from \`"machine"\`, which is a positive statement that no person was involved
- WHO APPROVED it is \`approval\`, and it is a DIFFERENT PERSON from who said it. \`provenance.attribution\` names the author of the evidence; \`approval\` names the reviewer who made the claim authoritative, and on a real corpus these are routinely not the same human. State both when you have both — "Priya Natarajan said it in #finance on 14 July; approved by <name>" — because the approver is what makes an attested claim more than a quotation. \`approved: false\` means no approval is recorded: the claim was published before Atlas stored approvers, or restored by a region import that did not carry the decision. Say the approver is not recorded; do NOT fall back to naming the author as if they had approved it. When \`approved\` is true, \`approver.state: "atlas"\` carries a \`name\` read LIVE from that person's Atlas account — state it plainly as current, and when \`name\` is null the account no longer exists, so report that a person approved it and that Atlas can no longer name them. \`approver.state: "local-operator"\` means a human approved it on a deployment with no user accounts: say a local operator approved it and name nobody. \`approvedAt\` is when the gate approved it, and it is not the claim's date — \`validFrom\` and \`attribution.occurredAt\` are when the thing was true and when it was said
- A fact whose \`provenance.attribution\` is \`{ "visible": false }\` is one you may read but whose author, source id, and original timestamp are withheld from this reader. Use the claim; say attribution is restricted if asked who said it. Do NOT report it as anonymous, undated, or unsourced — and never infer the author from anything else in the response
- Every fact carries its age: \`validFrom\`, \`corroborationCount\`, \`provenance.attribution.occurredAt\` (when visible), and a read-time \`decay\` signal (\`fresh\`/\`aging\`/\`stale\`/\`unknown\`). Staleness is advisory — a \`stale\` fact is still the reviewed record. Present its age ("as of March…") instead of asserting it as current, and never discard or overrule a fact because of age
- \`tensions\` is the fact's conflict cluster, listed in both directions and deliberately unranked — each visible counterpart carries its own claim and provenance. Where both sides are still live, surface both with their evidence and never pick a winner; recency and corroboration are context for the reader, not a verdict. Two fields tell you a rival is NOT live and that a human already resolved the conflict — report those as settled, and say which: a non-null \`invalidatedAt\` is a rival since RETRACTED (withdrawn as something that should never have been served); a \`validTo\` ALREADY IN THE PAST is a rival since SUPERSEDED (it held until that time, then was replaced). A \`validTo\` still in the future is a LIVE rival whose window is merely scheduled to close — treat it as contested. Both labels are as of NOW, never relative to \`asOf\`. A retired rival is listed only because it is why the claim was once contested — never present one as a live contradiction, and do not let it make the surviving claim sound disputed. A \`{ "visible": false, "withheldCount": N }\` entry means N conflicting claims exist that you cannot see — treat the claim as contested, never as settled
- \`history\` is what the claim REPLACED. When \`history.prior\` is present the answer CHANGED, and you must say so unprompted — state today's answer, what it used to be (\`prior.object\`), and when it stopped being true (\`prior.validTo\`) — even when the question did not ask about history. \`changedBy\` says who, and it is a LABELLED union you must read before naming anyone: \`kind: "correction"\` means a person deliberately corrected the claim, so name them from \`actorIdentity\` under the identity rules above; \`kind: "promotion"\` means Atlas retired the older claim when a newer one was published, so say THAT and name NOBODY — the actor on a promoted claim is whoever the newer claim was extracted from, and they may never have touched the old one. A \`prior\` of \`{ "visible": false }\` means the previous answer exists and is not readable by this reader: report that it changed and that the earlier value is restricted, never that it is unknown. \`priorCount\` above 1 means it changed more than once and only the most recent earlier version is carried; \`truncated: true\` means that count is a floor. Never present a \`prior\` value as current
- To answer "what did we believe at <time>", pass \`asOf\` (ISO-8601, in the past): facts are then the versions valid AT that instant, including ones since superseded. A response carrying \`asOf\` is HISTORICAL — frame every fact in it as "as of <time>", never as current; a response without \`asOf\` is current belief. A retracted fact is never returned as a RESULT, under \`asOf\` or otherwise — the one place it still appears is a \`tensions\` counterpart, labelled by \`invalidatedAt\` as above
- If the response carries \`unavailable\`, the Atlas could NOT be searched (e.g. no workspace is bound). Say so — do NOT report it as "nothing is known"
- Read-only, and never the SQL whitelist, metrics, or glossary. For quantitative current state use \`executeSQL\`; for the on-disk semantic layer use \`explore\``;

/**
 * The normalizer's input contract — deliberately LOOSER than the schema.
 *
 * `include?: string[]` rather than `BrainResultTier[]` is the point: the
 * drop-unrecognized-and-log path below has to stay reachable for a caller that
 * did not go through zod, because an unrecognized tier silently meaning "search
 * nothing" is indistinguishable from an empty brain.
 */
export interface SearchBrainInput {
  // Loose-optional (`| undefined`) throughout, deliberately: this is the tool's
  // INPUT contract, and its main caller hands it a Zod-parsed value whose
  // `.optional()` fields are `T | undefined`. `normalizeSearchInput` below is
  // the seam that turns this into the exact shape the core consumes, so the
  // exactness that matters is on its RETURN type, not here (#5522).
  query?: string | undefined;
  include?: string[] | undefined;
  type?: string | undefined;
  tags?: string[] | undefined;
  collection?: string | undefined;
  since?: string | undefined;
  asOf?: string | undefined;
  limit?: number | undefined;
  expand?: boolean | undefined;
}

/**
 * Compile error if the shared schema and this contract stop naming the same
 * arguments — in EITHER direction.
 *
 * `SearchBrainInput` is an all-optional weak type, and TypeScript's weak-type
 * check only fires when two types share NO properties. So a partial drift —
 * the schema renaming `asOf`, say — compiles silently: `execute` still
 * typechecks, `normalizeSearchInput` reads `undefined`, and every historical
 * read degrades to an as-of-now read, which is the exact silent fall-through
 * #4916 exists to forbid. `exactOptionalPropertyTypes` is off repo-wide, so
 * nothing else catches it.
 *
 * It earned its keep at #4954: the schema is no longer in the same file as the
 * function that consumes it, it is in another module, edited by people fixing
 * the MCP surface. Both directions matter — a schema key missing here is an
 * argument the normalizer drops on the floor; a key here missing from the
 * schema is a field no model can ever send — so they are two consts rather
 * than one, and each one's failing type is the LEFTOVER KEY. tsc then names
 * the direction and the argument (`Type 'true' is not assignable to type
 * '"as_of"'`) instead of an anonymous `never`. Same `_`-const idiom as
 * {@link _UnavailableIsReason} above.
 *
 * The `[X] extends [never]` tupling is deliberate: a bare `X extends never`
 * distributes over a union and collapses on `never` itself, so both arms would
 * silently answer the wrong question.
 *
 * KEY SETS only. The other two halves live elsewhere on purpose. An argument's
 * TYPE is checked where `normalizeSearchInput(input)` is called below — a
 * `z.string()` limit fails there, not here, and only while `execute` keeps
 * passing `input` straight through. Its OPTIONALITY is pinned in
 * `__tests__/search-brain-tool.test.ts`, because dropping `.optional()`
 * changes neither the key set nor assignability to this all-optional weak type.
 */
type _SchemaKeys = keyof z.infer<typeof searchBrainInputSchema>;
type _SchemaKeyNotInInput = Exclude<_SchemaKeys, keyof SearchBrainInput>;
type _InputKeyNotInSchema = Exclude<keyof SearchBrainInput, _SchemaKeys>;

const _noSchemaKeyMissingFromInput: [_SchemaKeyNotInInput] extends [never]
  ? true
  : _SchemaKeyNotInInput = true;
const _noInputKeyMissingFromSchema: [_InputKeyNotInSchema] extends [never]
  ? true
  : _InputKeyNotInSchema = true;
void _noSchemaKeyMissingFromInput;
void _noInputKeyMissingFromSchema;

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
  // Read each trimmed value once: the conditional-spread idiom evaluates its
  // subject twice, so an inline `input.x?.trim()` would trim twice (#5522).
  const trimmedType = input.type?.trim();
  const trimmedCollection = input.collection?.trim();
  const trimmedSince = input.since?.trim();
  return {
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(include && include.length > 0 ? { include } : {}),
    ...(trimmedType ? { type: trimmedType } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(trimmedCollection ? { collection: trimmedCollection } : {}),
    ...(trimmedSince ? { since: trimmedSince } : {}),
    // Passed through VERBATIM, deliberately unlike `since` above: a blank
    // `asOf` must NOT fall through to the as-of-now read — exactly what #4916
    // forbids — so it is spread on presence, not on truthiness. The core's
    // parseBrainAsOf owns the judgment and REJECTS a blank instead.
    ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
    limit,
    expand: input.expand ?? true,
  };
}

export const searchBrain = tool({
  description: SEARCH_BRAIN_TOOL_DESCRIPTION,

  // The ONE definition, shared with the MCP tool (#4954). It lives in its own
  // module rather than here because the MCP suite `mock.module`s THIS file —
  // argument prose exported from here would reach `listTools()` as a stub and
  // every pin that reads the served schema would pass vacuously.
  inputSchema: searchBrainInputSchema,

  execute: async (input) => {
    const reqCtx = getRequestContext();
    const workspaceId = reqCtx?.user?.activeOrganizationId;
    const mode: AtlasMode = reqCtx?.atlasMode ?? "published";

    if (!hasInternalDB()) {
      return {
        error:
          "Company Atlas search is unavailable — this deployment has no internal database configured.",
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
          "Company Atlas search failed. Retry with a simpler query or fewer filters; " +
            "if it persists, the Atlas store may be temporarily unavailable.",
          requestId,
        ),
        reason: BRAIN_TOOL_REASONS.searchFailed,
      };
    }
  },
});
