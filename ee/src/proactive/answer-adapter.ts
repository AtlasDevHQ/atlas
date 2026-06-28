/**
 * Proactive answer adapter — host-side `executeQueryProactive` factory.
 *
 * Wraps {@link runAgent} so the `@useatlas/chat` proactive listener can
 * invoke the Atlas agent from OUTSIDE the Hono request lifecycle. The
 * listener calls this callback when a Slack user reacts back on a 🤖 to
 * request the answer; at that point there is no `RequestContext` /
 * `AuthContext` middleware in scope — both must be synthesized from the
 * resolved asker identity.
 *
 * The factory takes a captured {@link ManagedRuntime} so the callback
 * can yield `AtlasAiModel` from Effect context without rebuilding the
 * layer DAG per call. The runtime is materialized once at boot (in
 * `server.ts`) and shared across every adapter invocation.
 *
 * Identity binding:
 *   - **Linked asker** (`context.atlasUserId` non-null) — resolve the
 *     user's active org via the `member` table, build a real
 *     {@link AtlasUser} via {@link loadActorUser}, run the agent with
 *     the full workspace toolset (default {@link ToolRegistry}).
 *   - **Unlinked asker** (`context.atlasUserId === null`) — synthesize
 *     an anonymous chat-bot actor with no `activeOrganizationId`, and
 *     restrict the agent at the tool boundary via
 *     {@link createPublicDatasetToolRegistry}. The `executeSQL` and
 *     `explore` tools are wrapped with allowlist gates so the agent
 *     cannot read rows or YAML for entities outside the workspace's
 *     `getPublicDataset` allowlist before the listener's post-filter
 *     ever runs. The listener's `checkResultAgainstAllowlist` remains
 *     a belt-and-braces gate on the final response.
 *
 * Errors:
 *   - The adapter splits work into two try blocks so operators can
 *     distinguish "AI model resolver failed" from "agent run failed"
 *     in logs. Both surface a user-safe error message to the listener
 *     (which posts its own generic copy in-thread); operator detail is
 *     logged structurally with `{ threadId, askerId, errorMessage }`
 *     against a distinct `event` tag.
 *
 * Layer hygiene:
 *   - This module lives under `lib/` and never imports from
 *     `api/routes/` (CLAUDE.md layer rule).
 *   - Does NOT import from `@atlas/ee`; the AI model is yielded via the
 *     `AtlasAiModel` Tag which the EE layer transparently overrides
 *     when present.
 */

import type { ManagedRuntime } from "effect";
import { Effect } from "effect";
import type {
  AtlasUserId,
  ProactiveAsker,
  ProactiveExecuteQuery,
  ProactiveQueryResult,
  WorkspaceId,
} from "@useatlas/chat";

