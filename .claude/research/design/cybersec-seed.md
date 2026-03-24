# Cybersecurity SaaS Seed Database — Design Document

> Design reference for building a realistic, production-like demo database for Atlas.
> This replaces the simple 3-table demo (50 companies, 200 people, 80 accounts) with a 62-table cybersecurity SaaS company database that includes real-world tech debt patterns.

## Why

The current demo is too clean. Real databases have:
- Tables that nobody uses anymore
- Columns that changed meaning over time
- Foreign keys that exist logically but not as DB constraints
- Denormalized reporting tables
- Inconsistent enum values
- Mixed naming conventions

Atlas needs a harder test bed to prove `atlas init` works on real-world schemas and to give users a realistic demo before connecting their own data.

## Company Profile: "Sentinel Security"

A B2B cybersecurity SaaS company. They sell a vulnerability management + threat detection platform. ~200 customer organizations, ~2,000 users, scanning ~15,000 assets. Founded in 2019, grew fast, accumulated tech debt along the way.

## Target Scale

| Metric | Count |
|--------|-------|
| Tables | 62 |
| Total rows | ~500K |
| Largest table (scan_results) | ~80K rows |
| Time span | 2019–2025 |
| Active customers | ~170 of 200 |

---

## Schema Design

### 1. Core Business (Customer Management) — 7 tables

| Table | Rows | Notes |
|-------|------|-------|
| `organizations` | 200 | Customer companies. Has inconsistent `industry` values (tech debt) |
| `organization_settings` | 200 | Per-org config (JSON-ish text fields, 1:1 with orgs) |
| `users` | 2,000 | Has legacy `role` column (still populated, ignored by app) |
| `teams` | 400 | 2 teams per org avg |
| `team_memberships` | 3,000 | M:M join table, composite PK |
| `roles` | 5 | RBAC roles (admin, analyst, viewer, responder, auditor) |
| `invitations` | 150 | Pending invites (some expired) |

**Tech debt in this group:**
- `organizations.industry` has inconsistent values: 'Technology', 'tech', 'Tech', 'TECHNOLOGY', 'Healthcare', 'healthcare', 'Health Care'
- `users.role` column (TEXT, enum: 'admin'/'analyst'/'viewer') — still populated on every INSERT but the app reads from `team_memberships` + `roles` since 2023. The values often don't match the actual RBAC role
- `users.last_login` — was going to be used for session tracking, mostly NULL, never read

### 2. Billing & Subscriptions — 6 tables

| Table | Rows | Notes |
|-------|------|-------|
| `plans` | 5 | Free, Starter, Professional, Enterprise, Custom |
| `subscriptions` | 250 | Has denormalized `plan_name` that's sometimes out of sync |
| `subscription_events` | 1,200 | Plan changes: upgrade, downgrade, cancel, renew |
| `invoices` | 3,000 | Monthly billing records |
| `invoice_line_items` | 8,000 | Detailed charges per invoice |
| `payment_methods` | 180 | Stored payment info (last4 only, redacted) |

**Tech debt in this group:**
- `subscriptions.plan_name` (TEXT) — denormalized from `plans.name`. Out of sync for ~15% of rows where the plan was renamed but subscriptions weren't updated
- `subscriptions.plan_id` → `plans.id` FK EXISTS (properly constrained)
- `invoice_line_items.subscription_id` → `subscriptions.id` — NO FK CONSTRAINT (logical only)

### 3. Core Product: Asset Management — 6 tables

| Table | Rows | Notes |
|-------|------|-------|
| `assets` | 15,000 | Servers, endpoints, cloud resources. Has both `hostname` and `display_name` |
| `asset_groups` | 600 | Logical grouping (Production, Staging, DMZ, etc.) |
| `asset_group_memberships` | 20,000 | M:M, composite PK |
| `asset_tags` | 35,000 | Flexible key-value tags (EAV pattern) |
| `agents` | 12,000 | Monitoring agents installed on assets |
| `agent_heartbeats` | 50,000 | Agent health checks (time series, last 30 days) |

**Tech debt in this group:**
- `assets.hostname` (TEXT NOT NULL) — original column, always populated
- `assets.display_name` (TEXT NULL) — added 2023, "preferred" name, populated for ~60% of assets. App shows `display_name ?? hostname`
- `assets.asset_type` was originally ('server', 'endpoint', 'network'), later expanded to ('server', 'endpoint', 'network', 'cloud_vm', 'container', 'serverless'). Old data not migrated
- `agent_heartbeats.agent_id` → `agents.id` — NO FK CONSTRAINT
- Some `agents` reference deleted `assets` (orphaned rows, ~200)

