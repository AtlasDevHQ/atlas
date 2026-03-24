# BYOD Multi-Source Architecture Design

> Design doc for Atlas's multi-source data platform. Covers the unified source abstraction, credential management, per-source security, action model, interaction surfaces, multi-tenancy, and phased rollout from v0.7 through v1.0.

## Decision

**Three-tier source taxonomy with phased unlocking.** Sources are classified as DataSources (read), ActionTargets (write-back), or InteractionSurfaces (bidirectional). Each tier has its own security posture, credential requirements, and approval model. v0.7 ships multi-database read-only. v0.8 adds non-SQL DataSources. v0.9 adds ActionTargets with approval flows. v1.0 adds self-service source provisioning with per-user scoping.

---

## 1. Source Taxonomy

Atlas connects to external systems. Every external system falls into one of three categories based on the direction and risk of data flow:

```
                         ┌──────────────────┐
                         │   Atlas Agent     │
                         └────────┬─────────┘
                                  │
               ┌──────────────────┼──────────────────┐
               │                  │                  │
        ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
        │  DataSource  │   │ActionTarget │   │ Interaction │
        │  (read-only) │   │ (write-back)│   │  Surface    │
        └──────────────┘   └─────────────┘   └─────────────┘
         PostgreSQL         Slack (post)      Slack (listen)
         MySQL              JIRA (create)     Email (receive)
         Snowflake          PagerDuty         Webhooks
         ClickHouse         Email (send)      MS Teams
         DuckDB             HTTP endpoints    API consumers
         Salesforce (SOQL)
         REST APIs (GET)
         GraphQL (query)
         CSV/Parquet (file)
```

### 1.1 DataSource (read-only)

**What it is:** Anything the agent reads from to answer questions. Today this is SQL databases (Postgres, MySQL, ClickHouse, Snowflake, DuckDB) and Salesforce (SOQL). The abstraction expands to REST APIs, GraphQL endpoints, and file-based sources (CSV, Parquet via DuckDB).

**Security posture:** Read-only enforcement. SQL sources get the existing 6-layer validation pipeline. Non-SQL sources get source-type-specific validation (see Section 4).

**Current state:** `ConnectionRegistry` + `DBConnection` interface in `packages/api/src/lib/db/connection.ts`. Salesforce has a separate `SalesforceDataSource` interface in `packages/api/src/lib/db/salesforce.ts`. This split is intentional — SOQL is structurally different from SQL.

### 1.2 ActionTarget (write-back)

**What it is:** Systems the agent can write to, always gated by approval flows. Posting a Slack message, creating a JIRA ticket, sending an email, calling a webhook.

**Security posture:** Every action requires explicit user approval before execution. No ambient write access. Actions are logged to the audit trail with the full request payload.

**Not in scope until v0.9.** The current system is read-only by design. The action model is designed here so that the DataSource and credential abstractions are forward-compatible.

### 1.3 InteractionSurface (bidirectional)

**What it is:** Channels through which users reach Atlas and Atlas reaches back. Slack bot, email inbox, Teams bot, webhook listeners, the web UI itself.

**Security posture:** Signature verification on inbound (Slack signing secret, webhook HMAC). Rate limiting on outbound. Interaction surfaces do not hold user data — they are transport, not storage.

**Current state:** Slack integration exists (`packages/api/src/lib/slack/`). The design here generalizes it.

---

## 2. Unified Source Abstraction

### 2.1 Why Not One Interface?

SQL databases return `{ columns, rows }`. Salesforce returns the same shape via SOQL but with different query semantics (relationship queries, no JOINs). REST APIs return arbitrary JSON. GraphQL has its own query language. Forcing these into a single `query(sql)` interface would either:

- Require all sources to speak SQL (impractical for REST/GraphQL), or
- Make the interface so generic it's useless (`query(anything: string): unknown`)

Instead, each source type has a **type-specific query interface** and a **shared metadata interface**.

### 2.2 Source Interface Hierarchy

