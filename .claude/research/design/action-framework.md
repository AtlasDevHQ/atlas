# Action Framework Design

> Design doc for Atlas v0.9 — Systems of Action. Write-back tools with a safety framework.
> Relates to: #44 (v0.9 milestone), sandbox-architecture-design.md (credential brokering), plugin-architecture-design.md (AtlasActionPlugin)

## Problem

Atlas v0.8 shipped Systems of Interaction — users can ask questions via web UI, JSON API, CLI, and Slack. Every interaction is **read-only**: the agent explores the semantic layer, writes validated SELECT queries, and interprets results. The agent cannot _do_ anything beyond answering questions.

v0.9 introduces **Systems of Action** — tools that have real-world side effects. The agent can send Slack notifications, create JIRA tickets, email reports, and update Salesforce records. This is fundamentally different from everything Atlas has done before:

| Property | Query tools (v0.1–v0.8) | Action tools (v0.9) |
|----------|------------------------|---------------------|
| Side effects | None (SELECT-only SQL, read-only explore) | Yes — sends messages, creates records, updates fields |
| Reversibility | Always safe (no state changes) | Varies — some reversible (delete Slack message), some not (email sent) |
| Approval needed | No (read-only is inherently safe) | Yes (every action needs explicit user consent) |
| Credential scope | Agent never sees DB connection string | Actions need service credentials (Slack token, JIRA API key, SMTP) |
| Blast radius | Data leakage at worst | Spam, data corruption, unauthorized communication at worst |

## Threat Model

### What goes wrong if actions fire without approval?

The core risk of action tools is **unauthorized real-world side effects**. Unlike SQL queries (which are SELECT-only and bounded by the table whitelist), actions modify external systems.

**Threat categories by action type:**

| Action | Unauthorized fire | Blast radius | Reversible? |
|--------|------------------|--------------|-------------|
| Slack notification | Spam to channels, leak sensitive query results to wrong audience | Medium — visible to channel members, may contain financial/PII data | Yes — delete message via `chat.delete` |
| JIRA ticket | Noise tickets, leaked analysis in ticket descriptions | Low — internal tool, tickets can be closed/deleted | Yes — close or delete ticket |
| Email report | Sensitive data emailed to wrong recipients, spam | **High** — email is permanent, may leave the organization | **No** — email cannot be recalled |
| Salesforce update | Incorrect field values on production CRM records | **High** — affects sales pipeline, revenue forecasting, customer data | Partial — revert to previous value if captured |

### How this differs from SQL

SQL validation has a clean security model: 4 layers of validation, SELECT-only enforcement, table whitelisting. The blast radius of a bad query is bounded — worst case is the agent reads data it shouldn't (mitigated by the whitelist) or runs a slow query (mitigated by timeouts and LIMIT).

Actions have no equivalent to "SELECT-only". Every action is a write. The security model must shift from **prevention** (block bad queries) to **approval** (confirm before executing).

### Prompt injection escalation