### 4. Core Product: Vulnerability Management — 7 tables

| Table | Rows | Notes |
|-------|------|-------|
| `vulnerabilities` | 500 | CVE catalog. Has both `severity` (text) and `cvss_score` (numeric) |
| `scans` | 5,000 | Scan execution runs |
| `scan_configurations` | 100 | Reusable scan templates |
| `scan_results` | 80,000 | Individual findings — LARGEST TABLE |
| `vulnerability_instances` | 40,000 | Active vuln tracking (deduped across scans) |
| `remediation_actions` | 8,000 | Fix assignments and tracking |
| `vulnerability_exceptions` | 500 | Accepted risk / false positive waivers |

**Tech debt in this group:**
- `vulnerabilities.severity` (TEXT: 'low'/'medium'/'high'/'critical') — original field, always populated
- `vulnerabilities.cvss_score` (REAL, 0.0–10.0) — added 2022, NULL for ~30% of older vulns. App now uses `cvss_score` for sorting but falls back to `severity` text
- `scan_results.risk_level` (INTEGER) — was 1–5 scale, changed to 1–10 in mid-2024. Old data NOT migrated. ~40K rows have 1–5 values, ~40K have 1–10
- `scan_results.asset_id` → `assets.id` — NO FK CONSTRAINT
- `scan_results.vulnerability_id` → `vulnerabilities.id` — NO FK CONSTRAINT
- `vulnerability_instances.scan_result_id` → `scan_results.id` — NO FK CONSTRAINT
- Some `scan_results` reference `asset_id` values that no longer exist in `assets` (asset was decommissioned, ~500 orphan rows)

### 5. Threat & Incident Management — 6 tables

| Table | Rows | Notes |
|-------|------|-------|
| `incidents` | 1,500 | Security incidents. Status field has semantic drift |
| `incident_events` | 6,000 | Timeline events per incident |
| `incident_comments` | 3,500 | Analyst notes |
| `alerts` | 12,000 | Triggered alerts |
| `alert_rules` | 200 | Alert configurations per org |
| `alert_acknowledgments` | 8,000 | Who ack'd what |

**Tech debt in this group:**
- `incidents.status` values: 'open', 'investigating', 'identified', 'monitoring', 'resolved', 'closed'
  - 'identified' and 'monitoring' are effectively the same — devs use them interchangeably
  - 'closed' was used until mid-2024, then everyone switched to 'resolved' as the terminal state. ~50 old incidents still show 'closed'
- `alerts.incident_id` → `incidents.id` — NO FK CONSTRAINT (nullable, only set when alert escalates to incident)
- `alerts.severity` — should be NOT NULL but ~200 old alerts have NULL severity

### 6. Threat Intelligence — 3 tables

| Table | Rows | Notes |
|-------|------|-------|
| `threat_feeds` | 10 | External threat data sources |
| `indicators_of_compromise` | 2,000 | IOCs (IPs, domains, hashes) |
| `threat_actors` | 50 | Known threat groups (APT28, Lazarus, etc.) |

Clean tables, no significant tech debt. Small reference data.

### 7. Compliance — 4 tables

| Table | Rows | Notes |
|-------|------|-------|
| `compliance_frameworks` | 5 | SOC2, ISO27001, PCI-DSS, HIPAA, NIST-CSF |
| `compliance_controls` | 200 | Individual controls per framework |
| `compliance_assessments` | 600 | Periodic assessment runs |
| `compliance_findings` | 5,000 | Pass/fail per control per assessment |

Mostly clean. `compliance_findings.status` has some inconsistency ('pass'/'Pass'/'PASS').

### 8. Product Usage & Audit — 5 tables

| Table | Rows | Notes |
|-------|------|-------|
| `api_keys` | 300 | Customer API keys |
| `api_requests` | 20,000 | API usage log (last 90 days) |
| `feature_usage` | 15,000 | Feature engagement tracking |
| `login_events` | 10,000 | Auth audit trail |
| `notifications` | 5,000 | In-app notifications |

**Tech debt:**
- `api_requests.user_id` → `users.id` — NO FK CONSTRAINT
- `api_requests` has a `request_body` TEXT column that was logged for debugging, now always NULL (privacy fix), but column remains

### 9. Reporting & Denormalized — 5 tables