import { runAgent } from "@atlas/api/lib/agent";
import { withRequestContext, createLogger } from "@atlas/api/lib/logger";
import { AtlasAiModel, type AtlasAiModelShape } from "@atlas/api/lib/effect/ai";
import {
  botActorUser,
  loadActorUser,
  type ChatBotPlatform,
  CHAT_BOT_PLATFORMS,
} from "@atlas/api/lib/auth/actor";
import { createAtlasUser, type AtlasUser } from "@atlas/api/lib/auth/types";
import {
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import type { ToolRegistry } from "@atlas/api/lib/tools/registry";
import { createPublicDatasetToolRegistry } from "./public-dataset-tools";
import type { PublicDatasetEntry } from "./public-dataset";

const log = createLogger("proactive:answer-adapter");

/**
 * User-safe error surfaced to the proactive listener. The listener
 * (`plugins/chat/src/proactive/listener.ts`) catches this rethrow and
 * posts its OWN generic "Sorry — I hit an error" copy in-thread, so
 * this string never actually reaches the end user — but the
 * `Error.message` IS what surfaces in error tracking dashboards. Keep
 * the copy honest (no admin-notification system is wired) and
 * actionable so operators see a useful summary in stack traces.
 *
 * Developer detail is logged via `log.error` with structured fields
 * before the rethrow.
 */
export const PROACTIVE_USER_SAFE_ERROR_MESSAGE =
  "Atlas couldn't answer this — try again or contact your workspace admin.";

/** Synthetic external id used when no real Slack team_id is in scope. */
const PROACTIVE_SYNTHETIC_EXTERNAL_ID = "proactive";

/**
 * Required Effect services for the adapter. The caller's `runtime` must
 * satisfy at minimum this set. `AtlasAiModel` is the only service the
 * adapter yields directly; in practice the boot-time `buildAppLayer`
 * runtime carries the full app DAG so this never has to be threaded
 * through.
 */
export type ProactiveAnswerAdapterServices = AtlasAiModel;

/**
 * Optional knobs for {@link createProactiveAnswerAdapter}. All
 * defaults route through {@link loadActorUser} + the `member` table
 * lookup; tests inject lighter stubs.
 */
export interface ProactiveAnswerAdapterOptions {
  /**
   * Resolve an Atlas user's active org. Defaults to a single-row
   * `member` query (first row wins — matches `server.ts`'s
   * activate-first-org heuristic). Override in tests to stub the DB.
   *
   * Accepts a branded {@link AtlasUserId} (#2641) — a transposed-arg
   * call passing `asker.externalUserId` here is a compile error.
   */
  resolveOrgForUser?: (atlasUserId: AtlasUserId) => Promise<string | null>;
  /**
   * Resolve the actor identity for a linked user. Defaults to
   * {@link loadActorUser}.
   */
  resolveActor?: (
    atlasUserId: AtlasUserId,
    orgId: string | null,
  ) => Promise<AtlasUser | null>;
  /**
   * Resolve the workspace's public-dataset allowlist for an unlinked
   * asker (atlasUserId === null). Called once per request — the
   * resulting allowlist gates `executeSQL` + `explore` for that turn
   * via {@link createPublicDatasetToolRegistry}. Admins can modify
   * the dataset between turns, so callers MUST NOT cache the result.
   *
   * Required for the unlinked-asker path; if omitted, every unlinked
   * call is rejected with the user-safe error. Linked calls
   * (`atlasUserId !== null`) never invoke this callback.
   *
   * Receives the per-event branded {@link WorkspaceId} (#2624 + #2641
   * brand) alongside the asker so multi-tenant hosts scope the
   * allowlist lookup to the right tenant. Pre-#2624 the callback
   * received only `asker`, which couldn't distinguish "same Slack
   * user-id seen in tenant A vs tenant B" and so routed tenant B
   * askers against tenant A's allowlist on the chat plugin's
   * single-instance multi-tenant SaaS wiring.
   *
   * The default production wiring resolves the allowlist via
   * `getAllowlist(workspaceId)` in `./public-dataset.ts`.
   */
  getPublicDataset?: (
    asker: ProactiveAsker,
    ctx: { workspaceId: WorkspaceId },
  ) => Promise<ReadonlyArray<PublicDatasetEntry>>;
}

/**
 * Build the proactive answer adapter callback.
 *
 * @param runtime  Captured `ManagedRuntime` providing at minimum
 *                 {@link AtlasAiModel}. Pass the runtime from
 *                 `buildAppLayer(config)` — it carries every service
 *                 the agent loop needs at runtime.
 * @param options  Optional dependency overrides for tests.
 */
export function createProactiveAnswerAdapter(
  runtime: ManagedRuntime.ManagedRuntime<ProactiveAnswerAdapterServices, never>,
  options: ProactiveAnswerAdapterOptions = {},
): ProactiveExecuteQuery {
  const resolveOrgForUser =
    options.resolveOrgForUser ?? defaultResolveOrgForUser;
  const resolveActor = options.resolveActor ?? loadActorUser;
  const getPublicDataset = options.getPublicDataset;

  return async (question, context): Promise<ProactiveQueryResult> => {
    const requestId = crypto.randomUUID();
    const { threadId, asker, atlasUserId, workspaceId } = context;
    // #2705 — Slack presentation mode. Default to "developer" so a
    // host whose `executeQueryProactive` predates #2705 still produces
    // the analyst-grade body (the backward-compatible posture). The
    // chat plugin's listener now always passes `"conversational"` for
    // both the linked-asker and public-dataset branches.
    const presentationMode = context.presentationMode ?? "developer";
    const askerId = describeAskerId(asker);

    // 1. Resolve identity + (unlinked) restricted tool registry ----------
    let actor: AtlasUser;
    let toolRegistry: ToolRegistry | undefined;
    try {
      if (atlasUserId) {
        actor = await resolveLinkedActor(
          atlasUserId,
          resolveOrgForUser,
          resolveActor,
        );
      } else {
        // Unlinked asker — MUST resolve the workspace's public dataset
        // and bind the adapter-side tool gate before invoking the
        // agent. If the workspace has no allowlist (or the resolver
        // fails), refuse the request: a missing allowlist with no
        // host-side gate would let the agent read anything from the
        // warehouse before the listener's post-filter ever ran.
        if (!getPublicDataset) {
          log.error(
            { threadId, askerId, workspaceId, event: "proactive.answer.public_dataset_missing" },
            "Unlinked asker reached the adapter but getPublicDataset is not wired — refusing",
          );
          throw new Error(PROACTIVE_USER_SAFE_ERROR_MESSAGE);
        }
        let allowlist: ReadonlyArray<PublicDatasetEntry>;
        try {
          allowlist = await getPublicDataset(asker, { workspaceId });
        } catch (err) {
          log.error(
            {
              threadId,
              askerId,
              workspaceId,
              errorMessage: errorMessage(err),
              event: "proactive.answer.public_dataset_failed",
            },
            "getPublicDataset threw — refusing unlinked-asker request",
          );
          throw new Error(PROACTIVE_USER_SAFE_ERROR_MESSAGE, { cause: err });
        }
        if (allowlist.length === 0) {
          log.warn(
            {
              threadId,
              askerId,
              workspaceId,
              event: "proactive.answer.public_dataset_empty",
            },
            "Public dataset allowlist is empty — refusing unlinked-asker request",
          );
          throw new Error(PROACTIVE_USER_SAFE_ERROR_MESSAGE);
        }
        actor = buildAnonymousActor(threadId, asker);
        toolRegistry = createPublicDatasetToolRegistry(
          allowlist.map((entry) => entry.entityName),
        );
      }
    } catch (err) {
      // Identity / allowlist resolution failures already logged above
      // with their own `event` tags. Rethrow the user-safe error
      // (preserving the cause chain) and stop — the agent must NOT
      // run with a half-resolved actor.
      if (
        err instanceof Error &&
        err.message === PROACTIVE_USER_SAFE_ERROR_MESSAGE
      ) {
        throw err;
      }
      log.error(
        {
          threadId,
          askerId,
          atlasUserId,
          workspaceId,
          errorMessage: errorMessage(err),
          event: "proactive.answer.identity_failed",
        },
        "Proactive answer adapter identity resolution failed — rethrowing user-safe error",
      );
      throw new Error(PROACTIVE_USER_SAFE_ERROR_MESSAGE, { cause: err });
    }

    // 2. Pull `AtlasAiModel` from the captured runtime -------------------
    // Tracked separately so an Effect Layer / provider misconfiguration
    // surfaces with its own `event` tag — distinguishes "model
    // resolver is broken" from the broader agent loop catch below.
    let aiModel: AtlasAiModelShape;
    try {
      aiModel = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* AtlasAiModel;
        }),
      );
    } catch (err) {
      log.error(
        {
          threadId,
          askerId,
          atlasUserId,
          workspaceId,
          errorMessage: errorMessage(err),
          event: "proactive.answer.model_resolution_failed",
        },
        "Proactive answer adapter could not resolve AtlasAiModel from runtime",
      );
      throw new Error(PROACTIVE_USER_SAFE_ERROR_MESSAGE, { cause: err });
    }

    // 3. Run the agent inside a synthesized RequestContext --------------
    try {
      const stream = await withRequestContext(
        {
          requestId,
          user: actor,
          agentOrigin: "slack",
        },
        () =>
          runAgent({
            messages: [
              {
                id: requestId,
                role: "user" as const,
                parts: [{ type: "text" as const, text: question }],
              },
            ],
            aiModel,
            ...(toolRegistry ? { tools: toolRegistry } : {}),
            // #2705 — pass through the listener's presentation mode so
            // the system prompt branches to the conversational shape.
            presentationMode,
          }),
      );

      // 4. Map streamText result → ProactiveQueryResult -----------------
      const [text, steps] = await Promise.all([stream.text, stream.steps]);
      const collected = collectProactiveResult(text, steps);

      log.info(
        {
          threadId,
          askerId,
          atlasUserId,
          workspaceId,
          linked: atlasUserId !== null,
          sqlCount: collected.sql.length,
          dataCount: collected.data.length,
          entitiesCount: collected.entitiesReferenced.length,
          metricsCount: collected.metricsReferenced.length,
        },
        "Proactive answer adapter completed",
      );

      return toProactiveQueryResult(collected);
    } catch (err) {
      log.error(
        {
          threadId,
          askerId,
          atlasUserId,
          workspaceId,
          errorMessage: errorMessage(err),
          event: "proactive.answer.agent_failed",
        },
        "Proactive answer adapter agent run failed — rethrowing user-safe error",
      );
      throw new Error(PROACTIVE_USER_SAFE_ERROR_MESSAGE, { cause: err });
    }
  };
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

