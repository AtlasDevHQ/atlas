/**
 * Demo tracking data layer (#3931 scope B) — the SQL + pure assembly behind the
 * /platform/demo routes. Lives in `lib/` (not the route file) so the queries
 * and the fold/join logic are unit- and `-pg`-testable without the route's auth
 * graph, and so the data layer stays above the Hono layer (CLAUDE.md).
 *
 * Demo turns are identified by `conversations.surface = 'demo'`; `token_usage`
 * rows join through `conversation_id`. A lead email maps to its synthetic
 * conversation `user_id` via {@link demoUserId} (sha256 — the email is never
 * stored on conversations), so the JS-side join keys hashed id → email.
 */

import { demoUserId } from "@atlas/api/lib/demo";
import { estimateCostUsd } from "@atlas/api/lib/token-pricing";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LEADS_LIMIT = 500;
export const TRANSCRIPT_CONVERSATION_LIMIT = 100;

// ---------------------------------------------------------------------------
// SQL — hoisted so each statement is greppable
// ---------------------------------------------------------------------------
//
// `token_usage.conversation_id` is `text` while `conversations.id` is `uuid`;
// Postgres has no implicit `text = uuid` operator, so every join across that
// seam casts the uuid side with `::text`. `messages.conversation_id` is `uuid`,
// so the transcript message lookup casts the bound id array with `::uuid[]`.

export const LEADS_SQL = `
  SELECT email, session_count, created_at, last_active_at
  FROM demo_leads
  ORDER BY last_active_at DESC
  LIMIT $1
`;

/** Per-(user, model) token rollup over demo turns. Keyed back to email in JS. */
export const LEADS_USAGE_SQL = `
  SELECT c.user_id AS user_id, tu.model AS model, tu.provider AS provider,
         COUNT(*)::int AS turns,
         COALESCE(SUM(tu.prompt_tokens), 0)::bigint AS prompt_tokens,
         COALESCE(SUM(tu.completion_tokens), 0)::bigint AS completion_tokens,
         COALESCE(SUM(tu.cache_read_tokens), 0)::bigint AS cache_read_tokens,
         COALESCE(SUM(tu.cache_write_tokens), 0)::bigint AS cache_write_tokens,
         AVG(tu.latency_ms)::float8 AS avg_latency_ms,
         COUNT(tu.latency_ms)::int AS latency_count
  FROM conversations c
  JOIN token_usage tu ON tu.conversation_id = c.id::text
  WHERE c.surface = 'demo' AND c.user_id IS NOT NULL
  GROUP BY c.user_id, tu.model, tu.provider
`;

export const LEADS_CONV_COUNT_SQL = `
  SELECT user_id, COUNT(*)::int AS conversation_count
  FROM conversations
  WHERE surface = 'demo' AND user_id IS NOT NULL
  GROUP BY user_id
`;

/**
 * Global per-model rollup over all demo turns (independent of leads). The
 * per-model `GROUP BY` is LOAD-BEARING for cost correctness: {@link assembleMetrics}
 * prices each row by its own model and sums, and so do the totals. Collapsing
 * the grouping (e.g. `SUM` across models) would hand a mixed-model bucket to
 * {@link estimateCostUsd}, which would price the whole thing at one family's
 * rate — silently wrong. Do not remove `tu.model` from the GROUP BY.
 */
export const METRICS_PER_MODEL_SQL = `
  SELECT tu.model AS model, tu.provider AS provider,
         COUNT(*)::int AS turns,
         COALESCE(SUM(tu.prompt_tokens), 0)::bigint AS prompt_tokens,
         COALESCE(SUM(tu.completion_tokens), 0)::bigint AS completion_tokens,
         COALESCE(SUM(tu.cache_read_tokens), 0)::bigint AS cache_read_tokens,
         COALESCE(SUM(tu.cache_write_tokens), 0)::bigint AS cache_write_tokens,
         AVG(tu.latency_ms)::float8 AS avg_latency_ms,
         COUNT(tu.latency_ms)::int AS latency_count
  FROM token_usage tu
  JOIN conversations c ON c.id::text = tu.conversation_id
  WHERE c.surface = 'demo'
  GROUP BY tu.model, tu.provider
  ORDER BY turns DESC
`;

