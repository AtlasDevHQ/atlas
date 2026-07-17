/**
 * Tool-side seeding (#4558, ADR-0034 Decision 1) — the build-time half of the
 * seeding decision.
 *
 * `createDashboard` and the bound `addCard` execute each staged card's SQL
 * ONCE inside the tool call and persist the result as the card's initial
 * DRAFT CACHE (`saveDraftCardCache`, #4554), so a chat-built board arrives
 * showing real data instead of a grid of "Never run" tiles. The tool result
 * carries a per-card outcome (rows / empty / error / unseeded) so the agent can
 * self-correct in the SAME turn instead of announcing a board with broken
 * cards.
 *
 * Three invariants, all from the ADR + the issue's acceptance criteria:
 *
 *   - **Full SQL pipeline.** Every card runs through `runUserQueryPipeline` —
 *     the exact validation / RLS / audit / masking guard `executeSQL` and the
 *     single-card draft refresh use. Seeding is never a privileged side-channel.
 *   - **Fail-soft per card.** A card whose SQL fails at execution is still
 *     staged (the caller has already written the draft snapshot); it is only
 *     reported `error` here — a failed seed NEVER fails the build.
 *   - **Wall-clock budget.** The whole batch is bounded by a single wall clock
 *     ({@link SEED_WALL_CLOCK_BUDGET_MS}); a card still in flight when the
 *     budget elapses is left staged-unseeded and reported `unseeded`, to be
 *     populated by the canvas-mount draft render (#4557). Zero agent-step cost
 *     regardless of board size — the seeding runs concurrently inside one tool
 *     call, so the 25-step agent budget is untouched.
 *
 * The budget is an internal safety valve, not operator configuration, so it is
 * a module constant — no new environment variable (per the issue's acceptance
 * criteria) and no redeploy-gated knob. Per the PRD it becomes a
 * settings-registry knob (never an env var) only IF a concrete tuning need
 * appears.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { runUserQueryPipeline, type UserQueryOutcome } from "@atlas/api/lib/tools/sql";
import { saveDraftCardCache } from "@atlas/api/lib/dashboard-draft-cache";

const log = createLogger("dashboard-seeding");

/**
 * Wall-clock budget (ms) for one seeding batch. Cards execute concurrently, so
 * this bounds the whole batch, not each card. A card still running when it
 * elapses is left staged-unseeded (the canvas-mount render fills it in later),
 * never failed. Chosen well below (half of) the default per-statement timeout
 * (`ATLAS_QUERY_TIMEOUT`, 30s) so a single pathological card can't hold the
 * tool call open for the full statement timeout while the rest of the board
 * waits.
 */
export const SEED_WALL_CLOCK_BUDGET_MS = 15_000;

/** Longest per-card error message echoed back to the agent (defensive cap — the
 *  pipeline already scrubs secrets, this just keeps the tool envelope compact). */
const MAX_SEED_ERROR_LEN = 300;

/** One card to seed: its stable draft id, its title, its SQL, and the physical
 *  connection it should run against (null → the workspace default datasource). */
export interface SeedCardSpec {
  readonly cardId: string;
  readonly title: string;
  readonly sql: string;
  readonly connectionId: string | null;
}

/** A seed card before its connection is resolved. Callers that resolve one
 *  connection for the whole batch (createDashboard) build these, then stamp the
 *  resolved `connectionId` on each — so the field set can't drift from
 *  {@link SeedCardSpec}. */
export type SeedCardInput = Omit<SeedCardSpec, "connectionId">;

export interface SeedDraftCardsOptions {
  readonly userId: string;
  readonly dashboardId: string;
  readonly cards: readonly SeedCardSpec[];
  /**
   * Resolved DEFAULT dashboard parameter values (shared by every card),
   * produced by `resolveDashboardParameterValues`. The seed renders each card
   * with its parameters' defaults — the same values the persisted-cache render
   * uses — never an interactive override.
   */
  readonly parameters: Record<string, string | number | null>;
  /** Whole-batch wall-clock budget in ms. Defaults to {@link SEED_WALL_CLOCK_BUDGET_MS}. */
  readonly budgetMs?: number;
}

/**
 * The outcome of seeding one card, reported back to the agent in the tool
 * result. A tagged union so the agent (and our tests) can branch on `status`
 * rather than sniffing `rowCount`:
 *   - `rows`     — executed and cached; `rowCount` rows.
 *   - `empty`    — executed and cached; zero rows (an honest empty tile).
 *   - `error`    — execution / validation failed; the card is still staged.
 *                  `message` is a scrubbed, agent-actionable reason.
 *   - `unseeded` — the wall-clock budget elapsed before this card finished, OR
 *                  it executed but its draft-cache write failed; either way the
 *                  card is staged-not-seeded and the canvas-mount render fills it.
 */