async function resolveLinkedActor(
  atlasUserId: AtlasUserId,
  resolveOrgForUser: (id: AtlasUserId) => Promise<string | null>,
  resolveActor: (
    id: AtlasUserId,
    orgId: string | null,
  ) => Promise<AtlasUser | null>,
): Promise<AtlasUser> {
  // Fail-closed F-55: a thrown `resolveOrgForUser` is infra failure,
  // not "user has no org" (that returns null). Letting it propagate
  // keeps the agent from running with orgId=null and short-circuiting
  // the approval gate.
  const orgId = await resolveOrgForUser(atlasUserId);

  const actor = await resolveActor(atlasUserId, orgId);
  if (actor) return actor;

  // Deleted account — refuse rather than run with no actor.
  throw new Error(
    `Linked atlasUserId ${atlasUserId} did not resolve to an actor (deleted account?)`,
  );
}

/**
 * Build a synthetic anonymous actor for unlinked askers. Mirrors
 * {@link botActorUser} but explicitly omits the org so RLS, workspace
 * model routing, and approval rules treat the run as cross-tenant
 * neutral. The synthesized id encodes the thread for log correlation.
 *
 * Bound alongside {@link createPublicDatasetToolRegistry} at the call
 * site — together they form the unlinked-asker enforcement boundary:
 * no org context (RLS / overlays neutral) AND tool-level allowlist
 * gating BEFORE the listener's post-filter ever runs.
 */
