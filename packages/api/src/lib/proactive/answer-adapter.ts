/**
 * Proactive answer adapter — host-side `executeQueryProactive` factory
 * (slice 2a of #2607).
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
 *     full workspace toolset.
 *   - **Unlinked asker** (`context.atlasUserId === null`) — synthesize
 *     an anonymous chat-bot actor with no `activeOrganizationId`. The
 *     agent runs without RLS / org-scoped semantic overlays; the
 *     listener's `checkResultAgainstAllowlist` belt-and-braces gate is
 *     the enforcement boundary for public-dataset entities.
 *
 * Reused by slice 3 of #2607 (chat plugin's main `executeQuery` for the
 * `@mention` migration) so the same identity-binding semantics apply to
 * direct mentions too.
 *
 * Errors:
 *   - All thrown errors are caught, logged structurally with
 *     `{ threadId, askerId, errorMessage }`, and re-thrown as a
 *     user-safe {@link Error} (`"Atlas couldn't answer this — your
 *     admin has been notified."`). The listener catches the rethrow and
 *     posts a generic "hit an error" reply; the operator sees the real
 *     stack via the log.
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
  ProactiveAsker,
  ProactiveExecuteQuery,
  ProactiveQueryResult,
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

const log = createLogger("proactive:answer-adapter");

/**
 * User-safe error surfaced to the proactive listener. The listener
 * catches whatever this adapter throws and posts a generic "Sorry — I
 * hit an error" reply, so we explicitly avoid leaking the underlying DB
 * / agent stack into the rethrown message. Developer detail is logged
 * via `log.error` with structured fields before the rethrow.
 */
export const PROACTIVE_USER_SAFE_ERROR_MESSAGE =
  "Atlas couldn't answer this — your admin has been notified.";

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
   */
  resolveOrgForUser?: (atlasUserId: string) => Promise<string | null>;
  /**
   * Resolve the actor identity for a linked user. Defaults to
   * {@link loadActorUser}.
   */
  resolveActor?: (
    atlasUserId: string,
    orgId: string | null,
  ) => Promise<AtlasUser | null>;
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

  return async (question, context): Promise<ProactiveQueryResult> => {
    const requestId = crypto.randomUUID();
    const { threadId, asker, atlasUserId } = context;
    const askerId = describeAskerId(asker);

    try {
      // 1. Resolve identity ------------------------------------------------
      const actor = atlasUserId
        ? await resolveLinkedActor(atlasUserId, resolveOrgForUser, resolveActor)
        : buildAnonymousActor(threadId, asker);

      // 2. Pull `AtlasAiModel` from the captured runtime ------------------
      const aiModel: AtlasAiModelShape = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* AtlasAiModel;
        }),
      );

      // 3. Run the agent inside a synthesized RequestContext --------------
      const stream = await withRequestContext(
        {
          requestId,
          ...(actor ? { user: actor } : {}),
          approvalSurface: "slack",
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
          }),
      );

      // 4. Map streamText result → ProactiveQueryResult -------------------
      const [text, steps] = await Promise.all([stream.text, stream.steps]);
      const collected = collectProactiveResult(text, steps);

      log.info(
        {
          threadId,
          askerId,
          atlasUserId,
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
      const detail = errorMessage(err);
      log.error(
        {
          threadId,
          askerId,
          atlasUserId,
          errorMessage: detail,
        },
        "Proactive answer adapter failed — rethrowing user-safe error",
      );
      throw new Error(PROACTIVE_USER_SAFE_ERROR_MESSAGE, { cause: err });
    }
  };
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

async function resolveLinkedActor(
  atlasUserId: string,
  resolveOrgForUser: (id: string) => Promise<string | null>,
  resolveActor: (id: string, orgId: string | null) => Promise<AtlasUser | null>,
): Promise<AtlasUser | null> {
  let orgId: string | null = null;
  try {
    orgId = await resolveOrgForUser(atlasUserId);
  } catch (err) {
    // Treat as "no org" — `loadActorUser` will still return a usable
    // actor (without orgId); the agent runs with reduced scope and the
    // approval gate short-circuits per `botActorUser` semantics.
    log.warn(
      { atlasUserId, err: errorMessage(err) },
      "resolveOrgForUser failed — proceeding with linked actor minus org context",
    );
  }

  const actor = await resolveActor(atlasUserId, orgId);
  if (actor) return actor;

  // User row missing (deleted account) — fall back to anonymous synthetic
  // identity so the agent still answers what it can. The listener's
  // post-filter remains the public-dataset gate.
  log.warn(
    { atlasUserId, orgId },
    "Linked atlasUserId did not resolve to an actor — degrading to anonymous identity",
  );
  return null;
}

/**
 * Build a synthetic anonymous actor for unlinked askers. Mirrors
 * {@link botActorUser} but explicitly omits the org so RLS, workspace
 * model routing, and approval rules treat the run as cross-tenant
 * neutral. The synthesized id encodes the thread for log correlation.
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
 * Default resolver — pick the first org the user is a member of. Tests
 * inject a stub via {@link ProactiveAnswerAdapterOptions.resolveOrgForUser}.
 *
 * Single-row `LIMIT 1` matches the activation heuristic in
 * `auth/server.ts` (the Better Auth hook that auto-activates an org on
 * sign-in). If the user belongs to multiple orgs this picks one
 * deterministically (lexical `organizationId` order); for the proactive
 * path that's adequate because the Slack workspace itself is
 * single-org-bound at install time.
 */
async function defaultResolveOrgForUser(
  atlasUserId: string,
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
 * plugin's typed contract doesn't accept. Exported for tests.
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
 * proactive listener cares about. Mirrors {@link executeAgentQuery}'s
 * loop but produces the slimmer shape needed by
 * {@link ProactiveQueryResult} (no `pendingActions` / `pendingApproval`
 * — those branches don't apply to the proactive flow yet). The returned
 * `sql`/`data` arrays are not part of the wire contract; the adapter
 * uses them for logging and to seed slice-2 callers that want richer
 * cards later. {@link toProactiveQueryResult} narrows the shape to
 * what the plugin accepts.
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
  return {
    answer: collected.answer,
    ...(collected.entitiesReferenced.length > 0
      ? { entitiesReferenced: collected.entitiesReferenced }
      : {}),
    ...(collected.metricsReferenced.length > 0
      ? { metricsReferenced: collected.metricsReferenced }
      : {}),
  };
}
