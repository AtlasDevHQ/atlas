-- ==========================================================================
-- Sentinel Security — Cybersecurity SaaS Demo Database (PostgreSQL)
-- ==========================================================================
-- ~62 tables, ~500K rows. Realistic tech debt patterns:
--   1. Abandoned/legacy tables (6 tables nobody reads)
--   2. Schema evolution artifacts (columns that changed meaning)
--   3. Missing/wrong constraints (logical FKs without DB constraints)
--   4. Denormalization & duplication (reporting tables, copied columns)
--
-- Usage:  psql $ATLAS_DATASOURCE_URL -f data/cybersec.sql
-- Reset:  bun run db:reset  (nukes volume, re-seeds)
-- ==========================================================================

BEGIN;
SELECT setseed(0.42);  -- reproducible random data

-- ==========================================================================
-- DROP (safe re-run)
-- ==========================================================================
DROP TABLE IF EXISTS legacy_risk_scores CASCADE;
DROP TABLE IF EXISTS user_sessions_archive CASCADE;
DROP TABLE IF EXISTS notifications_backup CASCADE;
DROP TABLE IF EXISTS feature_flags_legacy CASCADE;
DROP TABLE IF EXISTS temp_asset_import_2024 CASCADE;
DROP TABLE IF EXISTS old_scan_results_v2 CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS integration_events CASCADE;
DROP TABLE IF EXISTS integrations CASCADE;
DROP TABLE IF EXISTS dashboard_widgets CASCADE;
DROP TABLE IF EXISTS dashboards CASCADE;
DROP TABLE IF EXISTS report_schedules CASCADE;
DROP TABLE IF EXISTS reports CASCADE;
DROP TABLE IF EXISTS executive_dashboard_cache CASCADE;
DROP TABLE IF EXISTS scan_results_denormalized CASCADE;
DROP TABLE IF EXISTS organization_health_scores CASCADE;
DROP TABLE IF EXISTS monthly_vulnerability_summary CASCADE;
DROP TABLE IF EXISTS daily_scan_stats CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS login_events CASCADE;
DROP TABLE IF EXISTS feature_usage CASCADE;
DROP TABLE IF EXISTS api_requests CASCADE;
DROP TABLE IF EXISTS api_keys CASCADE;
DROP TABLE IF EXISTS compliance_findings CASCADE;
DROP TABLE IF EXISTS compliance_assessments CASCADE;
DROP TABLE IF EXISTS compliance_controls CASCADE;
DROP TABLE IF EXISTS compliance_frameworks CASCADE;
DROP TABLE IF EXISTS threat_actors CASCADE;
DROP TABLE IF EXISTS indicators_of_compromise CASCADE;
DROP TABLE IF EXISTS threat_feeds CASCADE;
DROP TABLE IF EXISTS alert_acknowledgments CASCADE;
DROP TABLE IF EXISTS alert_rules CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS incident_comments CASCADE;
DROP TABLE IF EXISTS incident_events CASCADE;
DROP TABLE IF EXISTS incidents CASCADE;
DROP TABLE IF EXISTS vulnerability_exceptions CASCADE;
DROP TABLE IF EXISTS remediation_actions CASCADE;
DROP TABLE IF EXISTS vulnerability_instances CASCADE;
DROP TABLE IF EXISTS scan_results CASCADE;
DROP TABLE IF EXISTS scan_configurations CASCADE;
DROP TABLE IF EXISTS scans CASCADE;
DROP TABLE IF EXISTS vulnerabilities CASCADE;
DROP TABLE IF EXISTS agent_heartbeats CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS asset_tags CASCADE;
DROP TABLE IF EXISTS asset_group_memberships CASCADE;
DROP TABLE IF EXISTS asset_groups CASCADE;
DROP TABLE IF EXISTS assets CASCADE;
DROP TABLE IF EXISTS payment_methods CASCADE;
DROP TABLE IF EXISTS invoice_line_items CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS subscription_events CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS plans CASCADE;
DROP TABLE IF EXISTS invitations CASCADE;
DROP TABLE IF EXISTS team_memberships CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS organization_settings CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP TABLE IF EXISTS roles CASCADE;

-- ==========================================================================
-- 1. SCHEMA
-- ==========================================================================

-- ---------- 1.1 Core Business ----------

CREATE TABLE roles (
    id    SERIAL PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    description TEXT
);