function buildAnonymousActor(
  threadId: string,
  asker: ProactiveAsker,
): AtlasUser {
  const platform = normalizeChatPlatform(asker.platform);
  if (platform) {
    // Use the canonical bot-actor format so existing audit / approval
    // consumers recognize the id shape. No org binding — unlinked askers
    // never resolve to a real workspace; the listener's allowlist check
    // is the gate.
    return botActorUser({
      platform,
      externalId: `${PROACTIVE_SYNTHETIC_EXTERNAL_ID}:${threadId}`,
      // `botActorUser` requires `orgId` — pass an empty string so the id
      // shape stays consistent but downstream `activeOrganizationId`
      // checks see the empty value and bail out. (`undefined` would
      // collapse into the synthetic-id suffix.)
      orgId: "",
      ...(asker.externalUserId ? { externalUserId: asker.externalUserId } : {}),
    });
  }

  // Fallback for unknown platforms (e.g. future chat adapters not yet in
  // CHAT_BOT_PLATFORMS). Build a raw synthetic user so we still bind an
  // identity rather than running unauthenticated.
  const synthId = `proactive-bot:${asker.platform}:${threadId}`;
  return createAtlasUser(synthId, "simple-key", synthId, {
    role: "member",
    claims: {
      sub: synthId,
      chat_platform: asker.platform,
      ...(asker.externalUserId !== undefined
        ? { external_user_id: asker.externalUserId }
        : {}),
    },
  });
}

function normalizeChatPlatform(platform: string): ChatBotPlatform | null {
  return (CHAT_BOT_PLATFORMS as readonly string[]).includes(platform)
    ? (platform as ChatBotPlatform)
    : null;
}

/**
 * Default resolver — pick one org the user is a member of, ordered by
 * `organizationId ASC` so multi-org members resolve deterministically.
 * Tests inject a stub via
 * {@link ProactiveAnswerAdapterOptions.resolveOrgForUser}.
 *
 * Adequate for the proactive path because each Slack workspace is
 * single-org-bound at install time (`chat_cache.value.orgId`, post-#2634),
 * so a Slack-asker who is a member of multiple Atlas orgs only sees
 * proactive answers from one of them by definition. Note this is NOT
 * the same policy as the Better Auth sign-in hook in `auth/server.ts`,
 * which only auto-activates when the user has exactly one org; on
 * multi-org members the auth hook leaves activation untouched.
 */