```typescript
// Shared across all source types
interface SourceMetadata {
  id: string;
  type: SourceType;
  displayName: string;
  description?: string;
  owner: SourceOwner;           // { kind: "operator" } | { kind: "user", userId: string }
  healthStatus: HealthStatus;
  lastHealthCheck?: Date;
  createdAt: Date;
}

type SourceType =
  | "postgres" | "mysql" | "clickhouse" | "snowflake" | "duckdb"   // SQL
  | "salesforce"                                                    // SOQL
  | "rest" | "graphql"                                              // API
  | "csv" | "parquet"                                               // File
  | "slack" | "email" | "teams" | "webhook";                       // Interaction

// Source capability flags — determine which tools the agent gets
interface SourceCapabilities {
  canQuery: boolean;           // DataSource: agent can read
  canWrite: boolean;           // ActionTarget: agent can write (with approval)
  canListen: boolean;          // InteractionSurface: agent receives events
  canRespond: boolean;         // InteractionSurface: agent can send back
  queryLanguage?: "sql" | "soql" | "graphql" | "rest" | "file";
}

// Base interface all source adapters implement
interface SourceAdapter<TConfig = unknown> {
  readonly type: SourceType;
  readonly capabilities: SourceCapabilities;

  // Lifecycle
  initialize(config: TConfig): Promise<void>;
  healthCheck(): Promise<HealthCheckResult>;
  close(): Promise<void>;

  // Metadata for the agent system prompt
  describe(): SourceDescription;

  // Tools this source contributes to the agent
  getTools(): AtlasTool[];

  // Semantic layer support (optional — only SQL/SOQL sources)
  profiler?(): Profiler;
}
```

### 2.3 SQL Source Adapter

SQL sources (Postgres, MySQL, ClickHouse, Snowflake, DuckDB) share the existing `DBConnection` interface. The adapter wraps it:

```typescript
interface SQLSourceAdapter extends SourceAdapter<SQLSourceConfig> {
  readonly capabilities: {
    canQuery: true;
    canWrite: false;
    canListen: false;
    canRespond: false;
    queryLanguage: "sql";
  };

  // Delegates to existing DBConnection.query()
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;

  // Contributes executeSQL tool, scoped to this source's connectionId
  getTools(): [AtlasTool]; // one tool: executeSQL with connectionId baked in
}

interface SQLSourceConfig {
  url: string;              // postgresql://, mysql://, etc.
  schema?: string;          // PostgreSQL search_path
  description?: string;
  poolSize?: number;        // Default 10
  idleTimeoutMs?: number;   // Default 30000
}
```

**This preserves the existing `ConnectionRegistry` and `DBConnection` interfaces.** The adapter is a thin wrapper that adds lifecycle management (health checks, eviction) and tool generation.

### 2.4 REST Source Adapter

REST sources model read-only access to JSON APIs. The operator defines endpoints and their response schemas in the semantic layer.

```typescript
interface RESTSourceAdapter extends SourceAdapter<RESTSourceConfig> {
  readonly capabilities: {
    canQuery: true;
    canWrite: false;
    canListen: false;
    canRespond: false;
    queryLanguage: "rest";
  };

  // Agent calls this via a generated tool
  fetch(endpoint: string, params?: Record<string, string>): Promise<QueryResult>;
  getTools(): AtlasTool[];
}

interface RESTSourceConfig {
  baseUrl: string;
  auth?: RESTAuthConfig;
  endpoints: RESTEndpointDefinition[];
  rateLimitRpm?: number;
  timeoutMs?: number;
}

type RESTAuthConfig =
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "header"; name: string; value: string }
  | { type: "oauth2"; clientId: string; clientSecret: string; tokenUrl: string };

interface RESTEndpointDefinition {
  name: string;              // e.g. "list_users"
  path: string;              // e.g. "/api/v1/users"
  method: "GET";             // Only GET for DataSources
  params?: ParamDefinition[];
  responseSchema: ResponseSchema;
  description: string;
}
```

