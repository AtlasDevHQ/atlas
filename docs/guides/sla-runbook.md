# SLA Runbook (Internal)

> This is an internal operations document. It is NOT published to the docs site.

## Published SLA targets

| Metric              | Team     | Enterprise |
| ------------------- | -------- | ---------- |
| Uptime              | 99.9%    | 99.95%     |
| SQL generation p95  | < 5s     | < 5s       |
| API response p95    | < 500ms  | < 500ms    |
| Support (critical)  | 24h biz  | 4h         |
| Support (high)      | 24h biz  | 8h         |
| Support (normal)    | 24h biz  | 24h        |

## SLA breach detection

### Uptime

**Source:** OpenStatus external monitoring (atlas.openstatus.dev)

- API health endpoint monitored at 10-minute intervals from US East (free tier; upgrade to Starter for 1-min)
- A "down" event is any check that returns non-2xx or times out (10s)
- Monthly uptime = `(total_checks - failed_checks) / total_checks`
- Breach threshold: Team < 99.9% (43.2 min/month), Enterprise < 99.95% (21.6 min/month)

**What triggers an alert:**
- OpenStatus marks a monitor as "degraded" or "down"
- When upgraded to Starter plan: Slack/webhook notifications on status change

**Current limitation (free tier):**
- 1 monitor (API only), 10-min interval, 1 region, 14-day retention
- No automatic alerting — must check dashboard manually
- Upgrade to Starter ($30/mo) adds Slack notifications, 1-min intervals, 28 regions

### Latency

**Source:** Internal `sla_metrics` table (per-workspace)

- Each agent query records `latency_ms` in `sla_metrics`
- `sla_thresholds` table stores per-workspace thresholds (defaults: p99 < 5000ms, error rate < 5%)
- Configurable via `ATLAS_SLA_LATENCY_P99_MS`, `ATLAS_SLA_ERROR_RATE_PCT`, and `ATLAS_SLA_WEBHOOK_URL` env vars

**What triggers an alert:**
- `evaluateAlerts()` in `ee/src/sla/alerting.ts` checks all workspaces, creates/resolves alerts in `sla_alerts`, and delivers webhooks (if `ATLAS_SLA_WEBHOOK_URL` is set)
- Callable on-demand via `POST /api/v1/platform/sla/evaluate`
- Currently: no scheduler invokes it periodically — operators must trigger manually or set up an external cron (e.g., Railway cron job hitting the endpoint)
- Future: add an internal scheduler to call `evaluateAlerts()` on a recurring interval

### Error rate

**Source:** Internal `sla_metrics` table (`is_error` column)

- Error rate = `COUNT(is_error = true) / COUNT(*)` over a rolling window
- Default threshold: 5% (configurable via `ATLAS_SLA_ERROR_RATE_PCT`)

## Communication template

### Incident acknowledgment (< 15 min from detection)

```
Subject: [Atlas] Investigating: {service} {degraded|outage}

We are investigating reports of {describe symptoms}.

- Impact: {who is affected, what is broken}
- Status: Investigating
- Start time: {HH:MM UTC}

We will provide updates every 30 minutes until resolved.

— Atlas Operations
```

### Incident update (every 30 min)

```
Subject: [Atlas] Update: {service} {degraded|outage}

Update at {HH:MM UTC}:

- Current status: {investigating|identified|monitoring|resolved}
- What we know: {root cause if identified}
- Next steps: {what we're doing}
- ETA: {if known, otherwise "investigating"}

— Atlas Operations
```

### Incident resolution

```
Subject: [Atlas] Resolved: {service} {degraded|outage}

The incident affecting {service} has been resolved.

- Duration: {start} to {end} ({X minutes})
- Root cause: {brief description}
- Resolution: {what fixed it}
- Affected plans: {Team, Enterprise, or both}

A post-incident review will be published within 5 business days.
SLA credits (if applicable) will be calculated and applied automatically.

— Atlas Operations
```

## Credit calculation

### Formula

```
credit_minutes = downtime_minutes * 10
credit_amount = (monthly_fee / total_minutes_in_month) * credit_minutes
```

### Rules

1. **10x multiplier** — each minute of unplanned downtime beyond SLA = 10 minutes of credit
2. **Monthly cap** — maximum credit = 100% of monthly fee (30 days equivalent)
3. **Exclusions** — no credits for:
   - Scheduled maintenance (announced 24h+ in advance)
   - Customer-side configuration issues
   - Third-party service outages (LLM providers, customer databases)
   - Force majeure
4. **Application** — credits applied automatically to next billing cycle after incident confirmation
5. **Verification** — use OpenStatus incident history as source of truth for downtime duration

### Example

- Enterprise customer paying $200/seat/mo, 10 seats = $2,000/mo
- 15 minutes of unplanned downtime in a month
- Enterprise SLA allows ~22 min downtime (99.95% of ~43,200 min)
- 15 min < 22 min threshold → no credit owed
- If downtime were 30 min: 30 - 22 = 8 min over SLA → 80 min credit
- Credit = ($2,000 / 43,200) * 80 ≈ $3.70

## Escalation path

| Step | Trigger                          | Who                 | Action                                    |
| ---- | -------------------------------- | ------------------- | ----------------------------------------- |
| 1    | Monitor alert fires              | On-call engineer    | Acknowledge within 15 min, begin triage   |
| 2    | Not resolved within 30 min       | On-call engineer    | Post update, escalate to senior engineer  |
| 3    | Not resolved within 1 hour       | Engineering lead    | Coordinate cross-team response            |
| 4    | Customer-facing > 1 hour         | Engineering lead    | Notify affected Enterprise customers      |
| 5    | SLA breach confirmed             | Operations          | Calculate credits, update status page     |

## Post-incident review process

**Timeline:** Complete within 5 business days of resolution.

### Template

```markdown
# Post-Incident Review: {Title}

**Date:** {YYYY-MM-DD}
**Duration:** {start} to {end} ({X minutes})
**Severity:** {Critical | High | Normal}
**Affected plans:** {Team, Enterprise, or both}

## Summary
{1-2 sentence description of what happened}

## Timeline
- HH:MM UTC — {event}
- HH:MM UTC — {event}

## Root cause
{Technical explanation of what went wrong}

## Resolution
{What was done to fix it}

## Impact
- Users affected: {count or percentage}
- Failed queries: {count}
- SLA credit issued: {yes/no, amount}

## Action items
- [ ] {preventive measure 1} — owner: {name}, due: {date}
- [ ] {preventive measure 2} — owner: {name}, due: {date}
```

### Publication

- Internal review shared in team channel
- Enterprise customers receive a summary if SLA was breached
- Public post-mortem on status page for Critical severity incidents

## Alerting configuration checklist

Current state and what needs configuration:

- [x] **OpenStatus monitor** — API health check at 10-min intervals (monitor ID: 9230)
- [x] **Internal DB tables** — `sla_metrics`, `sla_alerts`, `sla_thresholds` created via migration
- [x] **Default thresholds seeded** — p99 < 5000ms, error rate < 5% (via `runSeeds()`). Note: internal threshold is p99 which is stricter than the published p95 target — alerts fire before public SLA is breached
- [ ] **OpenStatus upgrade** — Starter plan needed for Slack notifications and 1-min intervals
- [ ] **Active alerting daemon** — No process currently polls `sla_metrics` to fire alerts; metrics are recorded but not acted on automatically
- [ ] **Slack notifications** — Requires OpenStatus Starter plan or custom webhook integration
- [ ] **Railway metrics** — Set up dashboard alerts for p95 latency > 5s and error rate > 5%