export const METRICS_LEAD_COUNTS_SQL = `
  SELECT COUNT(*)::int AS lead_count,
         COALESCE(SUM(session_count), 0)::int AS session_count
  FROM demo_leads
`;

export const TRANSCRIPT_CONV_SQL = `
  SELECT id, title, created_at
  FROM conversations
  WHERE user_id = $1 AND surface = 'demo'
  ORDER BY created_at DESC
  LIMIT $2
`;

export const TRANSCRIPT_MSG_SQL = `
  SELECT conversation_id, role, content, created_at
  FROM messages
  WHERE conversation_id = ANY($1::uuid[])
  ORDER BY created_at ASC
`;

// ---------------------------------------------------------------------------
// Row types (DB boundary). `& Record<string, unknown>` satisfies the
// `queryEffect<T extends Record<string, unknown>>` constraint. Bigint SUMs come
// back from the `pg` driver as strings; COUNT/AVG come back as numbers.
// ---------------------------------------------------------------------------

export type LeadRow = {
  email: string;
  session_count: number;
  created_at: string | Date;
  last_active_at: string | Date;
} & Record<string, unknown>;

export type UsageRow = {
  user_id: string;
  model: string | null;
  provider: string | null;
  turns: number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  avg_latency_ms: number | null;
  latency_count: number;
} & Record<string, unknown>;

export type ConvCountRow = {
  user_id: string;
  conversation_count: number;
} & Record<string, unknown>;

export type LeadCountsRow = {
  lead_count: number;
  session_count: number;
} & Record<string, unknown>;

export type TranscriptConvRow = {
  id: string;
  title: string | null;
  created_at: string | Date;
} & Record<string, unknown>;

export type TranscriptMsgRow = {
  conversation_id: string;
  role: string;
  content: unknown;
  created_at: string | Date;
} & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Response shapes (wire). Mirrored by the route's zod schemas + the web-local
// schemas in `packages/web/src/ui/lib/admin-schemas.ts` — keep in lockstep.
// ---------------------------------------------------------------------------

export interface DemoTokenRollup {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
}

export interface DemoLead {
  email: string;
  sessionCount: number;
  firstSeen: string;
  lastActive: string;
  conversationCount: number;
  usage: DemoTokenRollup;
}

export interface DemoPerModel extends DemoTokenRollup {
  model: string | null;
  provider: string | null;
}

export interface DemoMetrics {
  leadCount: number;
  sessionCount: number;
  totals: DemoTokenRollup & { costComplete: boolean };
  perModel: DemoPerModel[];
}

export interface DemoTranscriptMessage {
  role: string;
  content: unknown;
  createdAt: string;
}

export interface DemoTranscriptConversation {
  id: string;
  title: string | null;
  createdAt: string;
  messages: DemoTranscriptMessage[];
}