export type CardSeedOutcome = {
  readonly cardId: string;
  readonly title: string;
} & (
  | { readonly status: "rows"; readonly rowCount: number }
  | { readonly status: "empty" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "unseeded" }
);

/** A sentinel distinct from every {@link UserQueryOutcome} object, so the race
 *  winner is discriminated by identity, not by sniffing shape. */
const TIMEOUT = Symbol("seed-budget-elapsed");

interface Deadline {
  readonly promise: Promise<typeof TIMEOUT>;
  readonly cancel: () => void;
}

function createDeadline(ms: number): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/** Map a non-ok pipeline outcome to a compact, agent-actionable message. Every
 *  non-ok variant carries a `message`, so it's read directly (fall back to the
 *  `kind` only on the degenerate empty-string case). */
function outcomeErrorMessage(outcome: Exclude<UserQueryOutcome, { kind: "ok" }>): string {
  const message = outcome.message || outcome.kind;
  return message.length > MAX_SEED_ERROR_LEN
    ? `${message.slice(0, MAX_SEED_ERROR_LEN)}…`
    : message;
}

async function seedOneCard(
  opts: SeedDraftCardsOptions,
  card: SeedCardSpec,
  deadline: Promise<typeof TIMEOUT>,
): Promise<CardSeedOutcome> {
  const base = { cardId: card.cardId, title: card.title } as const;

  // Attach the failure handler to the pipeline promise BEFORE racing it: if the
  // deadline wins and this card is reported `unseeded`, the still-running
  // pipeline can later reject with a defect (an unexpected throw not covered by
  // its own `catchAll`). Without a handler on the losing promise that becomes a
  // process-level unhandledRejection; here it is logged and folded into a
  // benign outcome, so a timed-out card can never crash the tool call.
  const exec: Promise<UserQueryOutcome> = runUserQueryPipeline({
    sql: card.sql,
    ...(card.connectionId ? { connectionId: card.connectionId } : {}),
    explanation: `Dashboard seed: ${card.title}`,
    parameters: opts.parameters,
  }).catch((err) => {
    log.warn(
      { err: errorMessage(err), dashboardId: opts.dashboardId, cardId: card.cardId },
      "seedDraftCards: pipeline rejected (defect)",
    );
    return { kind: "query_failed", message: "Execution failed unexpectedly." } as const;
  });

  // Neither `exec` (its rejections are absorbed above) nor `deadline` rejects,
  // so this race resolves rather than throws.
  const raced: UserQueryOutcome | typeof TIMEOUT = await Promise.race([exec, deadline]);

  if (raced === TIMEOUT) {
    return { ...base, status: "unseeded" };
  }

  if (raced.kind !== "ok") {
    return { ...base, status: "error", message: outcomeErrorMessage(raced) };
  }

  // Persist to the caller's DRAFT cache (never the published card cache, never
  // the shared Query Cache) — the draft card's own data home (ADR-0034).
  const saved = await saveDraftCardCache(opts.userId, opts.dashboardId, card.cardId, {
    columns: raced.columns,
    rows: raced.rows,
  });
  if (!saved.ok) {
    // The rows executed but couldn't be persisted (no draft row / no DB /
    // transient error). The card is staged; report it unseeded so the agent
    // knows the canvas-mount render — not this tool call — will surface the
    // data. Logged, never silently dropped.
    log.warn(
      {
        reason: saved.reason,
        dashboardId: opts.dashboardId,
        cardId: card.cardId,
      },
      "seedDraftCards: executed but could not persist draft cache",
    );
    return { ...base, status: "unseeded" };
  }

  return raced.rows.length === 0
    ? { ...base, status: "empty" }
    : { ...base, status: "rows", rowCount: raced.rows.length };
}

/**
 * Seed a batch of staged draft cards: execute each card's SQL concurrently
 * through the full user-query pipeline, bounded by one wall clock, fail-soft
 * per card, and persist each success as the card's draft cache. Returns a
 * per-card outcome in the SAME order as `opts.cards`.
 *
 * The caller MUST have already staged these cards into the user's draft (the
 * draft row is the FK anchor `saveDraftCardCache` writes against) — this runs
 * AFTER the snapshot commit, so a seed failure can never leave the build
 * half-committed.
 */
export async function seedDraftCards(
  opts: SeedDraftCardsOptions,
): Promise<CardSeedOutcome[]> {
  if (opts.cards.length === 0) return [];

  const budgetMs = opts.budgetMs ?? SEED_WALL_CLOCK_BUDGET_MS;
  const deadline = createDeadline(budgetMs);
  try {
    return await Promise.all(
      opts.cards.map((card) => seedOneCard(opts, card, deadline.promise)),
    );
  } finally {
    // Clear the timer so a fast batch doesn't hold the event loop for the full
    // budget after every card already resolved.
    deadline.cancel();
  }
}