async function defaultResolveOrgForUser(
  atlasUserId: AtlasUserId,
): Promise<string | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<{ organizationId: string }>(
    `SELECT "organizationId"
       FROM member
      WHERE "userId" = $1
      ORDER BY "organizationId" ASC
      LIMIT 1`,
    [atlasUserId],
  );
  return rows.length > 0 ? rows[0].organizationId : null;
}

function describeAskerId(asker: ProactiveAsker): string {
  return asker.externalUserId
    ? `${asker.platform}:${asker.externalUserId}`
    : asker.platform;
}

// ---------------------------------------------------------------------------
// Tool-result extraction
// ---------------------------------------------------------------------------

/** Minimum shape of an `ai`-SDK step the adapter inspects. */
interface AgentStepLike {
  toolResults?: ReadonlyArray<{
    toolName: string;
    input?: unknown;
    output?: unknown;
  }>;
}

/**
 * Internal extraction shape. Carries the SQL + data lists alongside
 * the wire-level {@link ProactiveQueryResult} fields so the adapter
 * can log richer observability without inventing optional fields the
 * plugin's typed contract doesn't accept. Exported for tests; not
 * part of the public adapter surface.
 */
export interface CollectedProactiveResult {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  entitiesReferenced: string[];
  metricsReferenced: string[];
}

const ENTITY_PATH_RE = /entities\/([A-Za-z0-9_\-./]+?)\.ya?ml/g;
const METRIC_PATH_RE = /metrics\/([A-Za-z0-9_\-./]+?)\.ya?ml/g;

/**
 * Walk the agent's step stream and extract the structured fields the
 * proactive listener cares about. Produces the slimmer shape needed by
 * {@link ProactiveQueryResult}: the answer text plus the entity /
 * metric names that drive the listener's allowlist gate, plus internal
 * `sql` / `data` arrays the adapter logs (NOT part of the wire
 * contract). {@link toProactiveQueryResult} narrows the shape to what
 * the plugin accepts.
 */
export function collectProactiveResult(
  answer: string,
  steps: ReadonlyArray<AgentStepLike>,
): CollectedProactiveResult {
  const sql: string[] = [];
  const data: { columns: string[]; rows: Record<string, unknown>[] }[] = [];
  const entitiesReferenced = new Set<string>();
  const metricsReferenced = new Set<string>();

  for (const step of steps) {
    if (!step.toolResults) continue;
    for (const tr of step.toolResults) {
      if (tr.toolName === "executeSQL") {
        const out = tr.output as
          | {
              success?: boolean;
              columns?: string[];
              rows?: Record<string, unknown>[];
            }
          | undefined;
        const inp = tr.input as { sql?: string } | undefined;
        if (inp?.sql) sql.push(inp.sql);
        if (out?.success && out.columns && out.rows) {
          data.push({ columns: out.columns, rows: out.rows });
        }
      } else if (tr.toolName === "explore") {
        // Pull entity / metric YAML paths from the explore command. The
        // tool accepts free-form bash (`cat entities/x.yml`,
        // `grep -r revenue metrics/`, etc.) so a regex scan over the
        // raw command is the most reliable extraction without a parser.
        const inp = tr.input as { command?: string } | undefined;
        if (typeof inp?.command === "string") {
          for (const match of inp.command.matchAll(ENTITY_PATH_RE)) {
            entitiesReferenced.add(match[1]);
          }
          for (const match of inp.command.matchAll(METRIC_PATH_RE)) {
            metricsReferenced.add(match[1]);
          }
        }
      }
    }
  }

  return {
    answer,
    sql,
    data,
    entitiesReferenced: Array.from(entitiesReferenced),
    metricsReferenced: Array.from(metricsReferenced),
  };
}

/**
 * Narrow {@link CollectedProactiveResult} to the wire-level
 * {@link ProactiveQueryResult} the plugin accepts. Empty array fields
 * stay omitted so the listener's `entitiesReferenced ?? []` fallback
 * fires (matches the pre-existing "host doesn't report this" branch in
 * the listener docs).
 */