export interface DemoTranscript {
  email: string;
  conversations: DemoTranscriptConversation[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoOf(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

/** Coerce a bigint-string / number column to a finite number (NaN → 0). */
function num(v: string | number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Latency-count-weighted average across rows, or null when no row had latency. */
export function weightedAvgLatency(
  parts: ReadonlyArray<{ avg: number | null; count: number }>,
): number | null {
  let weightedSum = 0;
  let totalCount = 0;
  for (const p of parts) {
    if (p.avg != null && p.count > 0) {
      weightedSum += p.avg * p.count;
      totalCount += p.count;
    }
  }
  return totalCount > 0 ? weightedSum / totalCount : null;
}

/**
 * Fold per-(user|null, model) usage rows into one token rollup, summing the
 * per-model estimated cost. `estimatedCostUsd` is null only when EVERY model in
 * the group is unpriced (so the UI shows "—" rather than a misleading $0);
 * `costComplete` is false when the estimate is PARTIAL (some priced, some not).
 * Pricing each row independently keeps totals == sum-of-per-model costs.
 */
export function foldUsage(
  rows: ReadonlyArray<UsageRow>,
): DemoTokenRollup & { costComplete: boolean } {
  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costSum = 0;
  let anyPriced = false;
  let anyUnpriced = false;
  const latencyParts: Array<{ avg: number | null; count: number }> = [];

  for (const r of rows) {
    const prompt = num(r.prompt_tokens);
    const completion = num(r.completion_tokens);
    const cacheRead = num(r.cache_read_tokens);
    const cacheWrite = num(r.cache_write_tokens);
    turns += r.turns;
    promptTokens += prompt;
    completionTokens += completion;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    latencyParts.push({ avg: r.avg_latency_ms, count: r.latency_count });

    const cost = estimateCostUsd(r.model, {
      promptTokens: prompt,
      completionTokens: completion,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });
    if (cost == null) {
      anyUnpriced = true;
    } else {
      anyPriced = true;
      costSum += cost;
    }
  }

  return {
    turns,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    avgLatencyMs: weightedAvgLatency(latencyParts),
    estimatedCostUsd: anyPriced ? costSum : null,
    costComplete: !anyUnpriced,
  };
}

/** Drop the `costComplete` flag for the per-lead/per-model rollup shape. */
function toRollup(folded: DemoTokenRollup & { costComplete: boolean }): DemoTokenRollup {
  const { costComplete: _omit, ...rollup } = folded;
  return rollup;
}

/**
 * Assemble the leads list: each demo lead with its per-email token/cache/latency
 * rollup. Usage rows whose `user_id` hash maps to no surviving lead are dropped
 * (a deleted lead shouldn't resurrect) — those tokens still appear in
 * {@link assembleMetrics} totals, so the two surfaces can legitimately disagree.
 */
export function assembleLeads(
  leadRows: ReadonlyArray<LeadRow>,
  usageRows: ReadonlyArray<UsageRow>,
  convCountRows: ReadonlyArray<ConvCountRow>,
): DemoLead[] {
  const emailByUid = new Map<string, string>();
  for (const lead of leadRows) emailByUid.set(demoUserId(lead.email), lead.email);

  const usageByEmail = new Map<string, UsageRow[]>();
  for (const row of usageRows) {
    const email = emailByUid.get(row.user_id);
    if (!email) continue; // demo conversation with no surviving lead row
    const list = usageByEmail.get(email);
    if (list) list.push(row);
    else usageByEmail.set(email, [row]);
  }

  const convCountByUid = new Map<string, number>();
  for (const row of convCountRows) convCountByUid.set(row.user_id, row.conversation_count);

  return leadRows.map((lead) => {
    const uid = demoUserId(lead.email);
    const folded = foldUsage(usageByEmail.get(lead.email) ?? []);
    return {
      email: lead.email,
      sessionCount: lead.session_count,
      firstSeen: isoOf(lead.created_at),
      lastActive: isoOf(lead.last_active_at),
      conversationCount: convCountByUid.get(uid) ?? 0,
      usage: toRollup(folded),
    };
  });
}

/** Assemble the global token/cache/latency rollup: aggregate totals + per-model. */
export function assembleMetrics(
  perModelRows: ReadonlyArray<UsageRow>,
  leadCountRows: ReadonlyArray<LeadCountsRow>,
): DemoMetrics {
  const perModel: DemoPerModel[] = perModelRows.map((r) => ({
    model: r.model,
    provider: r.provider,
    ...toRollup(foldUsage([r])),
  }));

  const totals = foldUsage(perModelRows);
  const counts = leadCountRows[0] ?? { lead_count: 0, session_count: 0 };

  return {
    leadCount: counts.lead_count,
    sessionCount: counts.session_count,
    totals,
    perModel,
  };
}

/** Assemble a lead's transcript: demo conversations with their messages grouped. */
export function assembleTranscript(
  email: string,
  convRows: ReadonlyArray<TranscriptConvRow>,
  msgRows: ReadonlyArray<TranscriptMsgRow>,
): DemoTranscript {
  const msgsByConv = new Map<string, TranscriptMsgRow[]>();
  for (const m of msgRows) {
    const list = msgsByConv.get(m.conversation_id);
    if (list) list.push(m);
    else msgsByConv.set(m.conversation_id, [m]);
  }

  const conversations = convRows.map((conv) => ({
    id: conv.id,
    title: conv.title,
    createdAt: isoOf(conv.created_at),
    messages: (msgsByConv.get(conv.id) ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: isoOf(m.created_at),
    })),
  }));

  return { email, conversations };
}