Prompt injection is already a risk for query tools (a crafted value in the database could influence the agent's SQL). But the blast radius is limited — the agent can only read whitelisted tables. With actions, a successful prompt injection could cause the agent to:

1. Send a Slack message to `#all-company` with fabricated analysis
2. Create JIRA tickets that look legitimate but contain misleading data
3. Email a report containing sensitive data to an external address
4. Update a Salesforce opportunity amount to an incorrect value

The approval framework is the primary defense. Even if the agent is manipulated into _requesting_ a harmful action, the user must explicitly approve it.

### Threat: Approval fatigue

If the agent requests many actions in a conversation, users may start approving reflexively ("just click approve to keep going"). Mitigations:

- **Auto-approve only for explicitly configured low-risk actions** — not by default
- **Action summaries must be clear and specific** — "Send message to #revenue: Q3 pipeline dropped 15%" not "Send Slack message"
- **Rate limiting per action type** — configurable via `rateLimit` in per-action config (default: no limit within `maxPerConversation`)
- **Global cap per conversation** — `maxPerConversation` (default 5) forces a re-confirmation after N actions in the same conversation
- **High-risk actions always require manual approval** — email and Salesforce updates default to `admin-only` (overridable with explicit escape hatch, see below)

### Threat: Idempotency failures

Slack's `chat.postMessage` and similar external APIs are not idempotent. If the harness executes the action, the external call succeeds, but the harness crashes before recording the result, a retry (manual or automated) could double-post. For v0.9, this is a **known limitation**:

- The `action_log` is written _after_ successful execution, not before
- On crash-before-record, the action appears as `pending` in the log even though it was executed externally
- Operators should check the external system (Slack channel, JIRA) before manually retrying
- v1.0 may introduce idempotency keys (pass a UUID to the external API where supported, e.g., JIRA's `Idempotency-Key` header)

## Approval Flow

### Non-blocking multi-turn protocol

The approval flow is **non-blocking**: the action tool returns `pending_approval` immediately, the current agent turn completes, and the approval resolves in a subsequent turn. This is critical because:

- `streamText` has per-step timeouts (30s default) — a blocking 2-minute wait would exceed them
- Vercel's `maxDuration` caps serverless functions at 60s — blocking is impossible there
- The chat stream should not hang while waiting for user input

**Multi-turn sequence:**

```
Turn 1: Agent analyzes data and requests an action
─────────────────────────────────────────────────
Agent Loop                    Harness                      Client (UI/Slack/CLI)
    │                           │                              │
    ├── tool call: ─────────────▶                              │
    │   sendSlackMessage({      │                              │
    │     channel: "#revenue",  │                              │
    │     text: "Q3 pipeline…" │                              │
    │   })                      │                              │
    │                           │                              │
    │   Tool validates params,  │                              │
    │   persists to action_log, │                              │
    │   returns immediately:    │                              │
    │                           │                              │
    │   { status:               ├── action_request ───────────▶│
    │     "pending_approval",   │   (data stream annotation    │  User sees:
    │     actionId: "act_abc",  │    or pendingActions in JSON) │  ┌─────────────────────┐
    │     summary: "Send to…" } │                              │  │ Atlas wants to send  │
    │                           │                              │  │ a Slack message to   │
    │   Agent receives result   │                              │  │ #revenue:            │
    │   and continues:          │                              │  │                      │
    │   "I've requested to send │                              │  │ "Q3 pipeline dropped │
    │    a notification. Once   │                              │  │  15% — details…"     │
    │    approved, the message  │                              │  │                      │
    │    will be posted."       │                              │  │ [Approve] [Deny]     │
    │                           │                              │  └─────────────────────┘
    │   Turn 1 ends normally    │                              │
    │   (stream closes)         │                              │


Turn 2: User approves (or denies), result injected into next turn
─────────────────────────────────────────────────────────────────
                                │                              │
                                │◀── POST /actions/:id/approve ┤  User clicks [Approve]
                                │                              │
                                ├── EXECUTE action ────────────▶│  (Slack API call)
                                │                              │
                                ├── Record result in           │
                                │   action_log                 │
                                │                              │
    New turn starts with        │                              │
    action result injected      │                              │
    as a system/tool message:   │                              │
    │                           │                              │
    │   { actionId: "act_abc",  │                              │
    │     status: "executed",   ├── action_result ────────────▶│
    │     result: { ts: "…" } } │                              │  User sees:
    │                           │                              │  ┌─────────────────────┐
    │   Agent incorporates:     │                              │  │ Slack message sent   │
    │   "The message was posted │                              │  │ to #revenue          │
    │    to #revenue."          │                              │  └─────────────────────┘
```

**Key properties of this model:**
- No step timeout issues — each turn completes normally
- Works on Vercel (60s limit) — no long-polling within a serverless function
- The agent loop doesn't need structural changes — `pending_approval` is just a tool result
- Approval state is tracked in `action_log`, not in-memory — survives server restarts
- The agent naturally handles the async flow ("I've requested X, waiting for approval")

### Approval as conversation state

Pending actions are tracked per-conversation in the `action_log` table. When a user approves or denies:

1. The approve/deny endpoint checks `status = 'pending'` with an atomic update (`UPDATE ... WHERE status = 'pending' RETURNING *`) to prevent double-approval race conditions. Returns 409 Conflict if already resolved.
2. On approval: the harness executes the action, records the result.
3. The result is injected into the next agent turn as a tool result message.
4. On denial: the denial is injected as a tool result so the agent can acknowledge it.

**When the conversation ends with pending actions:** Pending actions expire. They are not auto-denied or auto-executed — they simply remain in `pending` status in the `action_log`. A cleanup job (or TTL-based expiry) can mark them `timed_out` after the configured timeout window (default 2 minutes).

**When the agent loop hits the 25-step limit:** Same behavior — the loop terminates, any pending actions remain pending. The user can still approve/deny them via the API after the loop ends; the result just won't be fed back to the agent.

### Agent-side: Tool returns `pending_approval`

When an action tool is invoked, it does **not** execute immediately. Instead, it:

1. Validates the request parameters (channel exists, recipient is valid, etc.)
2. Builds a structured action request with a human-readable summary
3. Persists the pending action to `action_log`
4. Returns a `pending_approval` response to the agent immediately
5. The approval request is surfaced to the user via the active interaction surface

```typescript
// What an action tool returns
type ActionToolResult =
  | {
      status: "pending_approval";
      actionId: string;
      summary: string;        // Human-readable: "Send Slack message to #revenue"
      details: ActionDetails;  // Structured: { channel, text, blocks }
    }
  | {
      status: "executed";
      actionId: string;
      result: unknown;         // Action-specific result data
      rollback?: RollbackInfo; // How to undo this action
    }
  | {
      status: "denied";
      actionId: string;
      reason?: string;         // User's denial reason, if provided
    }
  | {
      status: "auto_approved";
      actionId: string;
      result: unknown;
      rollback?: RollbackInfo;
    };
```

### Harness-side: Approval dispatch

The harness (Hono API server) manages the approval lifecycle:

**On action tool invocation:**
1. Persists the pending action to the `action_log` table (or in-memory for no-DB deploys)
2. Surfaces the approval request to the client via the appropriate channel:
   - **Streaming chat (web UI)**: Custom data stream annotation in the AI SDK stream
   - **JSON query API**: Returns in the response with `pendingActions` array
   - **Slack bot**: Sends an ephemeral message with Block Kit buttons (Approve/Deny)
   - **CLI**: Prints action summary and prompts for y/n
3. Returns `pending_approval` to the agent — the tool call completes, the turn ends normally

**On user approval/denial (separate HTTP request or interaction):**
1. Atomically updates `action_log` status from `pending` → `approved` (returns 409 if already resolved)
2. On approval: executes the action, records the result, marks `executed` (or `failed`)
3. On denial: records the denial reason
4. Injects the result into the next agent turn

### Client-side: Approval UX by surface

**Web UI (chat stream):**
```
┌──────────────────────────────────────────────┐
│  Atlas wants to perform an action:            │
│                                               │
│  Send Slack message to #revenue               │
│                                               │
│  "Q3 pipeline analysis shows a 15% decline   │
│   in qualified opportunities. Top 3 factors:  │
│   1. Enterprise segment down 22%              │
│   2. Average deal size decreased $12K         │
│   3. Stage conversion rate dropped 8%"        │
│                                               │
│  [Approve]  [Deny]                            │
└──────────────────────────────────────────────┘
```

**Slack bot (ephemeral message):**
```
┌──────────────────────────────────────────────┐
│  Atlas wants to send a message to #revenue:   │
│                                               │
│  > Q3 pipeline analysis shows a 15% decline…  │
│                                               │
│  [Approve]  [Deny]                            │
└──────────────────────────────────────────────┘
```

**CLI (`atlas query`):**
```
Atlas wants to send a Slack message to #revenue:

  "Q3 pipeline analysis shows a 15% decline…"

Approve? [y/N]:
```

**JSON API (`POST /api/v1/query`):**

The JSON API uses a two-phase flow since it's synchronous:

Phase 1 — Initial query returns with pending actions:
```json
{
  "status": "pending_actions",
  "answer": "Based on my analysis, Q3 pipeline dropped 15%. I've requested to send this to #revenue.",
  "sql": "SELECT ...",
  "data": { "columns": [...], "rows": [...] },
  "steps": [...],
  "usage": { ... },
  "pendingActions": [
    {
      "id": "act_abc123",
      "action": "slack:notify",
      "summary": "Send Slack message to #revenue",
      "details": { "channel": "#revenue", "text": "…" },
      "reversible": true
    }
  ],
  "approveUrl": "/api/v1/actions/act_abc123/approve",
  "denyUrl": "/api/v1/actions/act_abc123/deny"
}
```

Phase 2 — Client calls approve/deny endpoint, gets action result:
```json
{
  "actionId": "act_abc123",
  "status": "executed",
  "result": { "ts": "1234.5678", "channel": "C0123" }
}
```

The JSON API response includes the full query answer alongside pending actions. The agent loop runs to completion normally — the `pending_approval` tool result is just part of the step history. The caller approves/denies via separate endpoints after receiving the response.

### Auto-approve configuration

Some actions can be configured for automatic approval to avoid unnecessary friction:

```typescript
// atlas.config.ts
export default defineConfig({
  actions: {
    "slack:notify": {
      enabled: true,
      approval: "auto",           // auto | manual | admin-only
      allowedChannels: ["#atlas-reports", "#data-alerts"],
    },
    "jira:create": {
      enabled: true,
      approval: "manual",         // analyst can self-approve
      project: "DATA",
    },
    "email:send": {
      enabled: true,
      approval: "admin-only",     // only admin role can approve
      allowedDomains: ["@company.com"],
    },
  },
});
```

**Auto-approve rules:**
- Auto-approve skips the user confirmation step — the action executes immediately after validation
- Only applies to actions explicitly configured with `approval: "auto"`
- Default is `"manual"` for all action types (safe by default)
- Email and Salesforce update default to `"admin-only"` — but this can be overridden in config (see escape hatch below)
- Auto-approved actions are still logged with `approved_by: "auto"` in the audit trail

**Escape hatch for high-risk auto-approve:**

Email and Salesforce update actions default to `"admin-only"` because they carry the highest blast radius. However, the framework does **not** hardcode this restriction. An operator who understands their environment (e.g., internal-only email, sandboxed Salesforce) can override it in `atlas.config.ts`:

```typescript
"email:send": {
  enabled: true,
  approval: "auto",  // Operator explicitly chose this
},
```

When a high-risk action is configured with `approval: "auto"`, the startup validator logs a prominent warning:

```
[atlas] WARNING: email:send configured for auto-approve. This action is irreversible —
        ensure you understand the risk. See: docs/design/action-framework.md#auto-approve-rules
```

This follows Atlas's general philosophy: safe defaults, explicit opt-in for advanced use, loud warnings for risky configurations. Hardcoding policy in framework code prevents legitimate use cases without improving security for anyone who would just fork the code to remove the check.

## Action Audit Log

### Extend or new table?

**Decision: New `action_log` table**, separate from `audit_log`.

Rationale:
- `audit_log` tracks SQL query executions — simple rows with `sql`, `duration_ms`, `row_count`
- Action log needs fundamentally different fields: `action_type`, `target`, `payload`, `approved_by`, `rollback_info`
- Combining them would require nullable columns for both schemas, making queries and indexing awkward
- Separate tables make it easy to query "all actions by user" or "all Slack notifications this week" without filtering out thousands of SQL audit rows
- Both tables share the same internal DB (`DATABASE_URL`) and the same fire-and-forget write pattern via `internalExecute`

### Schema

```sql
CREATE TABLE IF NOT EXISTS action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- When
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,          -- When approved/denied/timed out
  executed_at  TIMESTAMPTZ,          -- When the action was actually performed

  -- Who
  requested_by TEXT,                  -- user_id of the agent's user (from auth context)
  approved_by  TEXT,                  -- user_id of approver (may differ for admin approval)
  auth_mode    TEXT NOT NULL,

  -- What
  action_type  TEXT NOT NULL,         -- e.g. "slack:notify", "jira:create", "email:send"
  target       TEXT NOT NULL,         -- e.g. "#revenue", "DATA-1234", "alice@company.com"
  summary      TEXT NOT NULL,         -- Human-readable summary shown in approval UI
  payload      JSONB NOT NULL,        -- Full action parameters (channel, text, blocks, etc.)

  -- Outcome
  status       TEXT NOT NULL          -- "pending" | "approved" | "denied" | "executed" |
               DEFAULT 'pending',     --   "failed" | "timed_out" | "auto_approved"
  result       JSONB,                 -- Action-specific result (Slack ts, JIRA key, etc.)
  error        TEXT,                  -- Error message if execution failed
  rollback_info JSONB,               -- Enough context to undo the action

  -- Context
  conversation_id UUID,              -- Links to conversations table
  request_id      TEXT               -- Correlation ID for the HTTP request
);

CREATE INDEX IF NOT EXISTS idx_action_log_requested_by ON action_log(requested_by);
CREATE INDEX IF NOT EXISTS idx_action_log_status ON action_log(status);
CREATE INDEX IF NOT EXISTS idx_action_log_action_type ON action_log(action_type);
CREATE INDEX IF NOT EXISTS idx_action_log_conversation ON action_log(conversation_id);
```

### Lifecycle

```
requested_at          resolved_at         executed_at
     │                     │                    │
     ▼                     ▼                    ▼
  [pending] ──approve──▶ [approved] ──exec──▶ [executed]
     │                                          │
     ├──deny───────────▶ [denied]               ├──fail──▶ [failed]
     │                                          │
     └──timeout────────▶ [timed_out]            │
                                                │
  [auto_approved] ─────────────────────exec──▶ [executed]
```

### Concurrency and race conditions

The approve/deny endpoints use atomic status transitions to prevent double-execution:

```sql
-- Approve endpoint
UPDATE action_log
SET status = 'approved', approved_by = $1, resolved_at = now()
WHERE id = $2 AND status = 'pending'
RETURNING *;
-- If 0 rows affected → 409 Conflict (already resolved)
```

This prevents:
- Two browser tabs approving the same action (second gets 409)
- Approve racing with timeout expiry (whichever wins the atomic update takes effect)
- Approve after deny (or vice versa)

For the in-memory fallback (no `DATABASE_URL`), the same CAS logic uses a `Map<string, ActionLogEntry>` with a status check before mutation.

### Graceful degradation

Same pattern as `audit_log` — when `DATABASE_URL` is not set:
- Actions still log to pino (structured JSON)
- Approval state is held in-memory for the duration of the server process
- No persistent audit trail (acceptable for dev/single-user deploys)
- Log a warning at startup: "Action audit log requires DATABASE_URL for persistent tracking"

## Permission Model

### Roles

Atlas v0.5 shipped three auth modes (simple-key, managed, BYOT). v0.9 adds **role-based permissions** within managed auth using Better Auth's `organization()` plugin:

| Role | Query tools | Action: view log | Action: approve (manual) | Action: approve (admin-only) | Action: configure |
|------|------------|------------------|--------------------------|------------------------------|-------------------|
| **viewer** | Read-only (existing behavior) | Yes | No | No | No |
| **analyst** | Full query access | Yes | Yes (self-approve) | No | No |
| **admin** | Full query access | Yes | Yes | Yes | Yes |

### Auth mode mapping

| Auth mode | Role source | Default role |
|-----------|-------------|--------------|
| `none` | N/A — **actions are disabled** (hard error at startup if both `ATLAS_ACTIONS_ENABLED=true` and auth mode is `none`) | N/A |
| `simple-key` | Config: `ATLAS_API_KEY_ROLE` env var | `analyst` |
| `managed` | Better Auth user role (organization plugin) | `viewer` |
| `byot` | JWT claim: `atlas_role` or configurable claim path | `viewer` |

### `none` auth + actions = hard error

Actions require identity for approval audit trails. If `ATLAS_ACTIONS_ENABLED=true` is set with no auth mode configured (`none`), the server fails at startup with a clear error:

```
[atlas] FATAL: Actions require authentication. Set ATLAS_API_KEY, BETTER_AUTH_SECRET,
        or ATLAS_AUTH_JWKS_URL to enable an auth mode, or set ATLAS_ACTIONS_ENABLED=false.
```

This is enforced in `validateEnvironment()` during startup. Actions without identity would produce meaningless audit trails (`approved_by: null` for every action) and make the permission model vacuous.

### Permission checks

```typescript
function canApprove(
  user: AtlasUser | undefined,
  action: ActionRequest,
  config: ActionConfig,
): boolean {
  if (!user) return false;                           // "none" auth can't approve
  const role = getUserRole(user);                     // viewer | analyst | admin

  switch (config.approval) {
    case "auto":
      return true;                                    // Auto-approved, no human needed
    case "manual":
      return role === "analyst" || role === "admin";  // Self-approval OK
    case "admin-only":
      return role === "admin";                        // Only admins
  }
}
```

### Simple-key mode considerations

Simple-key mode has no user model — there's one API key for all users. In this mode:
- All actions default to `manual` approval (the key holder is implicitly an analyst)
- `admin-only` actions require setting `ATLAS_API_KEY_ROLE=admin`
- The audit log records `approved_by: "api-key"` (no individual identity)
- This is acceptable for single-user/CI deployments where the key holder is the operator

## Credential Brokering for Actions

### The problem

Action tools need service credentials:
- Slack notification → `SLACK_BOT_TOKEN`
- JIRA ticket → `JIRA_API_TOKEN` + `JIRA_BASE_URL`
- Email → SMTP credentials or SES/SendGrid API key
- Salesforce update → OAuth refresh token or API key

These credentials must **never** be visible to the agent or any generated code. The agent requests "send a Slack message to #revenue" — it never sees the bot token.

### Current pattern (correct)

Atlas already follows this pattern for database queries:
- The agent calls `executeSQL({ sql: "SELECT …" })` — it never sees `ATLAS_DATASOURCE_URL`
- The harness validates the SQL and executes it with the connection it manages
- The Slack bot from v0.8 also follows this pattern — `SLACK_BOT_TOKEN` is in the harness, the agent never touches it

### Action credential injection

Actions extend this pattern. Each action type has a credential resolver that reads from environment variables at execution time:

```
Agent                    Harness                     External Service
  │                        │                              │
  ├── sendSlackMessage ───▶│                              │
  │   { channel, text }    │                              │
  │                        │                              │
  │   (no token in args)   ├── resolve credential ────┐   │
  │                        │   SLACK_BOT_TOKEN        │   │
  │                        │◀─────────────────────────┘   │
  │                        │                              │
  │                        ├── POST chat.postMessage ────▶│
  │                        │   Authorization: Bearer …    │
  │                        │                              │
  │                        │◀── { ok: true, ts: "…" } ───┤
  │◀── { status: "executed"│                              │
  │     result: { ts } }   │                              │
```

### Configuration

Credentials are referenced by environment variable name in `atlas.config.ts`, never as raw values:

```typescript
// atlas.config.ts
export default defineConfig({
  actions: {
    "slack:notify": {
      enabled: true,
      // Credential reference — the framework reads the env var at execution time
      // The value never appears in config files, logs, or agent context
      credentials: {
        botToken: { env: "SLACK_BOT_TOKEN" },
      },
    },
    "jira:create": {
      enabled: true,
      credentials: {
        apiToken: { env: "JIRA_API_TOKEN" },
        baseUrl: { env: "JIRA_BASE_URL" },
        email: { env: "JIRA_EMAIL" },
      },
    },
    "email:send": {
      enabled: true,
      credentials: {
        // SMTP or API-based — provider-specific
        provider: { env: "ATLAS_EMAIL_PROVIDER" },   // "smtp" | "sendgrid" | "ses"
        apiKey: { env: "ATLAS_EMAIL_API_KEY" },
      },
    },
  },
});
```

### Ties to sandbox architecture

From `sandbox-architecture-design.md`: the credential proxy pattern applies when code runs in a sandbox. Action tools run in the **harness** (not in a sandbox), so they have direct access to environment variables. The credential brokering pattern here is simpler — it's the same pattern as `getDB()` reading `ATLAS_DATASOURCE_URL`:

1. Agent invokes the tool with **parameters only** (channel, text, recipient)
2. Harness resolves credentials from env vars
3. Harness makes the authenticated API call
4. Result returned to agent (without credentials)

If a future action needs to run code in a sandbox (e.g., a custom action that generates a chart via Python before emailing it), the sandbox credential proxy from the sandbox architecture doc applies. But the first four action types (Slack, JIRA, email, Salesforce) all execute in the harness.

## Tool Design

### How action tools differ from query tools

| Property | Query tools | Action tools |
|----------|------------|--------------|
| Execution model | Immediate — tool executes and returns result | Non-blocking — tool returns `pending_approval`, approval resolves in a subsequent turn |
| Agent loop interaction | Synchronous within a step | Tool call completes immediately; result arrives in a later turn after user approval |
| Return type | `{ columns, rows }` or `{ sql, csv, narrative }` | `ActionToolResult` (pending/executed/denied/auto_approved) |
| Tool metadata | Description for system prompt | Description + action metadata (approval mode, reversibility, credentials) |
| Registration | `ToolRegistry.register()` | `ToolRegistry.register()` with `AtlasAction` (extends `AtlasTool`) |

### AtlasAction (extends AtlasTool)

Action tools extend the existing `AtlasTool` interface with action-specific metadata. There is **one registry**, not two — this keeps tool lookup in a single place and avoids sync issues between parallel registries.

```typescript
interface AtlasAction extends AtlasTool {
  /** Action type identifier, e.g. "slack:notify" */
  readonly actionType: string;

  /** Whether this action's effects can be undone */
  readonly reversible: boolean;

  /** Default approval mode (overridable via atlas.config.ts) */
  readonly defaultApproval: "auto" | "manual" | "admin-only";

  /** Credential requirements — checked at startup */
  readonly requiredCredentials: readonly string[];
}

/** Type guard: is this tool an action? */
function isAction(tool: AtlasTool): tool is AtlasAction {
  return "actionType" in tool;
}
```

The `ToolRegistry` stores both query tools and action tools. The `AtlasAction` fields are only present on action entries. Code that needs action metadata uses the `isAction()` type guard:

```typescript
class ToolRegistry {
  // ... existing methods unchanged ...

  /** Return all registered action tools. */
  getActions(): AtlasAction[] {
    return Array.from(this.tools.values()).filter(isAction);
  }

  /** Check that all action tools have their required credentials. */
  validateActionCredentials(): { action: string; missing: string[] }[] {
    const issues: { action: string; missing: string[] }[] = [];
    for (const action of this.getActions()) {
      const missing = action.requiredCredentials.filter(
        (envVar) => !process.env[envVar]
      );
      if (missing.length > 0) {
        issues.push({ action: action.actionType, missing });
      }
    }
    return issues;
  }
}
```

**Why one registry, not two:** The original design proposed a separate `ActionRegistry` as a parallel metadata store alongside `ToolRegistry`. This creates two maps that must stay in sync, two lookup paths depending on context, and a constructor dependency. A single registry with a type guard is simpler, keeps action metadata co-located with the tool definition, and avoids an entire class of consistency bugs.

### Agent system prompt additions

When action tools are registered, the system prompt includes guidance on how to use them:

```
### 5. Take Actions (when appropriate)
You have action tools that can DO things beyond answering questions:
- sendSlackMessage — Send a message to a Slack channel
- createJiraTicket — Create a JIRA issue

IMPORTANT RULES FOR ACTIONS:
- Actions have real-world side effects. Be deliberate.
- Always explain WHAT you want to do and WHY before invoking an action tool.
- The user will be asked to approve each action before it executes.
- If the user denies an action, acknowledge it and continue with your analysis.
- Never invoke the same action twice in one conversation without the user asking.
- Include enough context in the action for it to be useful standalone
  (the Slack message should make sense without reading the full conversation).
```

### Agent loop: no structural changes needed

The current agent loop (`streamText` with `stopWhen`) requires **no changes** for action support. Action tools are registered like any other tool — the AI SDK invokes them, they return a result. The `pending_approval` result is just a tool return value that the agent incorporates into its reasoning.

```typescript
// Sketch: Action tool execute function (non-blocking)
const sendSlackMessage = tool({
  description: "Send a message to a Slack channel. Requires user approval.",
  parameters: z.object({
    channel: z.string().describe("Slack channel name (e.g. #revenue)"),
    text: z.string().describe("Message text"),
  }),
  execute: async ({ channel, text }) => {
    // 1. Validate parameters
    if (!channel.startsWith("#")) {
      return { status: "error", error: "Channel must start with #" };
    }

    // 2. Build action request
    const actionRequest: ActionRequest = {
      id: crypto.randomUUID(),
      actionType: "slack:notify",
      target: channel,
      summary: `Send Slack message to ${channel}`,
      payload: { channel, text },
      reversible: true,
    };

    // 3. Check auto-approve
    const config = getActionConfig("slack:notify");
    if (config.approval === "auto" && isAutoApproveAllowed(actionRequest, config)) {
      const result = await executeSlackNotify(actionRequest);
      logAction({ ...actionRequest, status: "auto_approved", result });
      return { status: "auto_approved", actionId: actionRequest.id, result };
    }

    // 4. Persist pending action and return immediately (non-blocking)
    await persistPendingAction(actionRequest);
    return {
      status: "pending_approval",
      actionId: actionRequest.id,
      summary: actionRequest.summary,
      details: actionRequest.payload,
    };
    // The agent receives this result and continues reasoning.
    // Approval happens in a subsequent turn via POST /actions/:id/approve.
  },
});
```

### Approval transport: Data stream annotations

For the streaming chat UI, approval requests are sent as custom data stream parts using the AI SDK's annotation pattern:

```typescript
// In the streaming response, the harness injects:
{
  type: "action_request",
  data: {
    id: "act_abc123",
    actionType: "slack:notify",
    summary: "Send Slack message to #revenue",
    target: "#revenue",
    details: { channel: "#revenue", text: "Q3 pipeline…" },
    reversible: true,
  }
}

// The client sends approval via a separate HTTP request:
// POST /api/v1/actions/act_abc123/approve
// POST /api/v1/actions/act_abc123/deny
```

## First Action: Slack Notification

### Why Slack first

The Slack bot from v0.8 already sends messages — `packages/api/src/lib/slack/api.ts` has `postMessage()` and `updateMessage()`. The infrastructure exists. Wrapping it in the approval framework is the smallest possible action implementation.

### Tool definition

```typescript
// packages/api/src/lib/tools/actions/slack-notify.ts

const SLACK_NOTIFY_DESCRIPTION = `### 5a. Send Slack Notification
Use the sendSlackMessage tool to share analysis results with a Slack channel:
- Provide the channel name (e.g. #revenue, #data-alerts)
- Include a clear, self-contained message that makes sense without conversation context
- The user will be asked to approve before the message is sent
- You can suggest sending a notification after completing an analysis, but don't insist`;

const sendSlackMessage: AtlasAction = {
  name: "sendSlackMessage",
  actionType: "slack:notify",
  description: SLACK_NOTIFY_DESCRIPTION,
  reversible: true,
  defaultApproval: "manual",
  requiredCredentials: ["SLACK_BOT_TOKEN"],

  tool: tool({
    description: "Send a message to a Slack channel. Requires user approval.",
    parameters: z.object({
      channel: z.string().describe("Slack channel name (e.g. #revenue)"),
      text: z.string().describe("Plain text message"),
    }),
    execute: async ({ channel, text }) => {
      // Validate channel format
      if (!channel.startsWith("#")) {
        return { status: "error", error: "Channel must start with #" };
      }

      // Build action request
      const request = buildActionRequest({
        actionType: "slack:notify",
        target: channel,
        summary: `Send Slack message to ${channel}`,
        payload: { channel, text },
      });

      // Check auto-approve, otherwise persist and return pending
      return handleAction(request, async () => {
        const token = process.env.SLACK_BOT_TOKEN;
        if (!token) throw new Error("SLACK_BOT_TOKEN not configured");

        const result = await postMessage(token, {
          channel: channel.replace(/^#/, ""),
          text,
        });

        if (!result.ok) {
          throw new Error(`Slack API error: ${result.error}`);
        }

        return {
          result: { ts: result.ts, channel: result.channel },
          rollback: {
            method: "slack:delete",
            params: { channel: result.channel, ts: result.ts },
          },
        };
      });
    },
  }),
};
```

### Credential flow

```
Agent: sendSlackMessage({ channel: "#revenue", text: "Q3 pipeline…" })
  │
  ▼
Action framework: Check approval config for "slack:notify"
  │
  ├── If auto → execute immediately, return auto_approved
  ├── If manual → persist pending action, return pending_approval
  └── If admin-only → persist pending action, return pending_approval (role checked on approve)
  │
  ▼ (on subsequent approval)
Harness: Read SLACK_BOT_TOKEN from environment
  │
  ▼
postMessage(token, { channel: "revenue", text: "Q3 pipeline…" })
  │
  ▼
Result injected into next agent turn: { status: "executed", result: { ts: "1234.5678", channel: "C0123" } }
```

### Reusing v0.8 Slack infrastructure

The v0.8 Slack bot already has:
- `slackAPI()` — generic Slack Web API caller (`packages/api/src/lib/slack/api.ts`)
- `postMessage()` — channel message posting
- `updateMessage()` — message editing (for rollback/update)
- Token storage — `slack_installations` table for multi-workspace OAuth
- Signature verification — `packages/api/src/lib/slack/verify.ts`

The Slack notify action reuses `postMessage()` directly. For multi-workspace deployments (OAuth flow), the token resolver checks `slack_installations` by team ID instead of reading a single env var.

## Rollback

### Design principle

Every action records enough rollback metadata to undo itself. The framework doesn't auto-rollback — it provides the information and a manual undo API. Auto-rollback on error (e.g., Slack API returns success but the message was malformed) is out of scope for v0.9.

### Per-action rollback

| Action | Rollback method | Stored metadata | Limitations |
|--------|----------------|-----------------|-------------|
| **Slack notification** | `chat.delete` (or `chat.update` to redact) | `{ channel, ts }` | Can't delete messages older than ~24h in some workspace configs |
| **JIRA ticket** | Transition to "Closed" + add comment | `{ issueKey, issueId }` | Doesn't delete — marks as closed. Watchers already notified |
| **Email report** | Cannot undo | `{ to, messageId }` | Email is permanent once sent. Rollback info is for audit only |
| **Salesforce update** (future) | Revert field to previous value | `{ objectId, field, previousValue }` | Requires capturing pre-update value before writing |

### Rollback API

```
POST /api/v1/actions/:actionId/rollback
Authorization: Bearer <token>

Response (success):
{
  "status": "rolled_back",
  "actionId": "act_abc123",
  "rollbackResult": { "deleted": true }
}

Response (not reversible):
{
  "status": "not_reversible",
  "actionId": "act_abc123",
  "reason": "Email actions cannot be undone"
}
```

### Rollback permissions

Only the user who approved the action or an admin can trigger rollback. This prevents a viewer from undoing an analyst's approved action.

## Configuration

### `atlas.config.ts` action settings

```typescript
import { defineConfig } from "@atlas/api/lib/config";

export default defineConfig({
  // ... existing datasources, tools, auth config ...

  actions: {
    // Global settings
    defaults: {
      approval: "manual",         // Default approval mode for all actions
      timeout: 120_000,           // 2 min approval timeout (ms)
      maxPerConversation: 5,      // Max actions per conversation (anti-fatigue)
    },

    // Per-action configuration
    "slack:notify": {
      enabled: true,
      approval: "auto",
      credentials: {
        botToken: { env: "SLACK_BOT_TOKEN" },
      },
      // Action-specific constraints
      allowedChannels: ["#atlas-reports", "#data-alerts"],
      rateLimit: 10,              // Max 10 Slack messages per conversation
    },

    "jira:create": {
      enabled: true,
      approval: "manual",
      credentials: {
        apiToken: { env: "JIRA_API_TOKEN" },
        baseUrl: { env: "JIRA_BASE_URL" },
        email: { env: "JIRA_EMAIL" },
      },
      project: "DATA",
      defaultLabels: ["atlas-generated"],
      rateLimit: 3,               // Max 3 JIRA tickets per conversation
    },

    "email:send": {
      enabled: true,
      approval: "admin-only",     // Default for email — overridable
      credentials: {
        provider: { env: "ATLAS_EMAIL_PROVIDER" },
        apiKey: { env: "ATLAS_EMAIL_API_KEY" },
      },
      allowedDomains: ["@company.com"],
      fromAddress: "atlas@company.com",
    },
  },
});
```

Note: Salesforce update actions are **not part of v0.9 scope**. They will be designed and implemented separately (v0.9.1 or v1.0) once the Salesforce write API complexity is better understood. The read path shipped in v0.7 validates the connection; write-back needs its own design spike.

### Environment variable fallback

When no `atlas.config.ts` is present, actions are configured purely via environment variables (same pattern as datasources):

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_ACTIONS_ENABLED` | `false` | Master switch for the action framework |
| `ATLAS_ACTION_APPROVAL` | `manual` | Default approval mode (auto/manual/admin-only) |
| `ATLAS_ACTION_TIMEOUT` | `120000` | Approval timeout in ms |
| `ATLAS_ACTION_MAX_PER_CONVERSATION` | `5` | Max actions per conversation |
| `SLACK_BOT_TOKEN` | — | Enables `slack:notify` action when set |
| `JIRA_API_TOKEN` | — | Enables `jira:create` action when set |
| `JIRA_BASE_URL` | — | JIRA instance URL |
| `JIRA_EMAIL` | — | JIRA account email |
| `ATLAS_EMAIL_PROVIDER` | — | Enables `email:send` when set (smtp/sendgrid/ses) |
| `ATLAS_EMAIL_API_KEY` | — | Email service API key |

### Startup validation

At server boot, the action framework:
1. Reads action config from `atlas.config.ts` or env vars
2. **Rejects `ATLAS_ACTIONS_ENABLED=true` with `none` auth mode** — hard error (see Permission Model)
3. Validates that enabled actions have all required credentials
4. Logs a clear diagnostic for each action: "slack:notify: enabled (auto-approve)" or "jira:create: disabled (JIRA_API_TOKEN not set)"
5. **Warns if high-risk actions (email) are set to auto-approve**
6. Registers enabled action tools into the ToolRegistry
7. Adds action guidance to the agent system prompt only when actions are enabled

## Observability

### Metrics (v0.9)

Action execution should emit structured pino logs sufficient for dashboarding. Each action lifecycle event logs:

```json
{
  "level": "info",
  "msg": "action executed",
  "actionType": "slack:notify",
  "actionId": "act_abc123",
  "status": "executed",
  "approvalMode": "manual",
  "approvalLatencyMs": 8500,
  "executionLatencyMs": 340,
  "conversationId": "conv_xyz"
}
```

Key fields for dashboards:
- `actionType` — breakdown by action type
- `status` — approval rate (executed vs denied vs timed_out)
- `approvalLatencyMs` — time from request to approval/denial
- `executionLatencyMs` — time for the external API call
- `approvalMode` — auto vs manual vs admin-only

### Alerting (deferred to v1.0)

Out of scope for v0.9, but the audit log and structured logs make it straightforward to add:
- Alert on N failed actions in M minutes (broken credentials, API outages)
- Alert on high denial rate (possible prompt injection or misconfigured agent)
- Alert on approaching `maxPerConversation` limits (agent generating too many action requests)

## Implementation Phases

### Phase 1: Action framework core + audit log

**PR scope:** The approval protocol, action audit log, and action configuration — no specific action implementations yet.

- `action_log` table in `migrateInternalDB()`
- `AtlasAction` interface extending `AtlasTool` in the existing `ToolRegistry`
- `isAction()` type guard, `getActions()`, `validateActionCredentials()` on `ToolRegistry`
- `ActionRequest` / `ActionToolResult` types
- `handleAction()` framework function (approval check, persist pending, execution, logging)
- `logActionAudit()` (pino + DB, same pattern as `logQueryAudit`)
- Atomic approve/deny with CAS (`UPDATE ... WHERE status = 'pending'`)
- Action config schema in `atlas.config.ts` (Zod validation)
- Startup validation for action credentials + `none` auth rejection
- Unit tests for approval logic, permission checks, config validation, race conditions

**Value:** The framework is in place. No user-visible actions yet, but the foundation is tested and reviewed.

### Phase 2: Slack notification action + web UI approval

**PR scope:** First concrete action — Slack notification with approval flow in the chat UI.

- `sendSlackMessage` action tool implementation
- Reuses `postMessage()` from `packages/api/src/lib/slack/api.ts`
- Approval request as data stream annotation in the chat stream
- Web UI component: action approval card (Approve/Deny buttons)
- `POST /api/v1/actions/:id/approve` and `/deny` endpoints (with 409 on double-approve)
- Rollback endpoint: `POST /api/v1/actions/:id/rollback` (calls `chat.delete`)
- Action result injection into the next agent turn
- Integration test: agent requests Slack notification → user approves → message sent → audit logged

**Value:** End-to-end action flow working in the most common surface (web UI).

### Phase 3: Approval flow for CLI + JSON API + Slack bot

**PR scope:** Extend approval to all interaction surfaces from v0.8.

- CLI (`atlas query`): Terminal prompt for approve/deny
- JSON API (`POST /api/v1/query`): Two-phase response — `pendingActions` in response, separate approve/deny endpoints
- Slack bot: Ephemeral approval message with Block Kit buttons, `action_endpoint` handler
- Tests for each surface's approval flow

**Value:** Actions work everywhere Atlas is accessible, not just the web UI.

### Phase 4: JIRA + email actions, role-based permissions

**PR scope:** Two more action types + the permission model.

- `createJiraTicket` action tool (JIRA REST API v3)
- `sendEmailReport` action tool (SMTP or SendGrid/SES abstraction)
- Better Auth `organization()` plugin integration for roles (viewer/analyst/admin)
- Role-based approval checks (`canApprove()`)
- `ATLAS_API_KEY_ROLE` for simple-key mode
- BYOT JWT role claim extraction
- Permission tests across all auth modes

**Value:** Full v0.9 scope complete. Salesforce update deferred to v0.9.1 or v1.0 (depends on demand and the Salesforce write API complexity).

## Issue Breakdown

### Proposed child issues for #44

**Issue 1: Action framework core — types, registry, audit log, config**
> Labels: `v0.9`, `backend`, `security`
>
> Build the foundational action framework:
> - `ActionRequest`, `ActionToolResult`, `AtlasAction` types in `@atlas/shared`
> - `AtlasAction` extends `AtlasTool` in existing `ToolRegistry` (no separate registry)
> - `isAction()` type guard, `getActions()`, `validateActionCredentials()` on `ToolRegistry`
> - `action_log` table in `migrateInternalDB()`
> - `logActionAudit()` function (mirrors `logQueryAudit()` pattern)
> - `handleAction()` framework function — persist pending, approval check, execution, audit logging
> - Atomic approve/deny endpoints with CAS (`UPDATE ... WHERE status = 'pending'`, 409 on conflict)
> - Action config schema in `packages/api/src/lib/config.ts` (Zod)
> - Startup validation: check enabled actions have credentials, reject `none` auth + actions, warn on high-risk auto-approve
> - `ATLAS_ACTIONS_ENABLED` master switch
>
> Acceptance criteria:
> - [ ] `AtlasAction` extends `AtlasTool`, registered in the existing `ToolRegistry`
> - [ ] `action_log` table created by migration, fire-and-forget writes work
> - [ ] `handleAction()` returns correct status for auto/manual/admin-only approval modes
> - [ ] Approve endpoint returns 409 Conflict on double-approve (race condition safe)
> - [ ] `none` auth + `ATLAS_ACTIONS_ENABLED=true` → hard startup error
> - [ ] Config validation rejects invalid action configs with clear error messages
> - [ ] Unit tests for registry, audit, approval logic, config validation, concurrency

**Issue 2: Slack notification action + web UI approval UX**
> Labels: `v0.9`, `backend`, `frontend`, `action`
>
> First end-to-end action: agent sends Slack messages with user approval.
> - `sendSlackMessage` tool in `packages/api/src/lib/tools/actions/slack-notify.ts`
> - Reuses `postMessage()` from `packages/api/src/lib/slack/api.ts`
> - Non-blocking: tool returns `pending_approval`, approval resolves in next turn
> - Approval request as data stream annotation in AI SDK stream
> - Web UI: `ActionApprovalCard` component with Approve/Deny buttons
> - `POST /api/v1/actions/:id/approve` and `POST /api/v1/actions/:id/deny` Hono routes
> - Action result injection into next agent turn after approval
> - Rollback: `POST /api/v1/actions/:id/rollback` → `chat.delete`
>
> Acceptance criteria:
> - [ ] Agent can invoke `sendSlackMessage` tool in conversation
> - [ ] Tool returns `pending_approval` immediately (non-blocking)
> - [ ] Chat UI shows approval card with action summary and details
> - [ ] Approve → message posted to Slack channel, result shown in next turn
> - [ ] Deny → agent acknowledges and continues in next turn
> - [ ] Rollback endpoint deletes the Slack message
> - [ ] Full action lifecycle logged in `action_log`

**Issue 3: Multi-surface approval (CLI, JSON API, Slack bot)**
> Labels: `v0.9`, `backend`, `api`
>
> Extend action approval to all v0.8 interaction surfaces:
> - CLI: `inquirer` or `@clack/prompts` approve/deny prompt during `atlas query`
> - JSON API: Two-phase response — `pendingActions` array in `/api/v1/query` response alongside query answer, separate approve/deny endpoints
> - Slack bot: Ephemeral message with Block Kit approve/deny buttons, action endpoint handler
>
> Acceptance criteria:
> - [ ] `atlas query` pauses for approval on action request, respects `--auto-approve` flag
> - [ ] JSON API returns `pendingActions` with approve/deny URLs alongside query results
> - [ ] Slack bot shows ephemeral approval message, button clicks resolve the action
> - [ ] All surfaces use the same `handleAction()` framework underneath

**Issue 4: JIRA + email actions**
> Labels: `v0.9`, `backend`, `action`
>
> Two additional action types:
> - `createJiraTicket` — JIRA REST API v3, project/labels from config, issue key in result
> - `sendEmailReport` — abstraction over SMTP / SendGrid / SES, HTML formatted report
> - Credential config for both in `atlas.config.ts`
> - Rollback: JIRA → close ticket, email → not reversible (logged)
>
> Acceptance criteria:
> - [ ] JIRA ticket created with correct project, summary, description, labels
> - [ ] Email sent with formatted analysis report
> - [ ] Both actions respect approval flow and log to `action_log`
> - [ ] Config validation checks for required credentials at startup

**Issue 5: Role-based action permissions (Better Auth organization plugin)**
> Labels: `v0.9`, `backend`, `security`, `auth`
>
> Add role-based permissions for action approval:
> - Integrate Better Auth `organization()` plugin with viewer/analyst/admin roles
> - `canApprove()` function checks user role against action approval config
> - `ATLAS_API_KEY_ROLE` env var for simple-key mode
> - BYOT JWT role claim extraction (configurable claim path)
> - Admin-only actions blocked for non-admin users
>
> Acceptance criteria:
> - [ ] Viewer cannot approve any actions
> - [ ] Analyst can approve `manual` actions, blocked from `admin-only`
> - [ ] Admin can approve all actions
> - [ ] Simple-key mode defaults to analyst, overridable via env var
> - [ ] BYOT extracts role from JWT claim
> - [ ] Tests cover all auth mode × role × approval mode combinations

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Separate `action_log` table, not extending `audit_log` | Different schemas (SQL audit has duration_ms/row_count, action audit has approval/rollback). Separate tables enable clean queries and indexing for each concern |
| Approval is mandatory by default (`manual`) | Actions have real-world side effects. Defaulting to auto-approve would be a security anti-pattern. Users must opt in to auto-approve per action type |
| High-risk actions (email, Salesforce) default to `admin-only` but are overridable | Safe defaults with explicit opt-in. Hardcoded restrictions in framework code prevent legitimate use cases (internal-only email, sandboxed Salesforce) without improving security for anyone who'd fork to remove the check. Loud startup warnings on override |
| Non-blocking approval (multi-turn, not blocking within a step) | Blocking would hold the `streamText` step open for minutes, exceeding step timeouts (30s) and Vercel's maxDuration (60s). Non-blocking: tool returns `pending_approval` immediately, approval resolves in a subsequent turn. Works naturally with the AI SDK's multi-step loop |
| Atomic CAS on approve/deny endpoints | Prevents double-execution race conditions (two tabs, approve racing timeout). `UPDATE ... WHERE status = 'pending' RETURNING *` — second caller gets 409 Conflict |
| Credentials resolved at execution time, not at tool registration | Env vars may change (secret rotation). Reading at execution time ensures the latest value. Also prevents credentials from being captured in any cached state |
| Slack notify as first action | Existing `postMessage()` infrastructure from v0.8, lowest risk (messages can be deleted), simplest API surface. Proves the framework before tackling JIRA/email |
| Role model uses Better Auth `organization()` plugin | Already in the roadmap for v1.1+ admin console. Pulling forward the role foundation enables action permissions without a new auth system. Backward compatible — adds roles on top of existing auth modes |
| Single `ToolRegistry` with `AtlasAction extends AtlasTool`, not a separate `ActionRegistry` | A parallel registry creates two maps that must stay in sync, two lookup paths, and constructor dependencies. A single registry with a type guard (`isAction()`) is simpler, keeps action metadata co-located with tool definitions, and avoids consistency bugs |
| Rollback is manual, not automatic | Auto-rollback on error (e.g., partial Slack message sent then API error) adds significant complexity. For v0.9, the rollback API provides the mechanism; operators decide when to use it. Auto-rollback is a v1.0+ concern |
| `none` auth + actions = hard startup error | Actions require identity for audit trails. Allowing actions without auth produces meaningless audit logs and makes the permission model vacuous |
| 2-minute default approval timeout (not 5 minutes) | With non-blocking approval, the timeout is just a TTL for expiring stale pending actions. 2 minutes is long enough for a user to review and approve, short enough that abandoned actions don't linger |
| JSON API uses two-phase approval flow | `POST /api/v1/query` is synchronous — it returns the full query answer alongside `pendingActions`. The caller approves/denies via separate endpoints. This preserves the existing response contract while adding action support |
| Salesforce update deferred from v0.9 initial scope | The Salesforce write API is significantly more complex (field-level permissions, validation rules, triggers, record locking). The read path shipped in v0.7 validates the connection; write-back needs its own design spike |
| Idempotency deferred to v1.0 | External APIs (Slack, JIRA) are not consistently idempotent. For v0.9, crash-before-record is a known edge case — operators check the external system before retrying. v1.0 may introduce idempotency keys where supported |