**SSRF prevention:** The `baseUrl` is validated at registration time — private IP ranges (`10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `169.254.x`, `::1`, `fc00::/7`) and cloud metadata endpoints (`169.254.169.254`) are rejected. DNS resolution is checked at request time to prevent DNS rebinding.

### 2.5 File Source Adapter

CSV and Parquet files are loaded into DuckDB for SQL querying. The adapter manages the lifecycle of a temporary DuckDB instance.

```typescript
interface FileSourceAdapter extends SourceAdapter<FileSourceConfig> {
  readonly capabilities: {
    canQuery: true;
    canWrite: false;
    canListen: false;
    canRespond: false;
    queryLanguage: "sql"; // queries run against DuckDB
  };

  // Same as SQL — files are loaded into DuckDB as tables
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  getTools(): [AtlasTool];
}

interface FileSourceConfig {
  files: FileDefinition[];
  description?: string;
}

interface FileDefinition {
  path: string;              // Local path or URL
  format: "csv" | "parquet";
  tableName: string;         // Name in DuckDB
  schema?: ColumnDefinition[];
}
```

### 2.6 How the Agent Sees Sources

The agent does not interact with the `SourceAdapter` interface directly. Each adapter contributes tools to the `ToolRegistry` dynamically. The agent sees:

```
// Single SQL source (backward compat):
Tools: explore, executeSQL

// Multi-source (2 SQL + 1 Salesforce + 1 REST):
Tools: explore, executeSQL, querySalesforce, queryStripeAPI
       └── system prompt lists connectionId for each SQL source
```

The system prompt (built in `agent.ts:buildSystemPrompt`) already handles multi-source enumeration — `buildMultiSourceSection()` lists connection IDs, dialect guides, and cross-source join hints. The adapter model extends this by having each adapter contribute its own prompt section via `describe()`.

---

## 3. Connection Lifecycle

### 3.1 States

```
  ┌──────────┐    register()    ┌───────────┐    healthCheck()    ┌─────────┐
  │ Declared │ ──────────────► │Initializing│ ──────────────────►│ Healthy │◄──┐
  └──────────┘                 └───────────┘                     └────┬────┘   │
       ▲                            │                                 │        │
       │                       init failure                     health fails   │
       │                            ▼                                 ▼        │
       │                     ┌───────────┐                     ┌──────────┐    │
       │                     │  Failed   │                     │ Degraded │────┘
       │                     └───────────┘                     └──────────┘ auto-retry
       │                            │                                 │
       │                       max retries                      eviction
       │                            ▼                            timeout
       │                     ┌───────────┐                          │
       └─────────────────────│  Evicted  │◄─────────────────────────┘
          operator re-registers └──────────┘
```

### 3.2 Registration

Sources are registered through one of three surfaces (see Section 8):

1. **`atlas.config.ts`** — Operator defines sources in code. Loaded at startup via `loadConfig()` → `applyDatasources()`. This is the current path.
2. **Admin API** — `POST /api/v1/sources` (v0.9+). Credentials encrypted and stored in internal DB.
3. **Self-service UI** — End users register their own sources via the web UI (v1.0). Scoped to the user's tenant.

All three paths converge on `SourceRegistry.register()`, which validates the config, creates the adapter, runs an initial health check, and registers the source's tools with the `ToolRegistry`.

### 3.3 Health Checks

```typescript
interface HealthCheckResult {
  status: "healthy" | "degraded" | "unhealthy";
  latencyMs: number;
  message?: string;         // Human-readable status
  checkedAt: Date;
}
```

**Schedule:**
- On registration: immediate health check (failure = registration fails)
- Periodic: every 60s for SQL sources, every 120s for API sources, every 300s for file sources
- On query failure: immediate re-check before retry

**Degraded mode:** A source that fails health checks is marked `degraded`. The agent's system prompt notes the degradation ("Source 'warehouse' is currently unavailable — skip queries to it"). After 3 consecutive failures over 5 minutes, the source is marked `unhealthy` and its tools are removed from the registry.

**No silent degradation.** The agent is always told when a source is down. The user sees it in the health endpoint response.

### 3.4 Connection Pooling

SQL sources use connection pools (already implemented: `pg.Pool`, `mysql2.createPool`, ClickHouse HTTP client, Snowflake connection pool). The lifecycle layer adds:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxConnections` | `10` per source | Pool ceiling |
| `idleTimeoutMs` | `30_000` | Close idle connections after 30s |
| `maxTotalConnections` | `100` | Hard cap across all sources |
| `evictionCheckIntervalMs` | `60_000` | Scan for idle/unhealthy sources |

**LRU eviction:** When `maxTotalConnections` is reached, the least-recently-used source's pool is drained and the source enters `evicted` state. Eviction is transparent — re-querying the source re-initializes its pool. This prevents runaway connection counts in self-service mode (v1.0) where users may register many sources.

### 3.5 Graceful Shutdown

On `SIGTERM`/`SIGINT`, all source adapters are closed in parallel:

```typescript
async function shutdown(): Promise<void> {
  const sources = sourceRegistry.list();
  await Promise.allSettled(sources.map((s) => s.close()));
}
```

Each adapter's `close()` drains its pool and logs the shutdown. This is not a new pattern — `ConnectionRegistry._reset()` already does this for tests.

---

## 4. Credential Management

### 4.1 Threat Model

Credentials for external systems are the highest-value targets in Atlas. The threat model:

| Threat | Mitigation |
|--------|------------|
| Credential in logs | `SENSITIVE_PATTERNS` regex scrubs connection strings from all log output and error messages. Audit entries never log credentials |
| Credential in agent response | System prompt instructs agent to never expose connection details. `scrubError()` catches accidental leaks in SQL errors |
| Credential at rest (disk) | Config file credentials are process env vars or encrypted vault entries — never plaintext in `atlas.config.ts` |
| Credential at rest (DB) | Admin API-registered credentials are AES-256-GCM encrypted before storage (see 4.2) |
| Credential in memory | Credentials are loaded into adapter config objects and never serialized back. Memory dumps are an OS-level concern (not in scope) |
| Credential in transit | All external connections use TLS by default. `sslmode=require` for Postgres, `ssl=true` for MySQL, `https://` for REST/ClickHouse |
| SSRF via REST sources | Private IP/metadata endpoint blocklist + DNS rebinding prevention (see 4.3) |
| Operator vs. user credential scoping | Operator credentials are global. User credentials are scoped to the user's tenant (see Section 7) |

### 4.2 Credential Vault (Admin API Path)

When sources are registered via the Admin API (v0.9+), credentials are encrypted before storage in the internal database:

```typescript
interface CredentialVault {
  // Encrypt and store a credential. Returns a vault reference ID.
  store(sourceId: string, credential: CredentialPayload): Promise<string>;

  // Retrieve and decrypt a credential. Throws if not found or decryption fails.
  retrieve(sourceId: string): Promise<CredentialPayload>;

  // Delete a credential. Idempotent.
  delete(sourceId: string): Promise<void>;

  // Rotate the encryption key. Re-encrypts all stored credentials.
  rotateKey(newKey: Buffer): Promise<void>;
}

type CredentialPayload =
  | { type: "connection_string"; url: string }
  | { type: "bearer_token"; token: string }
  | { type: "oauth2"; clientId: string; clientSecret: string; refreshToken: string }
  | { type: "basic"; username: string; password: string }
  | { type: "api_key"; key: string; headerName?: string };
```

**Encryption:**
- Algorithm: AES-256-GCM (authenticated encryption)
- Key: derived from `ATLAS_CREDENTIAL_KEY` env var via HKDF (SHA-256, salt per credential)
- IV: 12 bytes, randomly generated per encryption operation
- Storage format: `iv || ciphertext || authTag` (binary, stored as `bytea` in Postgres)
- Key rotation: re-encrypts all credentials in a single transaction

**The vault is internal-DB-only.** Config-file credentials (`atlas.config.ts`) stay as env vars — the operator owns their own secret management (Vault, AWS Secrets Manager, etc.). The vault is for the Admin API path where Atlas itself must persist credentials.

### 4.3 SSRF Prevention

REST and GraphQL sources make outbound HTTP requests. Atlas must prevent operators (and especially self-service users in v1.0) from pointing these at internal infrastructure.

**Registration-time validation:**

```typescript
const BLOCKED_IP_RANGES = [
  /^127\./,                          // Loopback
  /^10\./,                           // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC 1918
  /^192\.168\./,                     // RFC 1918
  /^169\.254\./,                     // Link-local / cloud metadata
  /^0\./,                            // "This" network
  /^::1$/,                           // IPv6 loopback
  /^fc00:/i,                         // IPv6 ULA
  /^fe80:/i,                         // IPv6 link-local
];

const BLOCKED_HOSTNAMES = [
  "metadata.google.internal",
  "metadata.google.com",
];
```

**Request-time DNS check:** Before every outbound request, resolve the hostname and verify the resolved IP is not in a blocked range. This prevents DNS rebinding attacks where a hostname resolves to a public IP at registration time but a private IP at request time.

**Allowlist mode (optional):** Operators can set `ATLAS_ALLOWED_HOSTS` to restrict REST sources to specific hostnames. When set, only listed hosts are reachable.

### 4.4 Credential Rotation

**SQL sources:** Connection strings contain credentials. Rotation = register the source again with a new URL. The `ConnectionRegistry.register()` method already handles re-registration (closes the old pool, opens a new one).

**OAuth2 sources:** The adapter handles token refresh internally. The vault stores the `refreshToken`. When the access token expires, the adapter refreshes it and updates the vault. If the refresh token itself expires, the source enters `degraded` state and the operator is notified.

**API key sources:** Same as SQL — re-register with the new key.

---

## 5. Per-Source Security

### 5.1 Validation Pipeline by Source Type

Each source type has its own validation pipeline. The SQL pipeline (existing) is the reference implementation.

| Source Type | Validation Layers |
|-------------|-------------------|
| **SQL** (Postgres, MySQL, ClickHouse, Snowflake, DuckDB) | 0. Empty check → 1. Regex mutation guard → 2. AST parse (SELECT-only) → 3. Table whitelist → 4. Auto LIMIT → 5. Statement timeout |
| **SOQL** (Salesforce) | 0. Empty check → 1. Regex mutation guard (no DML keywords) → 2. SOQL structure validation (SELECT only, no DML verbs) → 3. Object whitelist (from entity YAMLs) → 4. SOQL LIMIT appended → 5. Request timeout |
| **REST** | 0. Method check (GET only for DataSources) → 1. URL path validation (must match defined endpoints) → 2. Parameter validation (types, required fields) → 3. Response size limit → 4. Request timeout |
| **GraphQL** | 0. Operation type check (query only, no mutation/subscription) → 1. Query depth limit (max 5 nested levels) → 2. Field whitelist (from schema definition) → 3. Response size limit → 4. Request timeout |
| **File** (CSV/Parquet) | Files loaded into DuckDB → DuckDB SQL validation pipeline applies. Additionally: file size limit, no file:// URLs (local path or HTTPS only), DuckDB filesystem functions blocked |

### 5.2 Per-Source Table Whitelist

The existing `semantic.ts:getWhitelistedTables()` already supports per-connection whitelists:

```
semantic/
  entities/           ← default connection tables
    users.yml
    orders.yml
  warehouse/          ← "warehouse" connection tables
    entities/
      events.yml
      sessions.yml
  salesforce/         ← "salesforce" connection objects
    entities/
      Account.yml
      Opportunity.yml
```

Each entity YAML can also declare its connection explicitly:

```yaml
table: events
connection: warehouse    # overrides directory-based inference
```

**No change needed** for the whitelist system. It already partitions by connection ID and supports both directory-based and field-based assignment.

### 5.3 Audit Trail

The existing `logQueryAudit()` records every SQL query with user context. Multi-source extends this:

```typescript
interface AuditEntry {
  // Existing fields
  sql: string;
  durationMs: number;
  rowCount: number | null;
  success: boolean;
  error?: string;

  // New fields for multi-source
  sourceId: string;          // Connection/source ID (e.g. "warehouse", "salesforce")
  sourceType: SourceType;    // "postgres", "salesforce", "rest", etc.
  host: string;              // Hostname of the target (scrubbed of credentials)
}
```

The `audit_log` table gets three new columns: `source_id`, `source_type`, `target_host`. Migration is handled by the existing boot-time migration system in `packages/api/src/lib/auth/migrate.ts`.

**Pino log entries** also get these fields. This enables log-based monitoring of per-source query patterns without requiring the internal DB.

### 5.4 Source-Scoped Rate Limiting

Beyond the existing per-user rate limit (`ATLAS_RATE_LIMIT_RPM`), each source can have its own rate limit to protect the downstream system:

```typescript
interface SourceRateLimit {
  queriesPerMinute: number;  // Max queries to this source per minute
  concurrency: number;       // Max concurrent queries to this source
}
```

Default: `queriesPerMinute: 60`, `concurrency: 5` for SQL sources. REST sources use the API's documented rate limits. Salesforce uses SOQL governor limits.

Rate limit state is per-process (in-memory). For multi-instance deployments, operators can use their database's built-in connection limits as the true enforcement layer.

---

## 6. Action Model (Write-Back)

> **Not implemented until v0.9.** This section defines the target architecture so that v0.7-v0.8 work is forward-compatible.

### 6.1 Action vs. DataSource

| Property | DataSource | ActionTarget |
|----------|-----------|--------------|
| Direction | Read | Write |
| Agent autonomy | Full — agent queries freely | None — agent proposes, user approves |
| Approval required | No | Always |
| Audit detail | Query text + result count | Full request payload + response |
| Rollback | N/A (read-only) | Action-specific (some irreversible) |

### 6.2 Approval Flow

```
Agent decides to take action (e.g. "post summary to #data-alerts")
    ↓
Agent calls tool with action payload
    ↓
Tool returns PENDING approval (action NOT executed)
    ↓
Chat UI renders approval card:
  ┌─────────────────────────────────────────┐
  │ 📤 Post to Slack: #data-alerts          │
  │                                         │
  │ "Weekly revenue summary: Total revenue  │
  │  was $1.2M, up 15% from last week..."   │
  │                                         │
  │ [Approve]  [Reject]  [Edit & Approve]   │
  └─────────────────────────────────────────┘
    ↓
User clicks Approve
    ↓
Frontend sends POST /api/v1/actions/:id/approve
    ↓
Action executes, result stored in audit log
    ↓
Agent receives confirmation, continues conversation
```

**Key properties:**
- **No ambient execution.** The tool call does not execute the action. It returns a pending action ID. The action only executes after explicit user approval.
- **Approval timeout.** Pending actions expire after 5 minutes. The agent can mention this in its response.
- **Edit & Approve.** The user can modify the action payload before approving (e.g., edit the Slack message text). The modified payload is what executes.

### 6.3 Action Tool Interface

```typescript
interface ActionTool {
  name: string;
  description: string;
  sourceId: string;          // Which ActionTarget this writes to
  parameters: z.ZodSchema;   // Action payload schema

  // Validate the payload without executing. Returns a preview.
  preview(payload: unknown): Promise<ActionPreview>;

  // Execute the action (only called after user approval).
  execute(payload: unknown): Promise<ActionResult>;
}

interface ActionPreview {
  summary: string;           // Human-readable summary for the approval card
  payload: unknown;          // The full payload (shown in "details" expansion)
  estimatedImpact?: string;  // "Will post 1 message to #data-alerts"
}

interface ActionResult {
  success: boolean;
  message: string;
  externalId?: string;       // e.g. Slack message timestamp, JIRA ticket key
}
```

### 6.4 Action Permissions

Actions are opt-in at the operator level. No action type is available unless explicitly configured:

```typescript
// atlas.config.ts
export default defineConfig({
  actions: {
    slack: {
      enabled: true,
      channels: ["#data-alerts", "#weekly-reports"], // allowlisted channels
      maxMessageLength: 4000,
    },
    jira: {
      enabled: true,
      projects: ["DATA", "ENG"],
      issueTypes: ["Task", "Bug"],
    },
    email: { enabled: false }, // explicitly disabled
  },
});
```

When no `actions` key is present, all actions are disabled (backward compat — Atlas remains read-only).

---

## 7. Multi-Tenancy and Self-Service

### 7.1 Two Modes

| Mode | Who configures sources | When |
|------|----------------------|------|
| **Operator-managed** | DevOps/data team via `atlas.config.ts` or Admin API | v0.7+ (current) |
| **Self-service** | End users via the web UI | v1.0 |

### 7.2 Operator-Managed (v0.7-v0.9)

Sources are global — visible to all authenticated users. This is the current model. The operator is trusted. Source configs live in `atlas.config.ts` (code) or the internal DB (Admin API).

**Access control** is coarse: either you can use Atlas or you can't. Per-source access control (user A sees `warehouse` but not `production`) is a v1.0 feature tied to the role/permission system.

### 7.3 Self-Service (v1.0)

Users register their own sources through the web UI. Self-service sources are **scoped to the user** — other users cannot see or query them.

```typescript
interface SourceOwner {
  kind: "operator" | "user";
  userId?: string;            // Set when kind === "user"
}
```

**Security implications of self-service:**

| Concern | Mitigation |
|---------|------------|
| User registers a source pointing at Atlas's internal DB | Blocked: `ATLAS_INTERNAL_DB_HOST` is added to SSRF blocklist |
| User registers 100 sources to exhaust connection pools | `maxTotalConnections` cap + per-user source limit (default 10) |
| User registers a malicious REST endpoint that returns huge payloads | Response size limit (default 10 MB) + request timeout (default 30s) |
| User A sees user B's source data | Source scoping: queries to user-owned sources require matching `userId` in the auth context |
| User registers a source and then deletes their account | Orphan cleanup: background job deletes sources owned by deleted users |
| SSRF via user-defined REST baseUrl | Full SSRF prevention suite (IP blocklist, DNS rebinding check, optional allowlist) |

**Source visibility rules:**

```
Operator sources:  visible to all authenticated users
User sources:      visible only to the owning user
Shared sources:    operator-created sources explicitly shared with a team (v1.1 — requires RBAC)
```

### 7.4 Per-Source Semantic Layer

Each source gets its own semantic layer partition:

```
semantic/
  entities/               ← operator default source
  warehouse/              ← operator "warehouse" source
    entities/
  user-abc123/            ← self-service source for user abc123
    entities/
```

For self-service sources, the semantic layer is auto-generated via `atlas init` running against the user's database. Users can edit their semantic layer through the UI (a YAML editor or structured form).

**Isolation:** The explore tool's path-traversal protection already scopes access to the `semantic/` directory. Self-service sources are subdirectories within it. The agent's `explore` tool is parameterized with the source's semantic root, preventing cross-source file access.

---

## 8. Configuration Surface Evolution

### 8.1 Three Surfaces

```
                    ┌─────────────────┐
                    │  atlas.config.ts │  Code-first (v0.7+)
                    │  + CLI           │  Operators, developers
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Admin API      │  API-first (v0.9+)
                    │  POST /sources  │  Operators, automation
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Admin Console  │  UI-first (v1.1+)
                    │  Web UI         │  Operators, end users
                    └─────────────────┘
```

### 8.2 `atlas.config.ts` (v0.7+)

Already implemented. The `defineConfig()` function in `packages/api/src/lib/config.ts` accepts a `datasources` map. This is extended with source-type-specific configs:

```typescript
export default defineConfig({
  datasources: {
    default: {
      url: process.env.ATLAS_DATASOURCE_URL!,
      description: "Production analytics database",
    },
    warehouse: {
      url: process.env.WAREHOUSE_URL!,
      schema: "analytics",
      description: "Snowflake data warehouse",
    },
    salesforce: {
      url: process.env.SALESFORCE_URL!,
      description: "Salesforce CRM",
    },
    stripe: {
      type: "rest",
      baseUrl: "https://api.stripe.com/v1",
      auth: { type: "bearer", token: process.env.STRIPE_API_KEY! },
      endpoints: [
        {
          name: "list_charges",
          path: "/charges",
          method: "GET",
          params: [{ name: "limit", type: "integer", default: 100 }],
          description: "List recent Stripe charges",
        },
      ],
      description: "Stripe payment data",
    },
  },
});
```

**Backward compat:** When `type` is omitted, the URL scheme determines the source type (existing behavior via `detectDBType()`). The `type` field is only needed for non-URL sources (REST, GraphQL, file).

### 8.3 Admin API (v0.9+)

```
POST   /api/v1/sources              Create a source (credentials encrypted via vault)
GET    /api/v1/sources              List sources (operator: all, user: own + operator)
GET    /api/v1/sources/:id          Get source details (no credentials in response)
PUT    /api/v1/sources/:id          Update source config
DELETE /api/v1/sources/:id          Delete source (closes pool, removes credentials)
POST   /api/v1/sources/:id/health   Trigger health check
POST   /api/v1/sources/:id/profile  Run atlas init against the source
```

**Authentication:** Admin API endpoints require `managed` or `byot` auth mode. Simple API key auth (`ATLAS_API_KEY`) is insufficient — these endpoints manage persistent state.

**No credentials in responses.** `GET /sources/:id` returns metadata, health status, and a masked credential hint (`postgresql://user:****@host:5432/db`) but never the actual credential.

### 8.4 Admin Console (v1.1+)

Out of scope for this document. See `docs/design/plugin-architecture.md` Section "v1.1+: Admin Console".

---

## 9. Phased Rollout

### Phase 1: v0.7 — Multi-Database SQL (Current Milestone)

**Goal:** Operators configure 2-10 SQL databases in `atlas.config.ts`. Agent queries the right one.

**What exists today:**
- `ConnectionRegistry` with named connections ✅
- `atlas.config.ts` with `datasources` map ✅
- Per-connection table whitelists in `semantic.ts` ✅
- Per-source semantic layer directories ✅
- Cross-source join hints in entity YAMLs ✅
- Multi-source system prompt with dialect guides ✅
- Salesforce adapter (SOQL) ✅
- DuckDB adapter (in-process) ✅
- Snowflake adapter ✅
- ClickHouse adapter ✅

**What's needed:**
- [ ] Source health checks (periodic, on-failure retry)
- [ ] Connection pool limits (`maxTotalConnections`)
- [ ] LRU eviction for idle connections
- [ ] Audit log columns: `source_id`, `source_type`, `target_host`
- [ ] Per-source rate limiting
- [ ] `atlas diff` support for multi-source (compare each source's schema against its semantic partition)

**No new adapters.** v0.7 is about making the existing multi-database support production-grade with health monitoring, pool management, and audit enrichment.

### Phase 2: v0.8 — Non-SQL DataSources

**Goal:** REST APIs and file-based sources join the query surface.

**Deliverables:**
- [ ] REST source adapter (`RESTSourceAdapter`)
- [ ] SSRF prevention (IP blocklist, DNS rebinding check)
- [ ] REST endpoint definition in semantic layer (YAML format)
- [ ] REST-specific validation pipeline (method check, path validation, param validation)
- [ ] File source adapter via DuckDB (`FileSourceAdapter`)
- [ ] `atlas init` for REST sources (schema inference from OpenAPI specs)
- [ ] GraphQL source adapter (stretch goal)

**Design constraint:** REST sources must integrate with the existing semantic layer. Each REST endpoint gets an entity YAML that describes its response schema. The agent reads these YAMLs the same way it reads SQL entity schemas — via the `explore` tool.

```yaml
# semantic/stripe/entities/charges.yml
table: charges                    # virtual table name for agent reference
type: rest_endpoint
connection: stripe
endpoint: list_charges
description: |
  Stripe charges. Each row is a payment attempt.
dimensions:
  id:
    type: text
    description: Charge ID (ch_xxx)
  amount:
    type: integer
    description: Amount in cents
  currency:
    type: text
    description: Three-letter ISO currency code
    sample_values: [usd, eur, gbp]
  status:
    type: text
    description: Charge status
    sample_values: [succeeded, pending, failed]
```

### Phase 3: v0.9 — ActionTargets + Admin API

**Goal:** The agent can write to external systems (Slack, JIRA, email) with approval flows. Sources can be registered via API.

**Deliverables:**
- [ ] Action tool framework (preview → approve → execute)
- [ ] Approval flow in chat UI (approval card component)
- [ ] Pending action store (internal DB table: `pending_actions`)
- [ ] Slack action adapter (post message to channel)
- [ ] Admin API for source management (`/api/v1/sources`)
- [ ] Credential vault (AES-256-GCM encryption in internal DB)
- [ ] Action configuration in `atlas.config.ts`
- [ ] Action audit logging (full payload + response)

### Phase 4: v1.0 — Self-Service + Plugin SDK

**Goal:** End users register their own databases. The plugin system is formalized.

**Deliverables:**
- [ ] Self-service source registration UI
- [ ] Per-user source scoping (visibility, query access)
- [ ] Per-user source limits (max sources, max total connections)
- [ ] Auto-profile on self-service registration (`atlas init` as a background job)
- [ ] `@useatlas/plugin-sdk` package (formalized adapter interfaces)
- [ ] Source-level RBAC (operator assigns per-source permissions to users/teams)
- [ ] Orphan source cleanup (background job)

---

## 10. Migration Path

### For Operators

**v0.6 → v0.7 (no breaking changes):**
- Single `ATLAS_DATASOURCE_URL` deployments work without modification
- `atlas.config.ts` is optional — env vars are the fallback
- New features (health checks, pool limits) have safe defaults

**v0.7 → v0.8 (additive only):**
- REST/file sources are new source types — existing SQL sources unaffected
- New `type` field in `datasources` config — omitting it preserves URL-based detection

**v0.8 → v0.9 (additive only):**
- Actions are opt-in — no `actions` config = fully read-only (current behavior)
- Admin API is additive — existing `atlas.config.ts` workflows unchanged
- Credential vault requires `ATLAS_CREDENTIAL_KEY` env var (only when using Admin API)

**v0.9 → v1.0 (additive only):**
- Self-service is opt-in — disabled by default
- Plugin SDK is the formalization of existing interfaces — no breaking changes

### For the Codebase

**Key invariants that MUST NOT break:**
1. Single-datasource deploys with `ATLAS_DATASOURCE_URL` work forever
2. `executeSQL` always goes through the 6-layer validation pipeline
3. No DML/DDL ever reaches any datasource
4. The agent never sees raw credentials
5. `explore` is always read-only and path-traversal protected
6. `atlas.config.ts` is always optional

---

## 11. Open Questions

These are explicitly deferred decisions. Each will be resolved when its phase begins.

1. **Cross-source joins at query time.** The agent currently handles cross-source by querying each source separately and combining in its narrative. Should Atlas support federated queries (e.g., DuckDB as a federation engine)? Decided: not in v0.7-v0.9. Evaluate for v1.0 based on user demand.

2. **Credential delegation.** Should self-service users bring their own API keys (the user's Stripe key, not Atlas's Stripe key)? This changes the trust model — Atlas is no longer the credential holder. Decided: design for it, implement in v1.0.

3. **Source discovery.** Should Atlas auto-discover tables/views when a new SQL source is registered (without running `atlas init`)? This reduces friction but may surface tables the operator didn't intend to expose. Decided: auto-discover with an opt-out flag, v0.8.

4. **Webhook-driven sources.** Some data arrives via push (webhook) rather than pull (query). Should Atlas support registering webhook listeners as DataSources? This is a different pattern — data is buffered and queryable rather than fetched on demand. Decided: v1.0 scope, requires internal storage for buffered events.

5. **Source-level prompt engineering.** Should operators be able to attach custom system prompt instructions per source (e.g., "always filter by tenant_id = :current_user_tenant")? This enables per-source access control without explicit RBAC. Decided: yes, v0.9, implemented as a `promptInstructions` field on the source config.

---

## Reference

- Plugin architecture: `docs/design/plugin-architecture.md`
- Current connection registry: `packages/api/src/lib/db/connection.ts`
- Current tool registry: `packages/api/src/lib/tools/registry.ts`
- SQL validation pipeline: `packages/api/src/lib/tools/sql.ts`
- Semantic layer (whitelist + cross-source joins): `packages/api/src/lib/semantic.ts`
- Audit logging: `packages/api/src/lib/auth/audit.ts`
- Agent system prompt: `packages/api/src/lib/agent.ts`
- Declarative config: `packages/api/src/lib/config.ts`
- Salesforce adapter: `packages/api/src/lib/db/salesforce.ts`
- Existing BYOD user guide: `docs/guides/bring-your-own-db.md`
- Explore tool backends: `packages/api/src/lib/tools/explore.ts`
- SSRF blocklist: (to be implemented in `packages/api/src/lib/security.ts`)
- Credential vault: (to be implemented in `packages/api/src/lib/vault.ts`)