| Table | Rows | Notes |
|-------|------|-------|
| `daily_scan_stats` | 2,000 | Daily rollup of scan activity |
| `monthly_vulnerability_summary` | 500 | Monthly vuln counts by severity by org |
| `organization_health_scores` | 200 | Composite health metric per org |
| `scan_results_denormalized` | 80,000 | Fat reporting table (pre-joined scan_results + assets + vulns + orgs) |
| `executive_dashboard_cache` | 200 | Pre-computed dashboard data per org |

These are pure denormalization. No FK constraints on any of them. The `scan_results_denormalized` table duplicates `scan_results` with joined columns.

### 10. Saved Reports & Dashboards — 4 tables

| Table | Rows | Notes |
|-------|------|-------|
| `reports` | 500 | Saved/generated reports |
| `report_schedules` | 100 | Cron-like delivery schedules |
| `dashboards` | 300 | Saved dashboard configurations |
| `dashboard_widgets` | 1,200 | Widget configs within dashboards |

Clean tables.

### 11. Integration & Audit — 3 tables

| Table | Rows | Notes |
|-------|------|-------|
| `integrations` | 150 | Connected tools (Slack, JIRA, PagerDuty) |
| `integration_events` | 5,000 | Webhook/integration event log |
| `audit_log` | 25,000 | System-wide audit trail |

`audit_log` has no FKs — just `user_id`, `org_id`, `action`, `details` as TEXT.

### 12. Legacy & Abandoned — 6 tables

| Table | Rows | Description |
|-------|------|-------------|
| `old_scan_results_v2` | 5,000 | Attempted schema migration in 2023. Different column names than `scan_results`. Has data but nothing reads from it |
| `temp_asset_import_2024` | 1,200 | One-time CSV import artifact. Columns don't match `assets` schema. Left behind |
| `feature_flags_legacy` | 50 | Old feature flag system. Moved to LaunchDarkly in 2024. Table still exists with stale flag definitions |
| `notifications_backup` | 8,000 | Backup created during notification system migration. Columns match old `notifications` schema (pre-redesign) |
| `user_sessions_archive` | 15,000 | Old session tracking table. Replaced by JWT-based auth. No FK to current `users` (references old user IDs) |
| `legacy_risk_scores` | 1,000 | Old risk scoring algorithm output. Replaced by `organization_health_scores`. Different methodology, different scale |

---

## Tech Debt Catalog

### Pattern 1: Abandoned Tables (6 tables)
All tables in group 12 above. They should be droppable but nobody has gotten around to it. The profiler should ideally flag these as potentially unused.

**Detection heuristics the profiler could use:**
- Table name contains 'legacy', 'old', 'temp', 'backup', 'archive', 'v2'
- No FK constraints pointing TO this table (nothing depends on it)
- All data older than some threshold
- Column names don't match any other table's FK references

### Pattern 2: Schema Evolution Artifacts
| Table | Column(s) | Issue |
|-------|-----------|-------|
| `assets` | `hostname` + `display_name` | Newer column added, old one kept. App uses COALESCE |
| `vulnerabilities` | `severity` + `cvss_score` | Text enum replaced by numeric score, both kept |
| `scan_results` | `risk_level` | Scale changed 1–5 → 1–10, old data not backfilled |
| `incidents` | `status` | 'identified'/'monitoring' overlap, 'closed' deprecated |
| `users` | `role` | Column still populated but RBAC moved to separate tables |
| `organizations` | `industry` | No enum constraint, values drifted over time |
| `subscriptions` | `plan_name` | Denormalized, out of sync with `plans.name` |

### Pattern 3: Missing/Wrong Constraints
| From Table | Column | Should Reference | Constraint Exists? |
|-----------|--------|-----------------|-------------------|
| `scan_results` | `asset_id` | `assets.id` | NO |
| `scan_results` | `vulnerability_id` | `vulnerabilities.id` | NO |
| `vulnerability_instances` | `scan_result_id` | `scan_results.id` | NO |
| `alerts` | `incident_id` | `incidents.id` | NO |
| `api_requests` | `user_id` | `users.id` | NO |
| `agent_heartbeats` | `agent_id` | `agents.id` | NO |
| `invoice_line_items` | `subscription_id` | `subscriptions.id` | NO |

Also:
- `users.email` should be UNIQUE but isn't (3 duplicate emails from an org merge)
- `alerts.severity` should be NOT NULL (~200 old rows have NULL)
- Some `scan_results.asset_id` values reference deleted assets (orphan rows)

### Pattern 4: Denormalization & Duplication
- `scan_results_denormalized` — full copy of `scan_results` pre-joined with `assets`, `vulnerabilities`, `organizations`
- `monthly_vulnerability_summary` — pre-aggregated from `scan_results`
- `organization_health_scores` — composite metric computed from multiple tables
- `daily_scan_stats` — daily rollup of scan activity
- `executive_dashboard_cache` — pre-computed dashboard metrics
- `subscriptions.plan_name` — copied from `plans.name`
- `organization_name` text column appears in: `users`, `incidents` (denormalized for display)