CREATE TABLE organizations (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    industry   TEXT,            -- TECH DEBT: no enum constraint, inconsistent values
    size_tier  TEXT,
    domain     TEXT,
    country    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE organization_settings (
    id                 SERIAL PRIMARY KEY,
    organization_id    INTEGER NOT NULL REFERENCES organizations(id),
    notification_email TEXT,
    scan_frequency     TEXT DEFAULT 'weekly',
    retention_days     INTEGER DEFAULT 90,
    sso_enabled        BOOLEAN DEFAULT false,
    mfa_required       BOOLEAN DEFAULT false,
    settings_json      TEXT,     -- catch-all config as text (realistic)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id                SERIAL PRIMARY KEY,
    organization_id   INTEGER NOT NULL REFERENCES organizations(id),
    organization_name TEXT,     -- TECH DEBT: denormalized, sometimes stale
    email             TEXT NOT NULL,  -- TECH DEBT: should be UNIQUE but 3 dupes from org merge
    full_name         TEXT NOT NULL,
    role              TEXT,     -- TECH DEBT: legacy column, still populated, app ignores it
    last_login        TIMESTAMPTZ,  -- TECH DEBT: mostly NULL, never read
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active         BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE teams (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_memberships (
    user_id   INTEGER NOT NULL REFERENCES users(id),
    team_id   INTEGER NOT NULL REFERENCES teams(id),
    role_id   INTEGER NOT NULL REFERENCES roles(id),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, team_id)
);

CREATE TABLE invitations (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    email           TEXT NOT NULL,
    role_name       TEXT NOT NULL,
    invited_by      INTEGER REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);

-- ---------- 1.2 Billing & Subscriptions ----------

CREATE TABLE plans (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    max_assets  INTEGER,
    max_users   INTEGER,
    features    TEXT,        -- JSON-as-text (realistic)
    is_active   BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE subscriptions (
    id                 SERIAL PRIMARY KEY,
    organization_id    INTEGER NOT NULL REFERENCES organizations(id),
    plan_id            INTEGER NOT NULL REFERENCES plans(id),
    plan_name          TEXT,    -- TECH DEBT: denormalized from plans.name, ~15% out of sync
    status             TEXT NOT NULL DEFAULT 'active',
    mrr_cents          INTEGER NOT NULL,
    started_at         TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscription_events (
    id              SERIAL PRIMARY KEY,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
    event_type      TEXT NOT NULL,
    old_plan_id     INTEGER REFERENCES plans(id),
    new_plan_id     INTEGER REFERENCES plans(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
    amount_cents    INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'paid',
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    due_date        DATE NOT NULL,
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invoice_line_items (
    id              SERIAL PRIMARY KEY,
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id),
    subscription_id INTEGER,     -- TECH DEBT: NO FK to subscriptions (logical only)
    description     TEXT NOT NULL,
    amount_cents    INTEGER NOT NULL,
    quantity        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE payment_methods (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    type            TEXT NOT NULL,
    last4           TEXT,
    expiry_month    INTEGER,
    expiry_year     INTEGER,
    is_default      BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.3 Asset Management ----------

CREATE TABLE assets (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    hostname        TEXT NOT NULL,
    display_name    TEXT,        -- TECH DEBT: added 2023, NULL for ~40% of assets
    asset_type      TEXT NOT NULL,  -- TECH DEBT: expanded enum, old data not migrated
    ip_address      TEXT,
    os              TEXT,
    os_version      TEXT,
    environment     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    first_seen      TIMESTAMPTZ NOT NULL,
    last_seen       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE asset_groups (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE asset_group_memberships (
    asset_id       INTEGER NOT NULL REFERENCES assets(id),
    asset_group_id INTEGER NOT NULL REFERENCES asset_groups(id),
    added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, asset_group_id)
);

CREATE TABLE asset_tags (
    id       SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
    id             SERIAL PRIMARY KEY,
    asset_id       INTEGER,          -- TECH DEBT: no FK, ~200 orphaned (reference deleted assets)
    agent_version  TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',
    last_heartbeat TIMESTAMPTZ,
    installed_at   TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_heartbeats (
    id             SERIAL PRIMARY KEY,
    agent_id       INTEGER,          -- TECH DEBT: NO FK to agents
    cpu_percent    REAL,
    memory_percent REAL,
    disk_percent   REAL,
    reported_at    TIMESTAMPTZ NOT NULL
);

-- ---------- 1.4 Vulnerability Management ----------

CREATE TABLE vulnerabilities (
    id           SERIAL PRIMARY KEY,
    cve_id       TEXT UNIQUE,
    title        TEXT NOT NULL,
    description  TEXT,
    severity     TEXT NOT NULL,      -- TECH DEBT: text enum ('low','medium','high','critical')
    cvss_score   REAL,               -- TECH DEBT: added 2022, NULL for ~30% of older vulns
    category     TEXT,
    published_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scan_configurations (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    scan_type       TEXT NOT NULL,
    target_spec     TEXT,
    schedule        TEXT,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scans (
    id                    SERIAL PRIMARY KEY,
    organization_id       INTEGER NOT NULL REFERENCES organizations(id),
    scan_configuration_id INTEGER REFERENCES scan_configurations(id),
    scan_type             TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'completed',
    started_at            TIMESTAMPTZ NOT NULL,
    completed_at          TIMESTAMPTZ,
    assets_scanned        INTEGER,
    findings_count        INTEGER,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scan_results (
    id               SERIAL PRIMARY KEY,
    scan_id          INTEGER,         -- TECH DEBT: NO FK to scans
    asset_id         INTEGER,         -- TECH DEBT: NO FK to assets, ~500 orphan rows
    vulnerability_id INTEGER,         -- TECH DEBT: NO FK to vulnerabilities
    risk_level       INTEGER,         -- TECH DEBT: was 1-5, changed to 1-10 mid-2024
    status           TEXT NOT NULL DEFAULT 'open',
    details          TEXT,
    found_at         TIMESTAMPTZ NOT NULL,
    resolved_at      TIMESTAMPTZ
);

CREATE TABLE vulnerability_instances (
    id               SERIAL PRIMARY KEY,
    vulnerability_id INTEGER NOT NULL REFERENCES vulnerabilities(id),
    asset_id         INTEGER NOT NULL REFERENCES assets(id),
    scan_result_id   INTEGER,         -- TECH DEBT: NO FK to scan_results
    status           TEXT NOT NULL DEFAULT 'open',
    first_seen       TIMESTAMPTZ NOT NULL,
    last_seen        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE remediation_actions (
    id                      SERIAL PRIMARY KEY,
    vulnerability_instance_id INTEGER NOT NULL REFERENCES vulnerability_instances(id),
    assigned_to             INTEGER REFERENCES users(id),
    status                  TEXT NOT NULL DEFAULT 'open',
    priority                TEXT,
    due_date                DATE,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vulnerability_exceptions (
    id               SERIAL PRIMARY KEY,
    vulnerability_id INTEGER NOT NULL REFERENCES vulnerabilities(id),
    organization_id  INTEGER NOT NULL REFERENCES organizations(id),
    requested_by     INTEGER REFERENCES users(id),
    reason           TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    expires_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.5 Threat & Incident Management ----------

CREATE TABLE incidents (
    id                SERIAL PRIMARY KEY,
    organization_id   INTEGER NOT NULL REFERENCES organizations(id),
    organization_name TEXT,     -- TECH DEBT: denormalized
    title             TEXT NOT NULL,
    description       TEXT,
    severity          TEXT NOT NULL,
    status            TEXT NOT NULL,  -- TECH DEBT: 'identified'/'monitoring' overlap, 'closed' deprecated
    assigned_to       INTEGER REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at       TIMESTAMPTZ
);

CREATE TABLE incident_events (
    id          SERIAL PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    event_type  TEXT NOT NULL,
    description TEXT,
    created_by  INTEGER REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE incident_comments (
    id          SERIAL PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alert_rules (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    condition_type  TEXT NOT NULL,
    threshold       REAL,
    severity        TEXT NOT NULL,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    alert_rule_id   INTEGER REFERENCES alert_rules(id),
    severity        TEXT,            -- TECH DEBT: should be NOT NULL, ~200 old alerts have NULL
    title           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    incident_id     INTEGER,         -- TECH DEBT: NO FK to incidents (nullable, set on escalation)
    source          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ
);

CREATE TABLE alert_acknowledgments (
    id              SERIAL PRIMARY KEY,
    alert_id        INTEGER NOT NULL REFERENCES alerts(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    note            TEXT
);

-- ---------- 1.6 Threat Intelligence ----------

CREATE TABLE threat_feeds (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    provider    TEXT NOT NULL,
    url         TEXT,
    feed_type   TEXT NOT NULL,
    is_active   BOOLEAN DEFAULT true,
    last_synced TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE threat_actors (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    aliases       TEXT,
    origin        TEXT,
    description   TEXT,
    active_since  DATE,
    last_activity DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE indicators_of_compromise (
    id              SERIAL PRIMARY KEY,
    threat_feed_id  INTEGER NOT NULL REFERENCES threat_feeds(id),
    ioc_type        TEXT NOT NULL,
    value           TEXT NOT NULL,
    confidence      INTEGER,
    threat_actor_id INTEGER REFERENCES threat_actors(id),
    first_seen      TIMESTAMPTZ,
    last_seen       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.7 Compliance ----------

CREATE TABLE compliance_frameworks (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    version     TEXT,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compliance_controls (
    id              SERIAL PRIMARY KEY,
    framework_id    INTEGER NOT NULL REFERENCES compliance_frameworks(id),
    control_id_code TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT
);

CREATE TABLE compliance_assessments (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    framework_id    INTEGER NOT NULL REFERENCES compliance_frameworks(id),
    status          TEXT NOT NULL DEFAULT 'in_progress',
    started_at      TIMESTAMPTZ NOT NULL,
    completed_at    TIMESTAMPTZ,
    score           REAL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compliance_findings (
    id            SERIAL PRIMARY KEY,
    assessment_id INTEGER NOT NULL REFERENCES compliance_assessments(id),
    control_id    INTEGER NOT NULL REFERENCES compliance_controls(id),
    status        TEXT NOT NULL,   -- TECH DEBT: case-inconsistent ('pass','Pass','PASS')
    evidence      TEXT,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.8 Product Usage & Audit ----------

CREATE TABLE api_keys (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    key_prefix      TEXT NOT NULL,
    key_hash        TEXT NOT NULL,
    permissions     TEXT,
    is_active       BOOLEAN DEFAULT true,
    last_used       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ
);

CREATE TABLE api_requests (
    id               SERIAL PRIMARY KEY,
    api_key_id       INTEGER NOT NULL REFERENCES api_keys(id),
    user_id          INTEGER,         -- TECH DEBT: NO FK to users
    method           TEXT NOT NULL,
    path             TEXT NOT NULL,
    status_code      INTEGER NOT NULL,
    response_time_ms INTEGER,
    request_body     TEXT,            -- TECH DEBT: dead column, always NULL (privacy fix)
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feature_usage (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    feature_name    TEXT NOT NULL,
    action          TEXT NOT NULL,
    metadata        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE login_events (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    ip_address     TEXT,
    user_agent     TEXT,
    success        BOOLEAN NOT NULL,
    failure_reason TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    message         TEXT,
    is_read         BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.9 Reporting & Denormalized ----------

CREATE TABLE daily_scan_stats (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER,         -- no FK (denormalized)
    scan_date       DATE NOT NULL,
    total_scans     INTEGER DEFAULT 0,
    total_findings  INTEGER DEFAULT 0,
    critical_count  INTEGER DEFAULT 0,
    high_count      INTEGER DEFAULT 0,
    medium_count    INTEGER DEFAULT 0,
    low_count       INTEGER DEFAULT 0
);

CREATE TABLE monthly_vulnerability_summary (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER,         -- no FK
    month           DATE NOT NULL,
    total_vulns     INTEGER DEFAULT 0,
    critical_vulns  INTEGER DEFAULT 0,
    high_vulns      INTEGER DEFAULT 0,
    medium_vulns    INTEGER DEFAULT 0,
    low_vulns       INTEGER DEFAULT 0,
    avg_time_to_fix_days REAL
);

CREATE TABLE organization_health_scores (
    id                    SERIAL PRIMARY KEY,
    organization_id       INTEGER,   -- no FK
    score                 REAL,
    vulnerability_score   REAL,
    compliance_score      REAL,
    asset_coverage_score  REAL,
    calculated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scan_results_denormalized (
    id                  SERIAL PRIMARY KEY,
    scan_id             INTEGER,
    scan_type           TEXT,
    scan_started_at     TIMESTAMPTZ,
    asset_id            INTEGER,
    hostname            TEXT,
    asset_type          TEXT,
    organization_id     INTEGER,
    organization_name   TEXT,
    vulnerability_id    INTEGER,
    cve_id              TEXT,
    vulnerability_title TEXT,
    severity            TEXT,
    cvss_score          REAL,
    risk_level          INTEGER,
    status              TEXT,
    found_at            TIMESTAMPTZ
);

CREATE TABLE executive_dashboard_cache (
    id                    SERIAL PRIMARY KEY,
    organization_id       INTEGER,   -- no FK
    total_assets          INTEGER,
    active_agents         INTEGER,
    open_vulnerabilities  INTEGER,
    critical_incidents    INTEGER,
    compliance_score      REAL,
    risk_score            REAL,
    generated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.10 Saved Reports & Dashboards ----------

CREATE TABLE reports (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    created_by      INTEGER REFERENCES users(id),
    title           TEXT NOT NULL,
    report_type     TEXT NOT NULL,
    format          TEXT DEFAULT 'pdf',
    parameters      TEXT,
    status          TEXT DEFAULT 'completed',
    file_path       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report_schedules (
    id              SERIAL PRIMARY KEY,
    report_id       INTEGER NOT NULL REFERENCES reports(id),
    cron_expression TEXT NOT NULL,
    recipients      TEXT,
    is_active       BOOLEAN DEFAULT true,
    last_run        TIMESTAMPTZ,
    next_run        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dashboards (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    created_by      INTEGER REFERENCES users(id),
    name            TEXT NOT NULL,
    description     TEXT,
    is_default      BOOLEAN DEFAULT false,
    layout          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_widgets (
    id           SERIAL PRIMARY KEY,
    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id),
    widget_type  TEXT NOT NULL,
    title        TEXT,
    config       TEXT,
    position_x   INTEGER DEFAULT 0,
    position_y   INTEGER DEFAULT 0,
    width        INTEGER DEFAULT 4,
    height       INTEGER DEFAULT 3
);

-- ---------- 1.11 Integration & Audit ----------

CREATE TABLE integrations (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    type            TEXT NOT NULL,
    name            TEXT NOT NULL,
    config          TEXT,
    status          TEXT DEFAULT 'active',
    last_sync       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE integration_events (
    id             SERIAL PRIMARY KEY,
    integration_id INTEGER NOT NULL REFERENCES integrations(id),
    event_type     TEXT NOT NULL,
    direction      TEXT NOT NULL,
    payload        TEXT,
    status         TEXT DEFAULT 'success',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER,         -- no FK (standalone audit)
    user_id         INTEGER,         -- no FK
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    details         TEXT,
    ip_address      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.12 Legacy & Abandoned ----------

CREATE TABLE old_scan_results_v2 (
    id              SERIAL PRIMARY KEY,
    scan_run_id     INTEGER,         -- different name than scan_results.scan_id
    target_host     TEXT,            -- different name than asset_id
    vuln_code       TEXT,            -- different name than vulnerability_id
    severity_score  REAL,            -- different name and type than risk_level
    detection_date  TIMESTAMPTZ,     -- different name than found_at
    remediated      BOOLEAN DEFAULT false
);

CREATE TABLE temp_asset_import_2024 (
    id               SERIAL PRIMARY KEY,
    import_hostname  TEXT,
    import_ip        TEXT,
    import_os        TEXT,
    import_env       TEXT,
    raw_csv_line     TEXT,
    imported_at      TIMESTAMPTZ DEFAULT '2024-03-15'::timestamptz
);

CREATE TABLE feature_flags_legacy (
    id                 SERIAL PRIMARY KEY,
    flag_name          TEXT NOT NULL,
    is_enabled         BOOLEAN DEFAULT false,
    rollout_percentage INTEGER DEFAULT 0,
    description        TEXT,
    updated_at         TIMESTAMPTZ DEFAULT '2024-01-01'::timestamptz
);

CREATE TABLE notifications_backup (
    id                SERIAL PRIMARY KEY,
    recipient_id      INTEGER,         -- old user ID column name
    notification_type TEXT,            -- different from notifications.type
    subject           TEXT,            -- different from notifications.title
    body              TEXT,            -- different from notifications.message
    sent_at           TIMESTAMPTZ,
    read_at           TIMESTAMPTZ
);

CREATE TABLE user_sessions_archive (
    id            SERIAL PRIMARY KEY,
    session_token TEXT,
    user_ref_id   INTEGER,           -- references OLD user IDs (not current users.id)
    login_time    TIMESTAMPTZ,
    logout_time   TIMESTAMPTZ,
    ip_addr       TEXT,
    browser       TEXT
);

CREATE TABLE legacy_risk_scores (
    id            SERIAL PRIMARY KEY,
    org_id        INTEGER,           -- different column name than organization_id
    risk_category TEXT,
    score_value   REAL,              -- different scale than current health scores
    weight        REAL,
    computed_date DATE
);


-- ==========================================================================
-- 2. INDEXES
-- ==========================================================================

CREATE INDEX idx_users_org ON users(organization_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_teams_org ON teams(organization_id);
CREATE INDEX idx_assets_org ON assets(organization_id);
CREATE INDEX idx_assets_type ON assets(asset_type);
CREATE INDEX idx_assets_hostname ON assets(hostname);
CREATE INDEX idx_agents_asset ON agents(asset_id);
CREATE INDEX idx_agent_heartbeats_agent ON agent_heartbeats(agent_id);
CREATE INDEX idx_agent_heartbeats_reported ON agent_heartbeats(reported_at);
CREATE INDEX idx_scan_results_scan ON scan_results(scan_id);
CREATE INDEX idx_scan_results_asset ON scan_results(asset_id);
CREATE INDEX idx_scan_results_vuln ON scan_results(vulnerability_id);
CREATE INDEX idx_scan_results_found ON scan_results(found_at);
CREATE INDEX idx_vuln_instances_vuln ON vulnerability_instances(vulnerability_id);
CREATE INDEX idx_vuln_instances_asset ON vulnerability_instances(asset_id);
CREATE INDEX idx_alerts_org ON alerts(organization_id);
CREATE INDEX idx_alerts_created ON alerts(created_at);
CREATE INDEX idx_incidents_org ON incidents(organization_id);
CREATE INDEX idx_incidents_status ON incidents(status);
CREATE INDEX idx_invoices_org ON invoices(organization_id);
CREATE INDEX idx_subscriptions_org ON subscriptions(organization_id);
CREATE INDEX idx_compliance_findings_assessment ON compliance_findings(assessment_id);
CREATE INDEX idx_api_requests_created ON api_requests(created_at);
CREATE INDEX idx_login_events_user ON login_events(user_id);
CREATE INDEX idx_audit_log_org ON audit_log(organization_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_scan_results_denorm_org ON scan_results_denormalized(organization_id);
CREATE INDEX idx_scan_results_denorm_found ON scan_results_denormalized(found_at);


-- ==========================================================================
-- 3. REFERENCE DATA
-- ==========================================================================

INSERT INTO roles (name, description) VALUES
    ('admin',     'Full organization access'),
    ('analyst',   'View and query access, can manage scans'),
    ('viewer',    'Read-only dashboard access'),
    ('responder', 'Incident response and alert management'),
    ('auditor',   'Compliance and audit access');

INSERT INTO plans (name, display_name, price_cents, max_assets, max_users, features, is_active) VALUES
    ('free',         'Free',         0,       25,   3,   '{"scans":"weekly","retention":30}',      true),
    ('starter',      'Starter',      4900,    100,  10,  '{"scans":"daily","retention":90}',       true),
    ('professional', 'Professional', 14900,   500,  50,  '{"scans":"continuous","retention":365}', true),
    ('enterprise',   'Enterprise',   49900,   NULL, NULL,'{"scans":"continuous","retention":730,"sso":true,"api":true}', true),
    ('custom',       'Custom',       0,       NULL, NULL,'{"custom":true}', true);

INSERT INTO compliance_frameworks (name, version, description) VALUES
    ('SOC2',      'Type II',  'Service Organization Control 2'),
    ('ISO27001',  '2022',     'Information Security Management System'),
    ('PCI-DSS',   'v4.0',    'Payment Card Industry Data Security Standard'),
    ('HIPAA',     '2013',     'Health Insurance Portability and Accountability Act'),
    ('NIST-CSF',  'v2.0',    'NIST Cybersecurity Framework');

INSERT INTO threat_feeds (name, provider, url, feed_type, is_active, last_synced) VALUES
    ('AlienVault OTX',      'AlienVault',   'https://otx.alienvault.com',  'ioc',       true,  now() - interval '2 hours'),
    ('Abuse.ch URLhaus',    'abuse.ch',     'https://urlhaus.abuse.ch',    'url',       true,  now() - interval '4 hours'),
    ('MISP Community',      'MISP Project', 'https://misp-project.org',    'ioc',       true,  now() - interval '1 day'),
    ('VirusTotal',          'Google',       'https://virustotal.com',      'hash',      true,  now() - interval '6 hours'),
    ('Shodan',              'Shodan',       'https://shodan.io',           'host',      true,  now() - interval '12 hours'),
    ('CrowdStrike Intel',   'CrowdStrike',  NULL,                          'threat',    true,  now() - interval '1 hour'),
    ('Recorded Future',     'Recorded Future', NULL,                       'threat',    true,  now() - interval '3 hours'),
    ('Mandiant Advantage',  'Mandiant',     NULL,                          'threat',    false, '2024-06-01'::timestamptz),
    ('CISA Known Exploited','CISA',         'https://cisa.gov/known-exploited-vulnerabilities', 'vuln', true, now() - interval '8 hours'),
    ('PhishTank',           'OpenDNS',      'https://phishtank.org',       'url',       true,  now() - interval '5 hours');

INSERT INTO threat_actors (name, aliases, origin, description, active_since, last_activity) VALUES
    ('APT28',    'Fancy Bear, Sofacy, Sednit',           'Russia',       'Russian GRU Unit 26165, military intelligence',                    '2007-01-01', '2025-06-01'),
    ('APT29',    'Cozy Bear, The Dukes, Midnight Blizzard','Russia',     'Russian SVR foreign intelligence service',                         '2008-01-01', '2025-05-15'),
    ('APT41',    'Double Dragon, Barium, Winnti',        'China',        'Chinese state-sponsored, dual espionage and financial crime',       '2012-01-01', '2025-04-20'),
    ('Lazarus',  'Hidden Cobra, Zinc, Labyrinth Chollima','North Korea', 'North Korean state-sponsored, financial theft and espionage',       '2009-01-01', '2025-06-10'),
    ('APT1',     'Comment Crew, Shanghai Group',         'China',        'PLA Unit 61398',                                                   '2006-01-01', '2023-12-01'),
    ('Sandworm', 'Voodoo Bear, Iridium, Seashell Blizzard','Russia',    'Russian GRU Unit 74455, destructive attacks',                       '2009-01-01', '2025-03-01'),
    ('Turla',    'Snake, Venomous Bear, Krypton',        'Russia',       'Russian FSB signals intelligence',                                 '2004-01-01', '2025-01-15'),
    ('FIN7',     'Carbanak, Navigator Group',            'Russia',       'Financially motivated, POS malware and ransomware',                '2013-01-01', '2025-05-01'),
    ('FIN11',    'Clop Gang, TA505',                     'Russia',       'Financially motivated, ransomware and extortion',                  '2016-01-01', '2025-06-01'),
    ('Kimsuky',  'Velvet Chollima, Thallium, Black Banshee','North Korea','North Korean intelligence, credential theft and espionage',       '2012-01-01', '2025-04-01'),
    ('Hafnium',  'Silk Typhoon',                         'China',        'Chinese state-sponsored, targeting Exchange servers',               '2017-01-01', '2024-12-01'),
    ('REvil',    'Sodinokibi',                           'Russia',       'Ransomware-as-a-service operation',                                '2019-04-01', '2024-01-01'),
    ('LockBit',  'ABCD Ransomware',                      'Russia',       'Ransomware-as-a-service, prolific affiliate program',              '2019-09-01', '2025-02-01'),
    ('BlackCat',  'ALPHV',                                'Russia',       'Rust-based ransomware, triple extortion',                         '2021-11-01', '2024-12-01'),
    ('Scattered Spider','Octo Tempest, UNC3944',         'US/UK',        'Young English-speaking hackers, SIM swapping and social engineering','2022-01-01','2025-05-01'),
    ('Volt Typhoon', NULL,                               'China',        'Chinese state-sponsored, living-off-the-land, critical infrastructure','2021-01-01','2025-06-01'),
    ('MuddyWater','Mercury, Mango Sandstorm',           'Iran',         'Iranian MOIS, espionage targeting Middle East and Central Asia',    '2017-01-01', '2025-03-01'),
    ('Charming Kitten','APT35, Phosphorus, Mint Sandstorm','Iran',      'Iranian IRGC, spear-phishing and credential harvesting',            '2014-01-01', '2025-05-20'),
    ('OilRig',   'APT34, Helix Kitten, Hazel Sandstorm', 'Iran',        'Iranian MOIS, targeting energy and government sectors',             '2014-01-01', '2025-02-15'),
    ('Equation Group', NULL,                              'US',           'NSA Tailored Access Operations, sophisticated implants',           '2001-01-01', '2023-06-01'),
    ('DarkSide', 'BlackMatter',                           'Russia',      'Ransomware operation, Colonial Pipeline attack',                   '2020-08-01', '2022-03-01'),
    ('Conti',    'Wizard Spider (partial)',                'Russia',      'Ransomware syndicate, splintered after internal leaks',            '2020-05-01', '2023-06-01'),
    ('TA577',    NULL,                                    'Unknown',     'Initial access broker, distributes QBot and IcedID',               '2020-01-01', '2025-01-01'),
    ('Gamaredon', 'Primitive Bear, Armageddon',           'Russia',      'Russian FSB, targeting Ukraine',                                   '2013-01-01', '2025-06-01'),
    ('BlueNoroff','APT38, Stardust Chollima',            'North Korea',  'Lazarus subgroup, SWIFT banking theft',                            '2014-01-01', '2025-04-01'),
    ('SilverFox', NULL,                                   'China',       'Chinese cybercrime group, Winos4.0 framework',                     '2023-01-01', '2025-03-01'),
    ('Akira',    NULL,                                    'Unknown',     'Ransomware operation targeting SMBs and critical infrastructure',   '2023-03-01', '2025-06-01'),
    ('Play',     'PlayCrypt',                             'Unknown',     'Ransomware group, intermittent encryption technique',              '2022-06-01', '2025-05-01'),
    ('Royal',    'BlackSuit',                             'Unknown',     'Ransomware rebranded from Conti splinter',                         '2022-09-01', '2025-04-01'),
    ('Cl0p',     NULL,                                    'Russia',      'Ransomware and extortion, MOVEit and GoAnywhere exploits',          '2019-02-01', '2025-06-01'),
    ('Rhysida',  NULL,                                    'Unknown',     'Ransomware targeting healthcare and education',                    '2023-05-01', '2025-05-15'),
    ('BianLian', NULL,                                    'Unknown',     'Ransomware shifted to pure extortion, no encryption',              '2022-06-01', '2025-04-01'),
    ('NoName057','NoName057(16)',                          'Russia',     'Pro-Russian hacktivist, DDoS attacks on NATO allies',               '2022-03-01', '2025-06-01'),
    ('Anonymous Sudan','Storm-1359',                      'Unknown',     'DDoS-as-a-service, politically motivated attacks',                 '2023-01-01', '2024-10-01'),
    ('Killnet',  NULL,                                    'Russia',      'Pro-Russian hacktivist collective, DDoS campaigns',                '2022-01-01', '2024-06-01'),
    ('Lapsus$',  'DEV-0537',                              'UK/Brazil',  'Teenager-led extortion group, high-profile breaches',               '2021-12-01', '2023-09-01'),
    ('Moses Staff', NULL,                                 'Iran',        'Iranian hacktivist/APT targeting Israel',                          '2021-09-01', '2024-08-01'),
    ('Witchetty', 'LookingFrog',                          'China',      'Chinese APT targeting Middle East and Africa',                      '2022-02-01', '2024-11-01'),
    ('Vice Society', NULL,                                'Unknown',    'Ransomware targeting education sector',                             '2021-06-01', '2024-05-01'),
    ('8Base',    NULL,                                    'Unknown',     'Ransomware and extortion, double extortion model',                 '2022-03-01', '2025-05-01'),
    ('Medusa',   'MedusaLocker',                          'Unknown',    'Ransomware-as-a-service targeting all sectors',                     '2022-01-01', '2025-06-01'),
    ('INC Ransom', NULL,                                  'Unknown',    'Ransomware operation with data leak site',                          '2023-07-01', '2025-04-01'),
    ('BlackBasta', NULL,                                  'Russia',     'Ransomware syndicate, Conti successor',                             '2022-04-01', '2025-06-01'),
    ('Hunters International', NULL,                       'Unknown',    'Ransomware using Hive source code after takedown',                  '2023-10-01', '2025-05-01'),
    ('Qilin',    'Agenda',                                'Unknown',    'Ransomware-as-a-service, cross-platform variants',                 '2022-07-01', '2025-06-01'),
    ('Storm-0558', NULL,                                  'China',      'Chinese espionage, forged Azure AD tokens',                         '2023-05-01', '2024-03-01'),
    ('Star Blizzard','Callisto, ColdRiver, SEABORGIUM',  'Russia',      'Russian FSB, credential phishing targeting think tanks',            '2019-01-01', '2025-03-01'),
    ('Midnight Blizzard', NULL,                           'Russia',     'Russian SVR, Microsoft and SolarWinds supply chain compromise',     '2008-01-01', '2025-06-01'),
    ('Forest Blizzard','Strontium, APT28 rebrand',       'Russia',      'Russian GRU, overlaps with APT28 activity',                        '2007-01-01', '2025-06-01'),
    ('Velvet Ant', NULL,                                  'China',      'Chinese APT targeting telecom and technology sectors',               '2023-06-01', '2025-04-01');


-- ==========================================================================
-- 4. CORE ENTITY DATA
-- ==========================================================================

-- ---------- Organizations (200) ----------
INSERT INTO organizations (name, industry, size_tier, domain, country, created_at, is_active)
SELECT
    prefix || ' ' || suffix,
    -- TECH DEBT: Inconsistent industry values
    (ARRAY[
        'Technology','Technology','Technology','Technology','tech','Tech','TECHNOLOGY',
        'Healthcare','Healthcare','Healthcare','healthcare','Health Care',
        'Finance','Finance','Finance',
        'Retail','Retail',
        'Manufacturing','Manufacturing',
        'Energy','Defense','Government'
    ])[1 + floor(random() * 22)::int],
    (ARRAY['startup','startup','smb','smb','smb','mid_market','mid_market','mid_market','enterprise','enterprise'])[1 + floor(random() * 10)::int],
    lower(prefix) || lower(suffix) || '.com',
    (ARRAY['US','US','US','US','US','UK','UK','DE','DE','CA','CA','AU','JP','SG','BR','IN','FR','NL','SE','IL'])[1 + floor(random() * 20)::int],
    '2019-01-01'::timestamptz + (random() * interval '1095 days'),  -- 2019-2022
    CASE WHEN g <= 170 THEN true ELSE false END  -- ~85% active
FROM (
    SELECT
        g,
        (ARRAY['Apex','Quantum','Vector','Nexus','Cipher','Zenith','Pulse','Stratos','Vortex','Axiom',
               'Helix','Prism','Vertex','Nova','Orbit','Kinetic','Catalyst','Synapse','Cortex','Aegis'])[((g-1) % 20) + 1] AS prefix,
        (ARRAY['Systems','Technologies','Corp','Solutions','Industries','Dynamics','Labs','Networks','Group','Digital'])[((g-1) / 20) + 1] AS suffix
    FROM generate_series(1, 200) AS g
) AS src;

-- Organization settings (1:1)
INSERT INTO organization_settings (organization_id, notification_email, scan_frequency, retention_days, sso_enabled, mfa_required, settings_json)
SELECT
    id,
    'security@' || domain,
    (ARRAY['daily','daily','weekly','weekly','weekly','monthly'])[1 + floor(random() * 6)::int],
    (ARRAY[30, 60, 90, 90, 180, 365])[1 + floor(random() * 6)::int],
    size_tier = 'enterprise',
    random() < 0.4,
    '{"timezone":"UTC","language":"en"}'
FROM organizations;

-- ---------- Users (2,000) ----------
INSERT INTO users (organization_id, organization_name, email, full_name, role, last_login, created_at, is_active)
SELECT
    org_id,
    (SELECT name FROM organizations WHERE id = org_id),
    lower(first) || '.' || lower(last) || floor(random() * 100)::int || '@' || (SELECT domain FROM organizations WHERE id = org_id),
    first || ' ' || last,
    -- TECH DEBT: legacy role column, still populated, sometimes wrong
    (ARRAY['admin','analyst','analyst','analyst','viewer','viewer','viewer','responder','auditor'])[1 + floor(random() * 9)::int],
    -- TECH DEBT: last_login mostly NULL (~70%)
    CASE WHEN random() < 0.3 THEN now() - (random() * interval '90 days') ELSE NULL END,
    '2019-06-01'::timestamptz + (random() * interval '2000 days'),
    CASE WHEN random() < 0.9 THEN true ELSE false END
FROM (
    SELECT
        g,
        1 + floor(random() * 200)::int AS org_id,
        (ARRAY['James','Sarah','Michael','Emma','David','Olivia','Robert','Sophia','William','Isabella',
               'Daniel','Mia','Alexander','Charlotte','Ethan','Amelia','Matthew','Harper','Aiden','Evelyn',
               'Lucas','Abigail','Mason','Emily','Logan','Elizabeth','Jackson','Sofia','Liam','Avery'])[1 + floor(random() * 30)::int] AS first,
        (ARRAY['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
               'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
               'Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson'])[1 + floor(random() * 30)::int] AS last
    FROM generate_series(1, 2000) AS g
) AS src;

-- TECH DEBT: 3 duplicate emails from an org merge
UPDATE users SET email = 'admin@merged-company.com' WHERE id IN (1, 201);
UPDATE users SET email = 'ops@merged-company.com' WHERE id IN (50, 250);
UPDATE users SET email = 'security@merged-company.com' WHERE id IN (100, 300);

-- TECH DEBT: ~10% of organization_name values are stale (org renamed but user records not updated)
UPDATE users SET organization_name = organization_name || ' (old)'
WHERE id IN (SELECT id FROM users ORDER BY random() LIMIT 200);

-- ---------- Teams (400) ----------
INSERT INTO teams (organization_id, name, description, created_at)
SELECT
    org_id,
    team_name,
    'Team responsible for ' || lower(team_name),
    '2020-01-01'::timestamptz + (random() * interval '1500 days')
FROM (
    SELECT
        ((g-1) / 2) + 1 AS org_id,
        CASE WHEN g % 2 = 1
            THEN (ARRAY['Security Operations','Threat Hunting','Vulnerability Management','Incident Response','Compliance'])[1 + floor(random() * 5)::int]
            ELSE (ARRAY['Platform Engineering','Security Research','Risk Assessment','Detection Engineering','Red Team'])[1 + floor(random() * 5)::int]
        END AS team_name
    FROM generate_series(1, 400) AS g
) AS src;

-- ---------- Team Memberships (3,000) ----------
INSERT INTO team_memberships (user_id, team_id, role_id, joined_at)
SELECT DISTINCT ON (user_id, team_id)
    user_id,
    team_id,
    1 + floor(random() * 5)::int,
    '2020-06-01'::timestamptz + (random() * interval '1500 days')
FROM (
    SELECT
        1 + floor(random() * 2000)::int AS user_id,
        1 + floor(random() * 400)::int AS team_id
    FROM generate_series(1, 3500) AS g  -- generate extra, DISTINCT removes dupes
) AS src;

-- ---------- Invitations (150) ----------
INSERT INTO invitations (organization_id, email, role_name, invited_by, status, created_at, expires_at)
SELECT
    1 + floor(random() * 200)::int,
    'invite' || g || '@example.com',
    (ARRAY['analyst','viewer','responder'])[1 + floor(random() * 3)::int],
    1 + floor(random() * 2000)::int,
    CASE
        WHEN g <= 80  THEN 'pending'
        WHEN g <= 120 THEN 'accepted'
        ELSE 'expired'
    END,
    now() - (random() * interval '90 days'),
    now() + ((random() - 0.5) * interval '60 days')  -- some already expired
FROM generate_series(1, 150) AS g;


-- ==========================================================================
-- 5. BILLING DATA
-- ==========================================================================

-- ---------- Subscriptions (250) ----------
-- Some orgs have had multiple subscriptions (plan changes)
INSERT INTO subscriptions (organization_id, plan_id, plan_name, status, mrr_cents, started_at, current_period_end, created_at)
SELECT
    org_id,
    plan_id,
    -- TECH DEBT: plan_name denormalized, ~15% out of sync with plans.name
    CASE
        WHEN random() < 0.15 THEN (ARRAY['starter','Starter Plan','pro','Professional','ent','Enterprise','free_tier'])[1 + floor(random() * 7)::int]
        ELSE (SELECT name FROM plans WHERE id = plan_id)
    END,
    (ARRAY['active','active','active','active','active','active','active','canceled','past_due','trialing'])[1 + floor(random() * 10)::int],
    CASE plan_id
        WHEN 1 THEN 0
        WHEN 2 THEN 4900
        WHEN 3 THEN 14900
        WHEN 4 THEN 49900
        WHEN 5 THEN 25000 + floor(random() * 75000)::int
    END,
    '2019-06-01'::timestamptz + (random() * interval '1800 days'),
    now() + (random() * interval '365 days'),
    '2019-06-01'::timestamptz + (random() * interval '1800 days')
FROM (
    SELECT
        g,
        1 + floor(random() * 200)::int AS org_id,
        1 + floor(random() * 5)::int AS plan_id
    FROM generate_series(1, 250) AS g
) AS src;

-- ---------- Subscription Events (1,200) ----------
INSERT INTO subscription_events (subscription_id, event_type, old_plan_id, new_plan_id, created_at)
SELECT
    1 + floor(random() * 250)::int,
    (ARRAY['upgrade','upgrade','upgrade','downgrade','cancel','renew','renew','renew'])[1 + floor(random() * 8)::int],
    1 + floor(random() * 5)::int,
    1 + floor(random() * 5)::int,
    '2020-01-01'::timestamptz + (power(random(), 0.5) * interval '1825 days')
FROM generate_series(1, 1200) AS g;

-- ---------- Invoices (3,000) ----------
INSERT INTO invoices (organization_id, subscription_id, amount_cents, status, period_start, period_end, due_date, paid_at, created_at)
SELECT
    1 + floor(random() * 200)::int,
    1 + floor(random() * 250)::int,
    (ARRAY[4900, 14900, 49900, 4900, 14900])[1 + floor(random() * 5)::int],
    (ARRAY['paid','paid','paid','paid','paid','paid','paid','paid','open','void'])[1 + floor(random() * 10)::int],
    period_start,
    period_start + interval '1 month',
    period_start + interval '1 month' + interval '15 days',
    CASE WHEN random() < 0.85 THEN period_start + (random() * interval '30 days') ELSE NULL END,
    period_start
FROM (
    SELECT
        g,
        ('2020-01-01'::date + ((g * 3) % 1800) * interval '1 day')::date AS period_start
    FROM generate_series(1, 3000) AS g
) AS src;

-- ---------- Invoice Line Items (8,000) ----------
INSERT INTO invoice_line_items (invoice_id, subscription_id, description, amount_cents, quantity)
SELECT
    1 + floor(random() * 3000)::int,
    -- TECH DEBT: no FK to subscriptions
    CASE WHEN random() < 0.9 THEN 1 + floor(random() * 250)::int ELSE NULL END,
    (ARRAY['Platform subscription','Asset overage','API call overage','Premium support','Compliance module',
           'Threat intel add-on','SSO add-on','Extended retention'])[1 + floor(random() * 8)::int],
    (ARRAY[4900, 14900, 500, 2500, 9900, 4900, 2900, 1900])[1 + floor(random() * 8)::int],
    1
FROM generate_series(1, 8000) AS g;

-- ---------- Payment Methods (180) ----------
INSERT INTO payment_methods (organization_id, type, last4, expiry_month, expiry_year, is_default, created_at)
SELECT
    1 + floor(random() * 200)::int,
    (ARRAY['credit_card','credit_card','credit_card','credit_card','bank_transfer','wire'])[1 + floor(random() * 6)::int],
    lpad(floor(random() * 10000)::int::text, 4, '0'),
    1 + floor(random() * 12)::int,
    2025 + floor(random() * 4)::int,
    CASE WHEN g <= 170 THEN true ELSE false END,
    '2020-01-01'::timestamptz + (random() * interval '1500 days')
FROM generate_series(1, 180) AS g;


-- ==========================================================================
-- 6. PRODUCT DATA — Assets
-- ==========================================================================

-- ---------- Assets (15,000) ----------
INSERT INTO assets (organization_id, hostname, display_name, asset_type, ip_address, os, os_version, environment, is_active, first_seen, created_at)
SELECT
    1 + floor(random() * 200)::int,
    prefix || '-' || lpad(g::text, 5, '0') || '.' || suffix,
    -- TECH DEBT: display_name added 2023, NULL for ~40%
    CASE WHEN random() < 0.6 THEN prefix || '-' || lpad(g::text, 5, '0') || ' (' || env || ')' ELSE NULL END,
    -- TECH DEBT: asset_type expanded but old data not migrated
    CASE
        WHEN g <= 5000  THEN (ARRAY['server','endpoint','network'])[1 + floor(random() * 3)::int]  -- old types only
        ELSE (ARRAY['server','endpoint','network','cloud_vm','cloud_vm','container','container','serverless'])[1 + floor(random() * 8)::int]
    END,
    (192 + floor(random() * 3)::int)::text || '.' || (168 + floor(random() * 2)::int)::text || '.' ||
        floor(random() * 256)::int::text || '.' || floor(random() * 256)::int::text,
    (ARRAY['Ubuntu','CentOS','Windows Server','RHEL','Amazon Linux','Alpine','Debian','macOS'])[1 + floor(random() * 8)::int],
    (ARRAY['20.04','22.04','7','8','2019','2022','3.18','12','14'])[1 + floor(random() * 9)::int],
    env,
    CASE WHEN random() < 0.92 THEN true ELSE false END,
    '2019-06-01'::timestamptz + (power(random(), 0.6) * interval '2000 days'),
    '2019-06-01'::timestamptz + (power(random(), 0.6) * interval '2000 days')
FROM (
    SELECT
        g,
        (ARRAY['web','app','db','cache','queue','api','worker','proxy','monitor','bastion',
               'vpn','dns','mail','ldap','jump','ci','log','scan','backup','dev'])[1 + floor(random() * 20)::int] AS prefix,
        (ARRAY['prod.sentinel.local','staging.sentinel.local','dev.sentinel.local',
               'us-east.internal','eu-west.internal','ap-south.internal'])[1 + floor(random() * 6)::int] AS suffix,
        (ARRAY['production','production','production','staging','development','dmz'])[1 + floor(random() * 6)::int] AS env
    FROM generate_series(1, 15000) AS g
) AS src;

-- Set last_seen for active assets
UPDATE assets SET last_seen = now() - (random() * interval '7 days') WHERE is_active = true;
UPDATE assets SET last_seen = created_at + (random() * interval '365 days') WHERE is_active = false;

-- ---------- Asset Groups (600) ----------
INSERT INTO asset_groups (organization_id, name, description, created_at)
SELECT
    org_id,
    group_name || ' - Org ' || org_id,
    'Asset group for ' || lower(group_name) || ' assets',
    '2020-01-01'::timestamptz + (random() * interval '1500 days')
FROM (
    SELECT
        g,
        ((g - 1) / 3) + 1 AS org_id,
        (ARRAY['Production Servers','Staging Environment','DMZ','Cloud Infrastructure',
               'Endpoints','Network Devices','Critical Assets','Development',
               'Database Tier','Web Tier'])[((g - 1) % 3) + 1] AS group_name
    FROM generate_series(1, 600) AS g
) AS src;

-- ---------- Asset Group Memberships (20,000) ----------
INSERT INTO asset_group_memberships (asset_id, asset_group_id, added_at)
SELECT DISTINCT ON (asset_id, asset_group_id)
    asset_id,
    asset_group_id,
    '2020-06-01'::timestamptz + (random() * interval '1500 days')
FROM (
    SELECT
        1 + floor(random() * 15000)::int AS asset_id,
        1 + floor(random() * 600)::int AS asset_group_id
    FROM generate_series(1, 25000) AS g
) AS src;

-- ---------- Asset Tags (35,000 — EAV pattern) ----------
INSERT INTO asset_tags (asset_id, key, value, created_at)
SELECT
    1 + floor(random() * 15000)::int,
    tag_key,
    tag_value,
    '2020-01-01'::timestamptz + (random() * interval '1800 days')
FROM (
    SELECT
        g,
        (ARRAY['env','team','cost_center','compliance','owner','project','region','tier','criticality','backup_policy'])[1 + floor(random() * 10)::int] AS tag_key,
        (ARRAY['production','staging','dev','soc','infra','platform','us-east-1','eu-west-1','tier-1','tier-2',
               'daily','weekly','team-alpha','team-bravo','cc-1001','cc-2002','pci','hipaa','soc2','high','medium','low'])[1 + floor(random() * 22)::int] AS tag_value
    FROM generate_series(1, 35000) AS g
) AS src;

-- ---------- Agents (12,000) ----------
-- ~200 agents will reference non-existent assets (orphans)
INSERT INTO agents (asset_id, agent_version, status, last_heartbeat, installed_at, created_at)
SELECT
    CASE
        WHEN g <= 11800 THEN 1 + floor(random() * 15000)::int  -- valid asset references
        ELSE 15001 + (g - 11800)                                 -- TECH DEBT: orphaned references
    END,
    'v' || (ARRAY['2.1.0','2.2.0','2.3.1','2.4.0','2.5.0','3.0.0','3.0.1','3.1.0'])[1 + floor(random() * 8)::int],
    (ARRAY['active','active','active','active','active','active','inactive','disconnected','error'])[1 + floor(random() * 9)::int],
    CASE WHEN random() < 0.8 THEN now() - (random() * interval '24 hours') ELSE now() - (random() * interval '30 days') END,
    '2020-01-01'::timestamptz + (power(random(), 0.5) * interval '1800 days'),
    '2020-01-01'::timestamptz + (power(random(), 0.5) * interval '1800 days')
FROM generate_series(1, 12000) AS g;

-- ---------- Agent Heartbeats (50,000 — last 30 days) ----------
INSERT INTO agent_heartbeats (agent_id, cpu_percent, memory_percent, disk_percent, reported_at)
SELECT
    1 + floor(random() * 12000)::int,  -- TECH DEBT: no FK
    round((random() * 100)::numeric, 1),
    round((30 + random() * 60)::numeric, 1),
    round((20 + random() * 70)::numeric, 1),
    now() - (random() * interval '30 days')
FROM generate_series(1, 50000) AS g;


-- ==========================================================================
-- 7. PRODUCT DATA — Vulnerabilities & Scans
-- ==========================================================================

-- ---------- Vulnerabilities (500) ----------
INSERT INTO vulnerabilities (cve_id, title, description, severity, cvss_score, category, published_at, created_at)
SELECT
    'CVE-' || (2019 + (g % 7)) || '-' || lpad((g * 97 % 50000 + 10000)::text, 5, '0'),
    vuln_title,
    'Detailed description of ' || vuln_title || '. Affects multiple components and requires immediate attention.',
    sev,
    -- TECH DEBT: cvss_score NULL for ~30% of older vulns (published before 2022)
    CASE
        WHEN pub_year < 2022 AND random() < 0.5 THEN NULL
        ELSE CASE sev
            WHEN 'critical' THEN 9.0 + random()
            WHEN 'high'     THEN 7.0 + random() * 2
            WHEN 'medium'   THEN 4.0 + random() * 3
            WHEN 'low'      THEN 0.1 + random() * 3.9
        END
    END,
    cat,
    (pub_year || '-01-01')::date + floor(random() * 365)::int,
    (pub_year || '-01-01')::timestamptz + floor(random() * 365)::int * interval '1 day'
FROM (
    SELECT
        g,
        (ARRAY['SQL Injection in','Cross-Site Scripting via','Buffer Overflow in','Remote Code Execution in',
               'Privilege Escalation via','Path Traversal in','Authentication Bypass in','Denial of Service in',
               'Information Disclosure via','Insecure Deserialization in','Server-Side Request Forgery in',
               'XML External Entity in','Command Injection in','Broken Access Control in',
               'Cryptographic Weakness in'])[1 + floor(random() * 15)::int]
            || ' ' ||
            (ARRAY['Apache HTTP Server','OpenSSL','nginx','Log4j','Spring Framework','WordPress','PHP',
                   'Node.js Express','Django','Ruby on Rails','PostgreSQL','MySQL','Docker Engine',
                   'Kubernetes API','Redis','Elasticsearch','Jenkins','GitLab','Grafana','Terraform'])[1 + floor(random() * 20)::int]
        AS vuln_title,
        (ARRAY['low','low','medium','medium','medium','high','high','high','critical','critical'])[1 + floor(random() * 10)::int] AS sev,
        (ARRAY['injection','xss','overflow','rce','privilege_escalation','disclosure','config','crypto','access_control','dos'])[1 + floor(random() * 10)::int] AS cat,
        2019 + floor(random() * 7)::int AS pub_year
    FROM generate_series(1, 500) AS g
) AS src;

-- ---------- Scan Configurations (100) ----------
INSERT INTO scan_configurations (organization_id, name, scan_type, target_spec, schedule, is_active, created_at)
SELECT
    1 + floor(random() * 200)::int,
    scan_type_name || ' Scan - Config ' || g,
    scan_type_val,
    '192.168.' || floor(random() * 256)::int || '.0/24',
    (ARRAY['0 2 * * *','0 3 * * 0','0 0 1 * *','0 */6 * * *'])[1 + floor(random() * 4)::int],
    random() < 0.85,
    '2020-01-01'::timestamptz + (random() * interval '1500 days')
FROM (
    SELECT
        g,
        (ARRAY['Full','Quick','Targeted','Compliance'])[1 + floor(random() * 4)::int] AS scan_type_name,
        (ARRAY['full','quick','targeted','compliance'])[1 + floor(random() * 4)::int] AS scan_type_val
    FROM generate_series(1, 100) AS g
) AS src;

-- ---------- Scans (5,000) ----------
INSERT INTO scans (organization_id, scan_configuration_id, scan_type, status, started_at, completed_at, assets_scanned, findings_count, created_at)
SELECT
    1 + floor(random() * 200)::int,
    CASE WHEN random() < 0.7 THEN 1 + floor(random() * 100)::int ELSE NULL END,
    (ARRAY['full','full','quick','quick','targeted','compliance'])[1 + floor(random() * 6)::int],
    (ARRAY['completed','completed','completed','completed','completed','completed','completed','running','failed','queued'])[1 + floor(random() * 10)::int],
    start_ts,
    CASE WHEN random() < 0.85 THEN start_ts + (random() * interval '4 hours') ELSE NULL END,
    floor(random() * 500 + 10)::int,
    floor(random() * 200)::int,
    start_ts
FROM (
    SELECT
        g,
        '2020-01-01'::timestamptz + (power(random(), 0.4) * interval '1825 days') AS start_ts
    FROM generate_series(1, 5000) AS g
) AS src;

-- ---------- Scan Results (80,000 — LARGEST TABLE) ----------
INSERT INTO scan_results (scan_id, asset_id, vulnerability_id, risk_level, status, details, found_at, resolved_at)
SELECT
    1 + floor(random() * 5000)::int,     -- TECH DEBT: no FK
    CASE
        WHEN g <= 79500 THEN 1 + floor(random() * 15000)::int
        ELSE 15001 + floor(random() * 500)::int  -- TECH DEBT: ~500 orphan asset references
    END,
    1 + floor(random() * 500)::int,      -- TECH DEBT: no FK
    -- TECH DEBT: risk_level scale changed mid-2024. First 40K rows = 1-5, last 40K = 1-10
    CASE
        WHEN g <= 40000 THEN 1 + floor(random() * 5)::int
        ELSE 1 + floor(random() * 10)::int
    END,
    (ARRAY['open','open','open','fixed','fixed','in_progress','accepted_risk','false_positive'])[1 + floor(random() * 8)::int],
    CASE WHEN random() < 0.1 THEN 'Auto-detected during scheduled scan' ELSE NULL END,
    found_ts,
    CASE WHEN random() < 0.35 THEN found_ts + (random() * interval '90 days') ELSE NULL END
FROM (
    SELECT
        g,
        '2020-01-01'::timestamptz + (power(g::float / 80000, 1.0) * interval '1825 days') AS found_ts
    FROM generate_series(1, 80000) AS g
) AS src;

-- ---------- Vulnerability Instances (40,000) ----------
INSERT INTO vulnerability_instances (vulnerability_id, asset_id, scan_result_id, status, first_seen, last_seen, created_at)
SELECT
    1 + floor(random() * 500)::int,
    1 + floor(random() * 15000)::int,
    1 + floor(random() * 80000)::int,   -- TECH DEBT: no FK
    (ARRAY['open','open','open','fixed','in_progress','accepted_risk'])[1 + floor(random() * 6)::int],
    first_ts,
    first_ts + (random() * interval '180 days'),
    first_ts
FROM (
    SELECT
        g,
        '2020-06-01'::timestamptz + (power(random(), 0.5) * interval '1700 days') AS first_ts
    FROM generate_series(1, 40000) AS g
) AS src;

-- ---------- Remediation Actions (8,000) ----------
INSERT INTO remediation_actions (vulnerability_instance_id, assigned_to, status, priority, due_date, completed_at, created_at)
SELECT
    1 + floor(random() * 40000)::int,
    1 + floor(random() * 2000)::int,
    (ARRAY['open','open','in_progress','in_progress','completed','completed','completed','deferred'])[1 + floor(random() * 8)::int],
    (ARRAY['critical','high','high','medium','medium','medium','low','low'])[1 + floor(random() * 8)::int],
    (now() + (random() - 0.3) * interval '90 days')::date,
    CASE WHEN random() < 0.4 THEN now() - (random() * interval '60 days') ELSE NULL END,
    '2021-01-01'::timestamptz + (power(random(), 0.5) * interval '1500 days')
FROM generate_series(1, 8000) AS g;

-- ---------- Vulnerability Exceptions (500) ----------
INSERT INTO vulnerability_exceptions (vulnerability_id, organization_id, requested_by, reason, status, expires_at, created_at)
SELECT
    1 + floor(random() * 500)::int,
    1 + floor(random() * 200)::int,
    1 + floor(random() * 2000)::int,
    (ARRAY['Compensating control in place','False positive — not applicable to our stack',
           'Vendor patch pending, ETA 30 days','Risk accepted by CISO',
           'Mitigated by WAF rule','Legacy system, scheduled for decommission',
           'Low impact in our environment'])[1 + floor(random() * 7)::int],
    (ARRAY['approved','approved','approved','pending','pending','denied','expired'])[1 + floor(random() * 7)::int],
    now() + ((random() - 0.3) * interval '365 days'),
    '2021-01-01'::timestamptz + (random() * interval '1500 days')
FROM generate_series(1, 500) AS g;


-- ==========================================================================
-- 8. THREAT & INCIDENT DATA
-- ==========================================================================

-- ---------- Incidents (1,500) ----------
INSERT INTO incidents (organization_id, organization_name, title, description, severity, status, assigned_to, created_at, updated_at, resolved_at)
SELECT
    org_id,
    (SELECT name FROM organizations WHERE id = org_id),
    incident_title,
    'Investigation into ' || lower(incident_title) || '. Multiple indicators observed.',
    (ARRAY['critical','critical','high','high','high','medium','medium','medium','low','low'])[1 + floor(random() * 10)::int],
    -- TECH DEBT: 'identified'/'monitoring' overlap, 'closed' deprecated but still present
    CASE
        WHEN g <= 50  THEN 'closed'          -- old terminal state, deprecated
        WHEN g <= 300 THEN 'resolved'         -- current terminal state
        WHEN g <= 400 THEN 'monitoring'       -- overlaps with 'identified'
        WHEN g <= 500 THEN 'identified'       -- overlaps with 'monitoring'
        WHEN g <= 900 THEN 'investigating'
        ELSE 'open'
    END,
    CASE WHEN random() < 0.7 THEN 1 + floor(random() * 2000)::int ELSE NULL END,
    created_ts,
    created_ts + (random() * interval '30 days'),
    CASE WHEN g <= 350 THEN created_ts + (random() * interval '14 days') ELSE NULL END
FROM (
    SELECT
        g,
        1 + floor(random() * 200)::int AS org_id,
        (ARRAY['Suspicious login activity from','Malware detected on','Unauthorized access attempt to',
               'Data exfiltration alert for','Brute force attack against','Phishing campaign targeting',
               'Ransomware indicator found on','Lateral movement detected in','Privilege escalation on',
               'DDoS attack targeting','Credential stuffing against','Supply chain compromise in',
               'Insider threat activity on','Zero-day exploit attempt on','C2 beacon detected from'])[1 + floor(random() * 15)::int]
            || ' ' || (ARRAY['production servers','customer portal','internal network','cloud infrastructure',
                             'email gateway','VPN endpoint','database cluster','CI/CD pipeline',
                             'admin console','API gateway'])[1 + floor(random() * 10)::int]
        AS incident_title,
        '2020-01-01'::timestamptz + (power(random(), 0.4) * interval '1825 days') AS created_ts
    FROM generate_series(1, 1500) AS g
) AS src;

-- ---------- Incident Events (6,000) ----------
INSERT INTO incident_events (incident_id, event_type, description, created_by, created_at)
SELECT
    1 + floor(random() * 1500)::int,
    (ARRAY['created','assigned','status_change','comment','evidence_added','escalated',
           'notification_sent','playbook_executed','containment_action','resolution'])[1 + floor(random() * 10)::int],
    'Event recorded during incident investigation',
    1 + floor(random() * 2000)::int,
    '2020-06-01'::timestamptz + (power(random(), 0.4) * interval '1700 days')
FROM generate_series(1, 6000) AS g;

-- ---------- Incident Comments (3,500) ----------
INSERT INTO incident_comments (incident_id, user_id, content, created_at)
SELECT
    1 + floor(random() * 1500)::int,
    1 + floor(random() * 2000)::int,
    (ARRAY['Confirmed malicious activity. Escalating to tier 2.',
           'False positive — benign automation script.',
           'Containment actions in progress. Affected systems isolated.',
           'Root cause identified: unpatched vulnerability CVE-2024-XXXX.',
           'Customer notified per SLA requirements.',
           'Forensic image captured for evidence preservation.',
           'IOCs extracted and shared with threat intel team.',
           'Playbook step 3 complete. Moving to eradication.',
           'All affected credentials rotated.',
           'Monitoring for recurrence. Will close after 48h clear window.'])[1 + floor(random() * 10)::int],
    '2020-06-01'::timestamptz + (power(random(), 0.4) * interval '1700 days')
FROM generate_series(1, 3500) AS g;

-- ---------- Alert Rules (200) ----------
INSERT INTO alert_rules (organization_id, name, condition_type, threshold, severity, is_active, created_at)
SELECT
    1 + floor(random() * 200)::int,
    rule_name || ' - Rule ' || g,
    (ARRAY['threshold','anomaly','pattern','correlation'])[1 + floor(random() * 4)::int],
    (ARRAY[1, 5, 10, 50, 100])[1 + floor(random() * 5)::int]::real,
    (ARRAY['critical','high','medium','low'])[1 + floor(random() * 4)::int],
    random() < 0.85,
    '2020-01-01'::timestamptz + (random() * interval '1500 days')
FROM (
    SELECT
        g,
        (ARRAY['Failed login threshold','Port scan detection','Malware signature match',
               'Unusual data transfer','Off-hours access','New admin account created',
               'Firewall rule violation','DNS tunneling detection','Brute force detection',
               'Privilege escalation attempt'])[1 + floor(random() * 10)::int] AS rule_name
    FROM generate_series(1, 200) AS g
) AS src;

-- ---------- Alerts (12,000) ----------
INSERT INTO alerts (organization_id, alert_rule_id, severity, title, status, incident_id, source, created_at, acknowledged_at)
SELECT
    1 + floor(random() * 200)::int,
    CASE WHEN random() < 0.8 THEN 1 + floor(random() * 200)::int ELSE NULL END,
    -- TECH DEBT: ~200 old alerts have NULL severity
    CASE
        WHEN g <= 200 THEN NULL
        ELSE (ARRAY['critical','high','high','medium','medium','medium','low','low'])[1 + floor(random() * 8)::int]
    END,
    (ARRAY['Suspicious login detected','Malware signature match','Port scan activity',
           'Unusual outbound traffic','Failed login threshold exceeded','New admin account',
           'Firewall policy violation','Certificate expiration warning','Vulnerability scan finding',
           'Endpoint agent offline','DNS query anomaly','Unauthorized API access'])[1 + floor(random() * 12)::int],
    (ARRAY['open','open','acknowledged','acknowledged','resolved','resolved','resolved','dismissed'])[1 + floor(random() * 8)::int],
    -- TECH DEBT: no FK to incidents. ~10% of alerts escalated
    CASE WHEN random() < 0.1 THEN 1 + floor(random() * 1500)::int ELSE NULL END,
    (ARRAY['agent','scanner','siem','ids','firewall','edr','cloud_trail','user_report'])[1 + floor(random() * 8)::int],
    alert_ts,
    CASE WHEN random() < 0.6 THEN alert_ts + (random() * interval '4 hours') ELSE NULL END
FROM (
    SELECT
        g,
        '2020-01-01'::timestamptz + (power(random(), 0.35) * interval '1825 days') AS alert_ts
    FROM generate_series(1, 12000) AS g
) AS src;

-- ---------- Alert Acknowledgments (8,000) ----------
INSERT INTO alert_acknowledgments (alert_id, user_id, acknowledged_at, note)
SELECT
    1 + floor(random() * 12000)::int,
    1 + floor(random() * 2000)::int,
    '2020-06-01'::timestamptz + (power(random(), 0.4) * interval '1700 days'),
    CASE WHEN random() < 0.3
        THEN (ARRAY['Investigating','Known issue','Escalated to team lead','False positive','Handled via playbook'])[1 + floor(random() * 5)::int]
        ELSE NULL
    END
FROM generate_series(1, 8000) AS g;


-- ==========================================================================
-- 9. THREAT INTELLIGENCE DATA
-- ==========================================================================

-- ---------- Indicators of Compromise (2,000) ----------
INSERT INTO indicators_of_compromise (threat_feed_id, ioc_type, value, confidence, threat_actor_id, first_seen, last_seen, created_at)
SELECT
    1 + floor(random() * 10)::int,
    ioc_type,
    CASE ioc_type
        WHEN 'ip'     THEN floor(random() * 223 + 1)::int || '.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int
        WHEN 'domain'  THEN (ARRAY['malware','c2','phish','exfil','drop','loader','beacon','stage'])[1 + floor(random() * 8)::int]
                             || '-' || lpad(floor(random() * 10000)::int::text, 4, '0') || '.'
                             || (ARRAY['evil.com','badactor.net','malicious.org','darkweb.xyz','threat.io'])[1 + floor(random() * 5)::int]
        WHEN 'hash'    THEN md5(random()::text)
        WHEN 'url'     THEN 'https://' || (ARRAY['malware','c2','phish'])[1 + floor(random() * 3)::int]
                             || '.example.com/' || md5(random()::text)
        WHEN 'email'   THEN (ARRAY['attacker','phisher','scammer'])[1 + floor(random() * 3)::int]
                             || floor(random() * 1000)::int || '@malicious-domain.com'
    END,
    floor(random() * 100 + 1)::int,
    CASE WHEN random() < 0.3 THEN 1 + floor(random() * 50)::int ELSE NULL END,
    seen_ts,
    seen_ts + (random() * interval '180 days'),
    seen_ts
FROM (
    SELECT
        g,
        (ARRAY['ip','ip','ip','domain','domain','hash','hash','url','email'])[1 + floor(random() * 9)::int] AS ioc_type,
        '2020-01-01'::timestamptz + (power(random(), 0.4) * interval '1825 days') AS seen_ts
    FROM generate_series(1, 2000) AS g
) AS src;


-- ==========================================================================
-- 10. COMPLIANCE DATA
-- ==========================================================================

-- ---------- Compliance Controls (200) ----------
INSERT INTO compliance_controls (framework_id, control_id_code, title, description, category)
SELECT
    framework_id,
    code_prefix || '-' || lpad(g::text, 3, '0'),
    'Control: ' || control_title,
    'Detailed requirements for ' || lower(control_title),
    (ARRAY['Access Control','Audit','Risk Management','Incident Response','Configuration Management',
           'Data Protection','Network Security','Personnel Security','Physical Security','System Integrity'])[1 + floor(random() * 10)::int]
FROM (
    SELECT
        g,
        ((g - 1) % 5) + 1 AS framework_id,
        CASE ((g - 1) % 5) + 1
            WHEN 1 THEN 'SOC2'
            WHEN 2 THEN 'ISO'
            WHEN 3 THEN 'PCI'
            WHEN 4 THEN 'HIP'
            WHEN 5 THEN 'NIST'
        END AS code_prefix,
        (ARRAY['Access control policy enforcement','Audit log retention','Risk assessment frequency',
               'Incident response plan testing','Encryption at rest','Network segmentation',
               'Vulnerability scanning schedule','Change management process','Backup verification',
               'Security awareness training','MFA enforcement','Third-party risk assessment',
               'Data classification policy','Endpoint protection deployment','Patch management SLA',
               'Password complexity requirements','Session timeout configuration','API security controls',
               'Cloud security posture management','Supply chain security review'])[1 + floor(random() * 20)::int] AS control_title
    FROM generate_series(1, 200) AS g
) AS src;

-- ---------- Compliance Assessments (600) ----------
INSERT INTO compliance_assessments (organization_id, framework_id, status, started_at, completed_at, score, created_at)
SELECT
    1 + floor(random() * 200)::int,
    1 + floor(random() * 5)::int,
    (ARRAY['completed','completed','completed','completed','in_progress','scheduled'])[1 + floor(random() * 6)::int],
    start_ts,
    CASE WHEN random() < 0.75 THEN start_ts + (random() * interval '14 days') ELSE NULL END,
    CASE WHEN random() < 0.75 THEN round((50 + random() * 50)::numeric, 1) ELSE NULL END,
    start_ts
FROM (
    SELECT
        g,
        '2020-06-01'::timestamptz + (power(random(), 0.5) * interval '1700 days') AS start_ts
    FROM generate_series(1, 600) AS g
) AS src;

-- ---------- Compliance Findings (5,000) ----------
INSERT INTO compliance_findings (assessment_id, control_id, status, evidence, notes, created_at)
SELECT
    1 + floor(random() * 600)::int,
    1 + floor(random() * 200)::int,
    -- TECH DEBT: case-inconsistent status values
    (ARRAY['pass','pass','pass','Pass','PASS','fail','fail','Fail','partial','partial','not_applicable','N/A'])[1 + floor(random() * 12)::int],
    CASE WHEN random() < 0.4 THEN 'Evidence collected from audit log and configuration review' ELSE NULL END,
    CASE WHEN random() < 0.2 THEN 'Remediation required within 30 days' ELSE NULL END,
    '2021-01-01'::timestamptz + (power(random(), 0.5) * interval '1500 days')
FROM generate_series(1, 5000) AS g;


-- ==========================================================================
-- 11. USAGE & AUDIT DATA
-- ==========================================================================

-- ---------- API Keys (300) ----------
INSERT INTO api_keys (organization_id, user_id, name, key_prefix, key_hash, permissions, is_active, last_used, created_at, expires_at)
SELECT
    1 + floor(random() * 200)::int,
    1 + floor(random() * 2000)::int,
    (ARRAY['CI/CD Pipeline','Monitoring Integration','Custom Dashboard','Data Export','Slack Bot',
           'JIRA Integration','Automation Script','Terraform Provider'])[1 + floor(random() * 8)::int] || ' Key',
    'stl_' || substr(md5(random()::text), 1, 8),
    md5(random()::text || g::text),
    (ARRAY['read','read','read:write','admin'])[1 + floor(random() * 4)::int],
    random() < 0.8,
    CASE WHEN random() < 0.7 THEN now() - (random() * interval '30 days') ELSE NULL END,
    '2020-06-01'::timestamptz + (random() * interval '1700 days'),
    CASE WHEN random() < 0.6 THEN now() + (random() * interval '365 days') ELSE NULL END
FROM generate_series(1, 300) AS g;

-- ---------- API Requests (20,000 — last 90 days) ----------
INSERT INTO api_requests (api_key_id, user_id, method, path, status_code, response_time_ms, request_body, created_at)
SELECT
    1 + floor(random() * 300)::int,
    1 + floor(random() * 2000)::int,   -- TECH DEBT: no FK
    (ARRAY['GET','GET','GET','GET','POST','POST','PUT','DELETE'])[1 + floor(random() * 8)::int],
    (ARRAY['/api/v1/assets','/api/v1/scans','/api/v1/vulnerabilities','/api/v1/incidents',
           '/api/v1/reports','/api/v1/alerts','/api/v1/compliance','/api/v1/users'])[1 + floor(random() * 8)::int],
    (ARRAY[200,200,200,200,200,201,400,401,403,404,500])[1 + floor(random() * 11)::int],
    floor(random() * 2000 + 10)::int,
    NULL,   -- TECH DEBT: dead column, always NULL (privacy fix applied 2024)
    now() - (random() * interval '90 days')
FROM generate_series(1, 20000) AS g;

-- ---------- Feature Usage (15,000) ----------
INSERT INTO feature_usage (organization_id, user_id, feature_name, action, metadata, created_at)
SELECT
    1 + floor(random() * 200)::int,
    1 + floor(random() * 2000)::int,
    (ARRAY['vulnerability_scanner','asset_inventory','incident_manager','compliance_dashboard',
           'threat_intel','report_builder','api_access','alert_rules','integrations','executive_dashboard'])[1 + floor(random() * 10)::int],
    (ARRAY['view','view','view','create','update','delete','export','configure'])[1 + floor(random() * 8)::int],
    NULL,
    '2021-01-01'::timestamptz + (power(random(), 0.35) * interval '1500 days')
FROM generate_series(1, 15000) AS g;

-- ---------- Login Events (10,000) ----------
INSERT INTO login_events (user_id, ip_address, user_agent, success, failure_reason, created_at)
SELECT
    1 + floor(random() * 2000)::int,
    floor(random() * 223 + 1)::int || '.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int,
    (ARRAY['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120','Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/17',
           'Mozilla/5.0 (X11; Linux x86_64) Firefox/121','Mozilla/5.0 (iPhone; CPU iPhone OS 17) Mobile',
           'python-requests/2.31','curl/8.4.0'])[1 + floor(random() * 6)::int],
    CASE WHEN random() < 0.92 THEN true ELSE false END,
    CASE WHEN random() >= 0.92 THEN (ARRAY['invalid_password','account_locked','mfa_failed','expired_session'])[1 + floor(random() * 4)::int] ELSE NULL END,
    '2021-01-01'::timestamptz + (power(random(), 0.3) * interval '1500 days')
FROM generate_series(1, 10000) AS g;

-- ---------- Notifications (5,000) ----------
INSERT INTO notifications (user_id, organization_id, type, title, message, is_read, created_at)
SELECT
    1 + floor(random() * 2000)::int,
    1 + floor(random() * 200)::int,
    (ARRAY['alert','incident','scan_complete','compliance','system','billing','report_ready'])[1 + floor(random() * 7)::int],
    (ARRAY['New critical alert','Incident assigned to you','Scan completed','Compliance assessment due',
           'System maintenance scheduled','Invoice generated','Weekly report ready',
           'New vulnerability detected','Agent offline','Password expiring soon'])[1 + floor(random() * 10)::int],
    'Please review and take appropriate action.',
    random() < 0.6,
    '2021-06-01'::timestamptz + (power(random(), 0.3) * interval '1400 days')
FROM generate_series(1, 5000) AS g;


-- ==========================================================================
-- 12. REPORTING & DENORMALIZED TABLES (populated from existing data)
-- ==========================================================================

-- ---------- Daily Scan Stats (~2,000) ----------
INSERT INTO daily_scan_stats (organization_id, scan_date, total_scans, total_findings, critical_count, high_count, medium_count, low_count)
SELECT
    1 + floor(random() * 200)::int,
    ('2023-01-01'::date + g),
    1 + floor(random() * 10)::int,
    floor(random() * 100)::int,
    floor(random() * 5)::int,
    floor(random() * 20)::int,
    floor(random() * 50)::int,
    floor(random() * 30)::int
FROM generate_series(0, 1999) AS g;

-- ---------- Monthly Vulnerability Summary (~500) ----------
INSERT INTO monthly_vulnerability_summary (organization_id, month, total_vulns, critical_vulns, high_vulns, medium_vulns, low_vulns, avg_time_to_fix_days)
SELECT
    1 + floor(random() * 200)::int,
    ('2022-01-01'::date + (g * 30 % 1095)),
    floor(random() * 500 + 50)::int,
    floor(random() * 20)::int,
    floor(random() * 80)::int,
    floor(random() * 200)::int,
    floor(random() * 100)::int,
    round((random() * 30 + 5)::numeric, 1)
FROM generate_series(1, 500) AS g;

-- ---------- Organization Health Scores (200) ----------
INSERT INTO organization_health_scores (organization_id, score, vulnerability_score, compliance_score, asset_coverage_score, calculated_at)
SELECT
    id,
    round((50 + random() * 50)::numeric, 1),
    round((30 + random() * 70)::numeric, 1),
    round((40 + random() * 60)::numeric, 1),
    round((60 + random() * 40)::numeric, 1),
    now() - (random() * interval '7 days')
FROM organizations;

-- ---------- Scan Results Denormalized (from existing data, ~80K) ----------
-- This mirrors scan_results with pre-joined columns (no FKs on this table)
INSERT INTO scan_results_denormalized
    (scan_id, scan_type, scan_started_at, asset_id, hostname, asset_type,
     organization_id, organization_name, vulnerability_id, cve_id, vulnerability_title,
     severity, cvss_score, risk_level, status, found_at)
SELECT
    sr.scan_id,
    s.scan_type,
    s.started_at,
    sr.asset_id,
    a.hostname,
    a.asset_type,
    a.organization_id,
    o.name,
    sr.vulnerability_id,
    v.cve_id,
    v.title,
    v.severity,
    v.cvss_score,
    sr.risk_level,
    sr.status,
    sr.found_at
FROM scan_results sr
LEFT JOIN scans s ON s.id = sr.scan_id
LEFT JOIN assets a ON a.id = sr.asset_id
LEFT JOIN organizations o ON o.id = a.organization_id
LEFT JOIN vulnerabilities v ON v.id = sr.vulnerability_id
LIMIT 80000;

-- ---------- Executive Dashboard Cache (200) ----------
INSERT INTO executive_dashboard_cache (organization_id, total_assets, active_agents, open_vulnerabilities, critical_incidents, compliance_score, risk_score, generated_at)
SELECT
    o.id,
    (SELECT count(*) FROM assets WHERE organization_id = o.id),
    (SELECT count(*) FROM agents ag JOIN assets a ON a.id = ag.asset_id WHERE a.organization_id = o.id AND ag.status = 'active'),
    floor(random() * 200)::int,
    floor(random() * 5)::int,
    round((40 + random() * 60)::numeric, 1),
    round((random() * 100)::numeric, 1),
    now() - (random() * interval '24 hours')
FROM organizations o;


-- ==========================================================================
-- 13. REPORTS, DASHBOARDS, INTEGRATIONS
-- ==========================================================================

-- ---------- Reports (500) ----------
INSERT INTO reports (organization_id, created_by, title, report_type, format, parameters, status, file_path, created_at)
SELECT
    1 + floor(random() * 200)::int,
    1 + floor(random() * 2000)::int,
    (ARRAY['Monthly Vulnerability Report','Executive Security Summary','Compliance Assessment Report',
           'Incident Response Summary','Asset Inventory Report','Threat Landscape Analysis',
           'Risk Scorecard','Scan Coverage Report','Remediation Progress Report','Audit Trail Report'])[1 + floor(random() * 10)::int],
    (ARRAY['vulnerability','executive','compliance','incident','asset','threat'])[1 + floor(random() * 6)::int],
    (ARRAY['pdf','pdf','pdf','csv','xlsx'])[1 + floor(random() * 5)::int],
    '{"period":"monthly","org_filter":null}',
    (ARRAY['completed','completed','completed','generating','failed'])[1 + floor(random() * 5)::int],
    '/reports/' || md5(random()::text) || '.pdf',
    '2021-01-01'::timestamptz + (power(random(), 0.5) * interval '1600 days')
FROM generate_series(1, 500) AS g;

-- ---------- Report Schedules (100) ----------
INSERT INTO report_schedules (report_id, cron_expression, recipients, is_active, last_run, next_run, created_at)
SELECT
    1 + floor(random() * 500)::int,
    (ARRAY['0 8 1 * *','0 9 * * 1','0 6 1 1,4,7,10 *','0 0 1 * *'])[1 + floor(random() * 4)::int],
    'security-team@example.com,ciso@example.com',
    random() < 0.8,
    now() - (random() * interval '30 days'),
    now() + (random() * interval '30 days'),
    '2022-01-01'::timestamptz + (random() * interval '1200 days')
FROM generate_series(1, 100) AS g;

-- ---------- Dashboards (300) ----------
INSERT INTO dashboards (organization_id, created_by, name, description, is_default, layout, created_at)
SELECT
    1 + floor(random() * 200)::int,
    1 + floor(random() * 2000)::int,
    (ARRAY['Security Overview','Vulnerability Dashboard','Incident Tracker','Compliance Status',
           'Executive Summary','SOC Dashboard','Asset Health','Threat Intel Feed',
           'Risk Heatmap','Scan Activity'])[1 + floor(random() * 10)::int] || ' - ' || g,
    'Dashboard for monitoring security posture',
    g <= 200,  -- first 200 are defaults (one per org)
    '{"columns":12,"rows":"auto"}',
    '2021-06-01'::timestamptz + (random() * interval '1500 days')
FROM generate_series(1, 300) AS g;

-- ---------- Dashboard Widgets (1,200) ----------
INSERT INTO dashboard_widgets (dashboard_id, widget_type, title, config, position_x, position_y, width, height)
SELECT
    1 + floor(random() * 300)::int,
    (ARRAY['chart','table','metric','map','timeline','heatmap','list','gauge'])[1 + floor(random() * 8)::int],
    (ARRAY['Critical Vulns','Open Incidents','Scan Coverage','Compliance Score','Alert Volume',
           'Asset Count','Agent Health','Risk Trend','Top CVEs','Mean Time to Remediate'])[1 + floor(random() * 10)::int],
    '{"datasource":"auto","refresh":300}',
    (g % 3) * 4,
    (g / 3 % 4) * 3,
    (ARRAY[4, 6, 8, 12])[1 + floor(random() * 4)::int],
    (ARRAY[2, 3, 4, 6])[1 + floor(random() * 4)::int]
FROM generate_series(1, 1200) AS g;

-- ---------- Integrations (150) ----------
INSERT INTO integrations (organization_id, type, name, config, status, last_sync, created_at)
SELECT
    1 + floor(random() * 200)::int,
    int_type,
    int_type || ' Integration',
    '{"webhook_url":"https://hooks.example.com/' || md5(random()::text) || '"}',
    (ARRAY['active','active','active','active','error','disabled'])[1 + floor(random() * 6)::int],
    CASE WHEN random() < 0.8 THEN now() - (random() * interval '24 hours') ELSE NULL END,
    '2021-01-01'::timestamptz + (random() * interval '1600 days')
FROM (
    SELECT
        g,
        (ARRAY['slack','slack','jira','jira','pagerduty','pagerduty','teams','email',
               'webhook','splunk','servicenow','opsgenie'])[1 + floor(random() * 12)::int] AS int_type
    FROM generate_series(1, 150) AS g
) AS src;

-- ---------- Integration Events (5,000) ----------
INSERT INTO integration_events (integration_id, event_type, direction, payload, status, created_at)
SELECT
    1 + floor(random() * 150)::int,
    (ARRAY['alert_sent','incident_created','ticket_updated','notification_sent','sync_completed','webhook_received'])[1 + floor(random() * 6)::int],
    (ARRAY['outbound','outbound','outbound','inbound'])[1 + floor(random() * 4)::int],
    '{"event_id":"' || md5(random()::text) || '"}',
    (ARRAY['success','success','success','success','failed','retrying'])[1 + floor(random() * 6)::int],
    '2022-01-01'::timestamptz + (power(random(), 0.4) * interval '1300 days')
FROM generate_series(1, 5000) AS g;

-- ---------- Audit Log (25,000) ----------
INSERT INTO audit_log (organization_id, user_id, action, resource_type, resource_id, details, ip_address, created_at)
SELECT
    1 + floor(random() * 200)::int,   -- no FK
    1 + floor(random() * 2000)::int,  -- no FK
    (ARRAY['login','logout','create','update','delete','export','configure','invite','revoke','scan_start',
           'report_generate','alert_acknowledge','incident_create','role_change','api_key_create'])[1 + floor(random() * 15)::int],
    (ARRAY['user','asset','scan','incident','alert','report','integration','api_key','team','dashboard'])[1 + floor(random() * 10)::int],
    floor(random() * 10000)::int::text,
    CASE WHEN random() < 0.3 THEN '{"ip":"192.168.1.' || floor(random() * 255)::int || '"}' ELSE NULL END,
    floor(random() * 223 + 1)::int || '.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int,
    '2020-01-01'::timestamptz + (power(random(), 0.3) * interval '2000 days')
FROM generate_series(1, 25000) AS g;


-- ==========================================================================
-- 14. LEGACY & ABANDONED TABLE DATA
-- ==========================================================================

-- ---------- old_scan_results_v2 (5,000) — abandoned 2023 migration ----------
INSERT INTO old_scan_results_v2 (scan_run_id, target_host, vuln_code, severity_score, detection_date, remediated)
SELECT
    floor(random() * 1000 + 1)::int,
    'host-' || lpad(floor(random() * 5000)::int::text, 4, '0') || '.legacy.internal',
    'VULN-' || lpad(floor(random() * 999)::int::text, 3, '0'),
    round((random() * 10)::numeric, 1),
    '2022-01-01'::timestamptz + (random() * interval '365 days'),
    random() < 0.3
FROM generate_series(1, 5000) AS g;

-- ---------- temp_asset_import_2024 (1,200) — one-time CSV import artifact ----------
INSERT INTO temp_asset_import_2024 (import_hostname, import_ip, import_os, import_env, raw_csv_line, imported_at)
SELECT
    'imported-host-' || g,
    '10.0.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int,
    (ARRAY['Windows 10','Windows 11','macOS 14','Ubuntu 22.04','RHEL 9'])[1 + floor(random() * 5)::int],
    (ARRAY['prod','staging','dev','unknown',''])[1 + floor(random() * 5)::int],
    'imported-host-' || g || ',10.0.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int || ',Windows,prod',
    '2024-03-15'::timestamptz + (random() * interval '2 hours')
FROM generate_series(1, 1200) AS g;

-- ---------- feature_flags_legacy (50) — replaced by LaunchDarkly ----------
INSERT INTO feature_flags_legacy (flag_name, is_enabled, rollout_percentage, description, updated_at)
SELECT
    (ARRAY['new_dashboard','dark_mode','beta_api','advanced_search','ml_detection',
           'new_onboarding','slack_v2','report_v3','asset_graph','threat_map',
           'sso_okta','sso_azure','rbac_v2','audit_export','bulk_scan',
           'auto_remediation','risk_scoring_v2','compliance_auto','api_v2','webhook_v2'])[((g-1) % 20) + 1]
        || CASE WHEN g > 20 THEN '_' || (g / 20)::int::text ELSE '' END,
    random() < 0.3,
    floor(random() * 100)::int,
    'Legacy feature flag — migrated to LaunchDarkly',
    '2023-01-01'::timestamptz + (random() * interval '365 days')
FROM generate_series(1, 50) AS g;

-- ---------- notifications_backup (8,000) — pre-redesign backup ----------
INSERT INTO notifications_backup (recipient_id, notification_type, subject, body, sent_at, read_at)
SELECT
    floor(random() * 1500 + 1)::int,    -- old user ID scheme
    (ARRAY['email','in_app','push','sms'])[1 + floor(random() * 4)::int],
    (ARRAY['Security Alert','Scan Complete','New Incident','Weekly Report','Action Required',
           'Compliance Reminder','System Update','Account Activity'])[1 + floor(random() * 8)::int],
    'This is a legacy notification from the old notification system.',
    '2021-01-01'::timestamptz + (random() * interval '730 days'),
    CASE WHEN random() < 0.5 THEN '2021-01-01'::timestamptz + (random() * interval '730 days') ELSE NULL END
FROM generate_series(1, 8000) AS g;

-- ---------- user_sessions_archive (15,000) — old session system ----------
INSERT INTO user_sessions_archive (session_token, user_ref_id, login_time, logout_time, ip_addr, browser)
SELECT
    md5(random()::text || g::text),
    floor(random() * 1000 + 5000)::int,   -- old user IDs (5000-6000 range, don't match current users)
    login_ts,
    CASE WHEN random() < 0.7 THEN login_ts + (random() * interval '8 hours') ELSE NULL END,
    '10.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int || '.' || floor(random() * 256)::int,
    (ARRAY['Chrome 95','Firefox 94','Safari 15','Edge 96','Chrome 90','Firefox 88'])[1 + floor(random() * 6)::int]
FROM (
    SELECT g, '2020-01-01'::timestamptz + (random() * interval '1095 days') AS login_ts
    FROM generate_series(1, 15000) AS g
) AS src;

-- ---------- legacy_risk_scores (1,000) — old scoring algorithm ----------
INSERT INTO legacy_risk_scores (org_id, risk_category, score_value, weight, computed_date)
SELECT
    floor(random() * 200 + 1)::int,
    (ARRAY['vulnerability','compliance','threat','operational','financial'])[1 + floor(random() * 5)::int],
    round((random() * 1000)::numeric, 2),   -- different scale (0-1000) vs current (0-100)
    round((random())::numeric, 2),
    ('2021-01-01'::date + floor(random() * 730)::int)
FROM generate_series(1, 1000) AS g;


COMMIT;

-- ==========================================================================
-- Verify row counts
-- ==========================================================================
SELECT 'Row counts:' AS info;
SELECT schemaname, relname AS table_name, n_live_tup AS row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