export function toProactiveQueryResult(
  collected: CollectedProactiveResult,
): ProactiveQueryResult {
  const developerView = collected.data.length > 0
    ? renderDataAsMarkdownTables(collected.data)
    : "";
  return {
    answer: collected.answer,
    ...(collected.entitiesReferenced.length > 0
      ? { entitiesReferenced: collected.entitiesReferenced }
      : {}),
    ...(collected.metricsReferenced.length > 0
      ? { metricsReferenced: collected.metricsReferenced }
      : {}),
    // #2705 — surface SQL + developer view so the chat plugin can
    // render the "Show SQL" / "Show details" disclosure buttons on
    // conversational responses. Both fields are optional; the listener
    // omits the corresponding button when empty/absent.
    ...(collected.sql.length > 0 ? { sql: collected.sql } : {}),
    ...(developerView.length > 0 ? { developerView } : {}),
  };
}

/**
 * Render the collected tool data as a markdown-tables string for the
 * "Show details" disclosure (#2705). Each tool-result becomes a
 * separate table; rows beyond {@link DEVELOPER_VIEW_ROW_CAP} are
 * truncated with a "+N more" footer so the post stays under Slack's
 * 40k-char block limit even on chatty answers.
 *
 * Caps are applied per-table — a single 10k-row result is summarized;
 * three small results render in full. After per-table truncation, an
 * overall byte-cap ({@link DEVELOPER_VIEW_MAX_CHARS}) is enforced —
 * wide columns can push a 50-row table well past Slack's limit even
 * with the row cap. Truncation is intentionally lossy: the developer
 * view is a convenience disclosure, not the authoritative answer (the
 * actual CSV / dashboard lives in Atlas).
 */
const DEVELOPER_VIEW_ROW_CAP = 50;
// Slack's max block_kit `text` length is 3000 chars; max post message
// length is ~40000. We cap well below 40000 so the "```" code fence
// wrapping the disclosure post (and Slack's own envelope overhead)
// leaves headroom.
const DEVELOPER_VIEW_MAX_CHARS = 30_000;

export function renderDataAsMarkdownTables(
  data: ReadonlyArray<{ columns: string[]; rows: Record<string, unknown>[] }>,
): string {
  const parts: string[] = [];
  for (const result of data) {
    if (result.columns.length === 0) continue;
    const headerCells = result.columns.map((c) => escapeCell(c));
    const headerLine = `| ${headerCells.join(" | ")} |`;
    const separatorLine = `| ${headerCells.map(() => "---").join(" | ")} |`;
    const visibleRows = result.rows.slice(0, DEVELOPER_VIEW_ROW_CAP);
    const bodyLines = visibleRows.map((row) => {
      const cells = result.columns.map((col) => escapeCell(formatCell(row[col])));
      return `| ${cells.join(" | ")} |`;
    });
    const truncatedCount = result.rows.length - visibleRows.length;
    const truncationLine =
      truncatedCount > 0 ? `\n_… ${truncatedCount} more row${truncatedCount === 1 ? "" : "s"} omitted_` : "";
    parts.push([headerLine, separatorLine, ...bodyLines].join("\n") + truncationLine);
  }
  const rendered = parts.join("\n\n");
  if (rendered.length <= DEVELOPER_VIEW_MAX_CHARS) return rendered;
  // Overflow: hard-truncate to the byte cap and append a marker so the
  // reader knows they're seeing a tail-clipped view. Slicing on chars
  // rather than rows is intentional — a single very-wide row blows the
  // budget on its own and per-row truncation wouldn't help.
  return (
    rendered.slice(0, DEVELOPER_VIEW_MAX_CHARS) +
    "\n\n_… developer view truncated (exceeded character budget — see Atlas for the full result)_"
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  // Date arrives as a real Date object from pg's type parser; default
  // `String(date)` produces a locale-dependent string with no timezone
  // ("Mon May 23 2026 …") which is ambiguous in a chat post. ISO is
  // canonical and shorter.
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeCell(value: string): string {
  // Escape backslashes first so a pre-existing "\" in the data doesn't
  // collide with the pipe-escape we add next — otherwise input like
  // "\|" would become "\\|" which the markdown renderer reads as an
  // escaped backslash followed by a raw pipe, breaking the table.
  // Then escape pipes (table delimiter) and collapse newlines so a
  // single row stays on one line in the rendered markdown.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n+\s*/g, " ");
}