---

## Data Generation Strategy

### Postgres (`data/cybersec.sql`)

Use `GENERATE_SERIES` + `random()` for bulk data generation. Strategy:

1. **DDL first** — all CREATE TABLE statements, indexes, comments
2. **Reference data** — small tables with static INSERT (plans, roles, frameworks, threat_actors)
3. **Core entities** — organizations, users, teams via GENERATE_SERIES
4. **Product data** — assets, scans, vulnerabilities via GENERATE_SERIES
5. **Event data** — scan_results, alerts, incidents via GENERATE_SERIES with temporal distribution
6. **Reporting tables** — populated via INSERT...SELECT from core tables
7. **Legacy tables** — static INSERTs with intentionally different schemas

Use arrays for realistic enum values:
```sql
(ARRAY['Technology','Healthcare','Finance','Retail','Manufacturing','Energy','Defense','Government'])[1 + (random() * 7)::int]
```

Temporal distribution: more recent data = more activity (exponential growth curve).

---

## Interesting Questions This Data Supports

### Vulnerability Analysis
- "What's the trend in critical vulnerabilities over the past 6 months?"
- "Which organizations have the most unpatched critical vulnerabilities?"
- "What's the average time to remediate by severity level?"
- "Top 10 most common vulnerabilities across all customers"
- "Which asset types have the highest vulnerability density?"

### Business Metrics
- "What's our total MRR broken down by plan?"
- "Which industries have the highest churn rate?"
- "What's the average contract value for Enterprise vs Professional?"
- "Show me revenue growth month over month"
- "Which organizations are most likely to churn based on login activity?"

### Operational
- "How many scans ran in the last 30 days by organization?"
- "What percentage of assets have an active monitoring agent?"
- "Which compliance frameworks are most commonly assessed?"
- "Average incident resolution time by severity"
- "Alert noise ratio — what % of alerts become incidents?"

### Tech Debt Discovery (what the profiler should help surface)
- "What tables exist?" → includes 6 legacy tables
- "What columns are in old_scan_results_v2?" → different schema from scan_results
- "Why are there two severity fields on vulnerabilities?"
- "Why don't industry values match between rows?"
- "What does scan_results_denormalized add over scan_results?"

---

## Implementation Phases

### Phase 1: Schema & Seed (Postgres)
**Files:** `data/cybersec.sql`
**Effort:** Large — 60 tables, DDL + GENERATE_SERIES data generation
**Dependencies:** None

Create the full Postgres seed file with:
- All 60 tables with proper DDL
- Strategic indexes (not too many, not too few — realistic)
- Comments on some tables but not all (realistic)
- Reference data (static INSERTs)
- Bulk data via GENERATE_SERIES
- Legacy tables with intentionally different naming/structure
- Temporal distribution in event data

### Phase 2: Demo Integration
**Files:** `bin/atlas.ts`, `create-atlas/index.ts`
**Effort:** Small — add `--demo cybersec` flag, update create-atlas TUI
**Dependencies:** Phase 1

Update `atlas init --demo` to accept a dataset name:
- `--demo` or `--demo simple` → current 3-table demo (backward compatible)
- `--demo cybersec` → new cybersecurity SaaS database

Update `create-atlas` to offer dataset choice:
- "Simple (3 tables, quick start)" — default
- "Cybersecurity SaaS (62 tables, realistic)" — PostgreSQL only, for evaluation/testing

### Phase 3: Profiler Improvements
**Files:** `bin/atlas.ts`, new tests
**Effort:** Medium — new heuristics, schema awareness
**Dependencies:** Phase 1 (use as test fixture)

Improvements needed for messy databases:
- [ ] **FK inference from naming** — detect `*_id` columns that reference `{tablename}.id`
- [ ] **Unused table heuristics** — flag tables named `old_*`, `temp_*`, `legacy_*`, `*_backup`, `*_archive`, or with no inbound FKs and stale data
- [ ] **Enum normalization** — detect case-inconsistent enum values and note in YAML
- [ ] **Denormalized table detection** — flag tables with many columns matching other tables
- [ ] **Schema evolution notes** — detect multiple columns serving similar purpose (e.g., `severity` + `cvss_score`)
- [ ] **Table annotations** — new YAML field `profiler_notes` with warnings/suggestions

