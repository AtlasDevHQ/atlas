/**
 * Admin proactive-chat analytics route (#2296).
 *
 * Surfaces the `AnswerMeter` summary so the admin console can render
 * per-channel rollups, monthly counts, and the helpful / not-helpful
 * split. The visible admin UI panel lands in #2294; this route is the
 * data wire and is exposed independently so a CLI or external dashboard
 * can pull the same rollup without re-implementing the SQL.
 *
 * Enterprise-gated: proactive chat is a paid 1.5.0 tier (per PRD #2291).
 * A 403 with `code: "enterprise_required"` arrives via `EnterpriseError`
 * when the gate is closed — the admin page can route through
 * `EnterpriseUpsell` the same way it does for SSO / SCIM / residency.
 */

import { Effect } from "effect";
import { requireFeatureEntitlement } from "@atlas/api/lib/billing/feature-entitlement-guard";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  AnswerMeter,
  ProactiveGate,
  ProactiveService,
  RequestContext,
} from "@atlas/api/lib/effect/services";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-proactive-analytics");

// ---------------------------------------------------------------------------
// since= parser
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the `since` query param into a millisecond lookback window.
 *
 * Accepts `<n>d`, `<n>h`, or bare `<n>` (seconds). Defaults to 30 days
 * when missing/empty/unparsable. Caps at `MAX_WINDOW_DAYS` so a
 * runaway client cannot ask for "the last 10 years" and force a table
 * scan over churning audit rows.
 */
export function parseSinceMs(raw: string | undefined): number {
  if (!raw || raw.length === 0) return DEFAULT_WINDOW_DAYS * DAY_MS;
  const match = /^(\d+)\s*([dhms]?)$/i.exec(raw.trim());
  if (!match) return DEFAULT_WINDOW_DAYS * DAY_MS;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS * DAY_MS;
  const unit = (match[2] ?? "").toLowerCase();
  let ms: number;
  switch (unit) {
    case "d":
      ms = n * DAY_MS;
      break;
    case "h":
      ms = n * 60 * 60 * 1000;
      break;
    case "m":
      ms = n * 60 * 1000;
      break;
    case "s":
    case "":
      ms = n * 1000;
      break;
    default:
      ms = DEFAULT_WINDOW_DAYS * DAY_MS;
  }
  const cap = MAX_WINDOW_DAYS * DAY_MS;
  return Math.min(ms, cap);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminProactiveAnalytics = createAdminRouter();

adminProactiveAnalytics.use(requireOrgContext());
// `admin:audit` is the closest existing permission flag — analytics is
// an observability surface like the audit log readers. When the
// proactive PRD lands its own permission key, the gate moves here.
adminProactiveAnalytics.use(requirePermission("admin:audit"));

adminProactiveAnalytics.get("/", async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();

      // orgId is guaranteed non-null by `requireOrgContext()` on this router (#4356).
      const { orgId } = c.get("orgContext");
      const { requestId } = yield* RequestContext;
      // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
      // where the enterprise-license Tag above is the gate. (#4064 / #3984)
      yield* requireFeatureEntitlement(orgId, "proactive");

      const sinceParam = c.req.query("since");
      const sinceMs = parseSinceMs(sinceParam);

      const meter = yield* AnswerMeter;
      const proactiveSvc = yield* ProactiveService;
      const summary = yield* Effect.tryPromise({
        try: () => meter.summary(orgId, sinceMs),
        catch: (err) =>
          err instanceof Error ? err : new Error(String(err)),
      });

      // Monthly quota snapshot (#2301). Lives next to the rolling
      // summary so the admin UI can render "classify usage this month"
      // alongside the rolling window — different time horizons, same
      // panel. `getWorkspaceQuotaStatus` fails open on its own (returns
      // `capReached: false` with null cap), so we don't need a separate
      // try/catch here. Read on every render: COUNT(*) over the current
      // month's classify rows is bounded by the 0078 index.
      const quota = yield* proactiveSvc.getWorkspaceQuotaStatus(orgId);

      log.info(
        {
          requestId,
          orgId,
          sinceMs,
          classifyCount: summary.classifyCount,
          reactCount: summary.reactCount,
          classifyCountThisMonth: quota.classifyCountThisMonth,
          monthlyClassifierCap: quota.monthlyClassifierCap,
          capReached: quota.capReached,
        },
        "proactive analytics summary served",
      );

      return c.json(
        {
          workspaceId: orgId,
          sinceMs,
          summary,
          quota: {
            classifyCountThisMonth: quota.classifyCountThisMonth,
            monthlyClassifierCap: quota.monthlyClassifierCap,
            capReached: quota.capReached,
          },
        },
        200,
      );
      // `AnswerMeter` + `ProactiveService` resolve from the app-level
      // EnterpriseLayer (EE `*Live` or the fail-closed Noop) — no
      // per-route provide. Proactive chat is enterprise-gated above (#3999).
    }),
    { label: "proactive analytics summary" },
  );
});

export { adminProactiveAnalytics };