### Phase 4: Documentation
**Files:** `docs/guides/demo-datasets.md`, README updates
**Effort:** Small
**Dependencies:** Phases 1-2

Document:
- How to use the cybersec demo
- What questions to ask
- What tech debt patterns are included
- How this helps evaluate Atlas before connecting real data

---

## Table Index (all ~62 tables)

| # | Table | Group | Rows | Has Tech Debt |
|---|-------|-------|------|---------------|
| 1 | organizations | Business | 200 | inconsistent enums |
| 2 | organization_settings | Business | 200 | |
| 3 | users | Business | 2,000 | legacy role column |
| 4 | teams | Business | 400 | |
| 5 | team_memberships | Business | 3,000 | |
| 6 | roles | Business | 5 | |
| 7 | invitations | Business | 150 | |
| 8 | plans | Billing | 5 | |
| 9 | subscriptions | Billing | 250 | denorm plan_name |
| 10 | subscription_events | Billing | 1,200 | |
| 11 | invoices | Billing | 3,000 | |
| 12 | invoice_line_items | Billing | 8,000 | missing FK |
| 13 | payment_methods | Billing | 180 | |
| 14 | assets | Product:Assets | 15,000 | dual name columns |
| 15 | asset_groups | Product:Assets | 600 | |
| 16 | asset_group_memberships | Product:Assets | 20,000 | |
| 17 | asset_tags | Product:Assets | 35,000 | |
| 18 | agents | Product:Assets | 12,000 | |
| 19 | agent_heartbeats | Product:Assets | 50,000 | missing FK |
| 20 | vulnerabilities | Product:Vulns | 500 | dual severity fields |
| 21 | scans | Product:Vulns | 5,000 | |
| 22 | scan_configurations | Product:Vulns | 100 | |
| 23 | scan_results | Product:Vulns | 80,000 | risk_level drift, missing FKs, orphans |
| 24 | vulnerability_instances | Product:Vulns | 40,000 | missing FK |
| 25 | remediation_actions | Product:Vulns | 8,000 | |
| 26 | vulnerability_exceptions | Product:Vulns | 500 | |
| 27 | incidents | Threats | 1,500 | status semantic drift |
| 28 | incident_events | Threats | 6,000 | |
| 29 | incident_comments | Threats | 3,500 | |
| 30 | alerts | Threats | 12,000 | missing FK, nullable severity |
| 31 | alert_rules | Threats | 200 | |
| 32 | alert_acknowledgments | Threats | 8,000 | |
| 33 | threat_feeds | Intel | 10 | |
| 34 | indicators_of_compromise | Intel | 2,000 | |
| 35 | threat_actors | Intel | 50 | |
| 36 | compliance_frameworks | Compliance | 5 | |
| 37 | compliance_controls | Compliance | 200 | |
| 38 | compliance_assessments | Compliance | 600 | |
| 39 | compliance_findings | Compliance | 5,000 | case-inconsistent status |
| 40 | api_keys | Usage | 300 | |
| 41 | api_requests | Usage | 20,000 | dead column, missing FK |
| 42 | feature_usage | Usage | 15,000 | |
| 43 | login_events | Usage | 10,000 | |
| 44 | notifications | Usage | 5,000 | |
| 45 | daily_scan_stats | Reporting | 2,000 | no FKs |
| 46 | monthly_vulnerability_summary | Reporting | 500 | no FKs |
| 47 | organization_health_scores | Reporting | 200 | no FKs |
| 48 | scan_results_denormalized | Reporting | 80,000 | no FKs, full duplication |
| 49 | executive_dashboard_cache | Reporting | 200 | no FKs |
| 50 | reports | Reports | 500 | |
| 51 | report_schedules | Reports | 100 | |
| 52 | dashboards | Reports | 300 | |
| 53 | dashboard_widgets | Reports | 1,200 | |
| 54 | integrations | Integration | 150 | |
| 55 | integration_events | Integration | 5,000 | |
| 56 | audit_log | Integration | 25,000 | no FKs |
| 57 | old_scan_results_v2 | LEGACY | 5,000 | abandoned migration |
| 58 | temp_asset_import_2024 | LEGACY | 1,200 | one-time import artifact |
| 59 | feature_flags_legacy | LEGACY | 50 | replaced by LaunchDarkly |
| 60 | notifications_backup | LEGACY | 8,000 | migration backup |
| 61 | user_sessions_archive | LEGACY | 15,000 | old session system |
| 62 | legacy_risk_scores | LEGACY | 1,000 | old risk algorithm |

**Total: ~62 tables, ~500K+ rows**
