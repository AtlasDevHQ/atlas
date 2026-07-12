/**
 * Admin action type constants.
 *
 * Typed catalog of every admin action that gets logged. Organized by domain
 * so action types are compile-time checked. New actions can be added here
 * and immediately used with logAdminAction().
 *
 * Format: "domain.verb" — e.g. "workspace.suspend", "connection.create"
 */

export const ADMIN_ACTIONS = {
  workspace: {
    suspend: "workspace.suspend",
    unsuspend: "workspace.unsuspend",
    delete: "workspace.delete",
    purge: "workspace.purge",
    changePlan: "workspace.change_plan",
    /**
     * Manual reinstate from an abuse-prevention flag (throttled / suspended →
     * none). Dual-written alongside the `abuse_events` row so compliance
     * queries scanning `admin_action_log` for platform-admin actions don't
     * miss reinstates — see F-33 in .claude/research/security-audit-1-2-3.md.
     * Metadata carries `previousLevel` (warning / throttled / suspended) so
     * reviewers can distinguish a low-impact un-warn from lifting a full
     * suspension without joining on `abuse_events`.
     */
    reinstateAbuse: "workspace.reinstate_abuse",
  },
  /**
   * Custom domain lifecycle. `register` / `verify` / `delete` cover the
   * platform-admin surface (`platform-domains.ts`). The `workspace*`
   * variants cover the workspace-self-serve surface (`admin-domains.ts`,
   * see F-32 in .claude/research/security-audit-1-2-3.md) so forensic
   * queries can tell a platform-staff domain change from a workspace-admin
   * one without joining on `scope`.
   */
  domain: {
    register: "domain.register",
    verify: "domain.verify",
    delete: "domain.delete",
    workspaceRegister: "domain.workspace_register",
    workspaceRemove: "domain.workspace_remove",
    workspaceVerify: "domain.workspace_verify",
    workspaceVerifyDns: "domain.workspace_verify_dns",
  },
  /**
   * Data-residency lifecycle. `assign` covers the platform-admin surface
   * (`platform-residency.ts`). The `workspace*` variants cover workspace
   * self-serve (`admin-residency.ts`). Region assignment is permanent —
   * `workspace_assign` metadata MUST carry `permanent: true` so triage
   * sees the permanence flag on the audit row. See F-32.
   */
  residency: {
    assign: "residency.assign",
    workspaceAssign: "residency.workspace_assign",
    migrationRequest: "residency.migration_request",
    migrationRetry: "residency.migration_retry",
    migrationCancel: "residency.migration_cancel",
  },
  sla: {
    updateThresholds: "sla.update_thresholds",
    acknowledgeAlert: "sla.acknowledge_alert",
    evaluate: "sla.evaluate",
  },
  backup: {
    create: "backup.create",
    verify: "backup.verify",
    requestRestore: "backup.request_restore",
    confirmRestore: "backup.confirm_restore",
    updateConfig: "backup.update_config",
  },
  settings: {
    update: "settings.update",
  },
  /**
   * Connection lifecycle. `create` / `update` / `delete` cover the canonical
   * admin-connections CRUD surface. `create` is ALSO emitted by the wizard
   * `/save` onboarding endpoint (F-34) — wizard and admin-connections produce
   * structurally identical audit rows (`metadata: { name, dbType }`) so a
   * compliance query filtering `action_type = 'connection.create'` sees
   * datasource additions regardless of entry path.
   *
   * `probe` covers the ephemeral `POST /test` endpoint: caller supplies a
   * URL, the server registers it transiently, runs a health check, and
   * tears it down. Audited because the endpoint returns a reachability
   * verdict — a free oracle for a compromised admin probing internal
   * network segments. Target id is the temporary `_test_*` id so
   * forensic queries can count probes without conflating them with
   * registered-connection health checks.
   *
   * `healthCheck` covers `POST /:id/test` on a registered connection —
   * routine reachability checks against a persisted datasource. Kept
   * distinct from `probe` so compliance queries can separately filter
   * the privilege-escalation surface (`probe`) from operational health
   * signal (`healthCheck`). Matches the `manualHardDelete` vs
   * `hardDelete` / `archive` vs `archiveReconcile` pattern elsewhere in
   * the catalog. Metadata for both: `{ success, dbType, latencyMs }`.
   *
   * `pool_drain` covers the org-wide pool drain (`POST /pool/orgs/{orgId}/drain`,
   * platform scope). Metadata: `{ orgId, drainedConnections }`. Pool drain is
   * an availability lever — without the audit row a platform admin can silently
   * disconnect every active session in an org. The per-connection drain path
   * (`POST /:id/drain`) is tracked as an F-29 residual in #1784.
   */
  connection: {
    create: "connection.create",
    update: "connection.update",
    delete: "connection.delete",
    probe: "connection.probe",
    healthCheck: "connection.health_check",
    poolDrain: "connection.pool_drain",
    /**
     * `specRefreshCycle` (#2978) — emitted once per tick by the Tier-2 OpenAPI
     * per-install re-discovery scheduler, even at zero candidates. The absence of a
     * cycle row over a multi-tick window is the signal the loop stopped (same
     * forensic invariant as `model_config.catalog_refresh_cycle` /
     * `audit_log.purge_cycle`). Status is `success` on a healthy cycle; `failure` if
     * the candidate query itself threw before producing per-install counts. Uses the
     * reserved `system:openapi-install-rediscover` actor; metadata carries the full
     * `RediscoverCycleResult` counts. The per-install re-probes themselves reuse
     * `connection.probe` with `triggeredBy: "scheduler"`, so an operator filtering by
     * install id sees manual and scheduled refreshes uniformly.
     */
    specRefreshCycle: "connection.spec_refresh_cycle",
    /**
     * `breakingDrift` (#2979) — emitted by the Tier-2 OpenAPI per-install
     * re-discovery scheduler when an UNATTENDED re-probe surfaces BREAKING spec
     * drift (an operation/field the agent relied on was removed/retyped, an
     * operation re-routed, or a new required request field appeared). The
     * companion to the persisted `openapi_drift_alert` pill — the queryable,
     * retention-aligned trace that an upstream API changed under a customer
     * before their agent's calls started failing. Additive-only drift does NOT
     * emit this row (it stays quiet). Uses the reserved
     * `system:openapi-install-rediscover` actor; metadata carries
     * `{ workspaceId, installId, kind: "openapi-rediscover", triggeredBy:
     * "scheduler", breakingCount, reasons[] }` (reasons capped, same sample the
     * pill stores).
     *
     * Status is `success`, deliberately: the re-probe itself SUCCEEDED — this is
     * an attention row, not an operation failure. The dedicated action type + the
     * persisted alert ARE the signal; keeping status `success` means a healthy
     * refresh that happens to detect a breaking change doesn't trip dashboards
     * that alert on `connection.probe` failures. Operators monitor for the
     * PRESENCE of `connection.spec_drift_breaking` rows, not for a failure status.
     */
    breakingDrift: "connection.spec_drift_breaking",
  },
  /**
   * Connection-group admin actions. Renames are display-label changes
   * only — `id` is the foreign key. `assignMember` covers both
   * "move into group" and "unassign" (target group_id may be null).
   * Snake-cased key matches the wire-format convention of every other
   * multi-word target-type (oauth_client, mcp_session, etc.).
   */
  connection_group: {
    create: "connection_group.create",
    rename: "connection_group.rename",
    delete: "connection_group.delete",
    assignMember: "connection_group.assign_member",
    /**
     * Atomic merge of N source connections into one target environment
     * (#2409). The action's `targetId` is the resulting target group id;
     * `metadata` carries `{ sourceConnectionIds, deletedGroupIds,
     * primaryConnectionId, created }` so the audit row reconstructs the
     * full state change without a second query.
     */
    merge: "connection_group.merge",
    /**
     * Group-archive cascade. The action's `targetId` is the archived
     * group id; `metadata` carries `{ archivedCounts }` so the audit
     * row reconstructs the cascade scope without re-querying.
     */
    archive: "connection_group.archive",
  },
  user: {
    invite: "user.invite",
    remove: "user.remove",
    changeRole: "user.change_role",
    ban: "user.ban",
    unban: "user.unban",
    removeFromWorkspace: "user.remove_from_workspace",
    revokeInvitation: "user.revoke_invitation",
    /**
     * Bulk revocation (`session_revoke_all`) is emitted by two admin
     * surfaces — the dedicated session route and the users route — so
     * downstream queries filtering on `action_type` see one event shape
     * per admin intent, not two.
     */
    sessionRevoke: "user.session_revoke",
    sessionRevokeAll: "user.session_revoke_all",
    /**
     * Force-revoke every auth artifact for a target user. Distinct from
     * `session_revoke_all` — the per-artifact counts in metadata are the
     * audit signal that every credential class (sessions, trust-devices,
     * passkeys, OAuth tokens) was reset, not just web sessions.
     *
     * Success metadata: `{ targetUserId, targetUserEmail, sessionsRevoked,
     * trustedDevicesRevoked, verificationRowsRevoked, passkeysRevoked,
     * oauthAccessTokensRevoked, oauthRefreshTokensRevoked, reason? }`.
     * Failure metadata adds `{ phase, error }` so triage can answer
     * "did anything actually delete?" from the audit log alone.
     */
    authRevoke: "user.auth_revoke",
    /**
     * Admin-mediated MFA reset for a target user. Sibling to
     * `auth_revoke` — narrower scope: clears only the second-factor
     * artifacts (passkey enrollments, TOTP secrets, backup-code batches)
     * so a locked-out passkey-only user can re-enroll on next sign-in.
     * Sessions, OAuth grants, and trust-device cookies are deliberately
     * left in place; the goal is "let them recover their MFA", not "kick
     * them out of every surface".
     *
     * Re-enrollment is forced by removing every credential the
     * `mfaRequired` middleware accepts (passkey + `user.twoFactorEnabled`).
     * No new column is needed — emptying both rows trips the existing
     * `mfa_enrollment_required` 403 on the next admin-router request.
     *
     * Success metadata: `{ targetUserId, targetUserEmail, passkeysRevoked,
     * totpSecretsRevoked, backupCodeBatchesRevoked, reason? }`. Failure
     * metadata adds `{ phase, error }` where `phase` names the rolled-back
     * step so triage can answer "did anything actually delete?" without
     * grep-ing pino.
     */
    mfaReset: "user.mfa_reset",
    /**
     * Self-service password change via `POST /me/password`. The actor IS
     * the target — audit row carries `targetType: "user"` and
     * `targetId: actorId` so forensic queries can distinguish a user
     * changing their own password from an admin changing someone else's
     * (the latter goes through Better Auth's admin API and is covered by
     * `changeRole` / `ban` / `unban` sibling rows). Metadata never
     * includes password material. See F-29.
     */
    passwordChange: "user.password_change",
    /**
     * GDPR / CCPA "right to erasure" over `admin_action_log`. Emitted by
     * `anonymizeUserAdminActions()` in `ee/src/audit/retention.ts` on
     * every erasure run regardless of row count — a zero-row erasure is
     * still forensic evidence that the request was processed. Scope is
     * always `platform` because the erasure crosses every workspace the
     * user touched. Metadata carries `{ targetUserId, anonymizedRowCount,
     * initiatedBy: "self_request" | "dsr_request" | "scheduled_retention" }`.
     * The fact of erasure must be auditable even when the erasure target
     * is the audit log itself. See F-36.
     */
    erase: "user.erase",
  },
  /**
   * SSO provider lifecycle. `configure` / `update` / `delete` / `test` cover
   * the CRUD + connectivity-test surface. `verify_domain` covers the DNS
   * TXT-lookup trigger (`POST /providers/:id/verify`) — a silent verify path
   * lets an admin flip a provider to `verified` with no forensic trace.
   * `enforcement_update` covers `PUT /enforcement` — toggling the workspace
   * SSO-required flag blocks or unblocks password login for every member,
   * an availability-critical action that must never be silent. See F-29.
   */
  sso: {
    configure: "sso.configure",
    update: "sso.update",
    delete: "sso.delete",
    test: "sso.test",
    verifyDomain: "sso.verify_domain",
    enforcementUpdate: "sso.enforcement_update",
    /**
     * Emitted by the auth middleware when SSO enforcement blocks a login —
     * either a managed-mode password/session attempt or a BYOT JWT whose
     * email-claim domain matches an SSO-enforced workspace (F-56). Status
     * is always `failure`. Target id is the email domain so forensic
     * queries can pivot on the enforced domain without joining on user.
     * Metadata: `{ authMode, userLabel }`. Not emitted for `simple-key` —
     * that mode is the documented break-glass bypass.
     */
    enforcementBlock: "sso.enforcement_block",
  },
  /**
   * Semantic-layer mutations. `createEntity` / `updateEntity` /
   * `deleteEntity` / `updateMetric` / `updateGlossary` cover direct
   * entity CRUD (`admin-semantic.ts` and the admin bulk import).
   * `bulkImport` covers `POST /semantic/org/import` — disk → DB sync of
   * every entity in the org's semantic directory, emitted once per call
   * with `{ importedCount, sourceRef }`. The `improve*` variants cover
   * the AI-assisted expert-agent surface (`admin-semantic-improve.ts`):
   * `improveDraft` marks a chat turn with the expert agent (which can
   * persist pending amendments mid-stream), `improveApply` fires when an
   * amendment review flips a pending row to approved (YAML written to
   * disk), and `improveReject` fires when a review rejects one — the
   * review route branches on `decision`, so forensic queries can filter
   * on a single action_type per intent. See F-35. `improveReconsider`
   * fires when an admin lifts a rejection (#4512): the rejected Amendment
   * returns to the Pending queue and its identity leaves rejection memory
   * — the only way a rejected change comes back, so it carries its own
   * intent-based action rather than reusing a review action. The former
   * `improve_accept` action covered the deleted in-memory session
   * proposal routes and could never fire in the web flow; it was removed
   * with that subsystem (#4503).
   */
  semantic: {
    createEntity: "semantic.create_entity",
    updateEntity: "semantic.update_entity",
    deleteEntity: "semantic.delete_entity",
    updateMetric: "semantic.update_metric",
    updateGlossary: "semantic.update_glossary",
    bulkImport: "semantic.bulk_import",
    improveDraft: "semantic.improve_draft",
    improveApply: "semantic.improve_apply",
    improveReject: "semantic.improve_reject",
    improveReconsider: "semantic.improve_reconsider",
  },
  /**
   * Learned query-pattern review governance (#4580, PRD #4570). `approve` /
   * `reject` are the SINGLE- and BULK-decision vocabulary — one audit row per
   * decided pattern, one vocabulary per concept now that `semantic_amendment`
   * rows are folded out of this route (#4569; amendment decisions live under
   * `semantic.improve_*`). `delete` covers the hard delete. `updateDescription`
   * covers a description edit (fires whenever a PATCH sets `description`): the
   * human-facing text other reviewers trust changed with no forensic trace
   * before this (F-35-style content-governance
   * gap) — this row is that trail. All are `targetType: "pattern"`, `targetId`
   * the pattern id; metadata carries `{ patternId }`.
   */
  pattern: {
    approve: "pattern.approve",
    reject: "pattern.reject",
    delete: "pattern.delete",
    updateDescription: "pattern.update_description",
  },
  /**
   * `test` is distinct from `email_provider.test` so compliance queries
   * filtering by surface don't have to parse `targetId`.
   */
  integration: {
    enable: "integration.enable",
    disable: "integration.disable",
    configure: "integration.configure",
    test: "integration.test",
  },
  /**
   * Scheduled-task lifecycle. `create` / `update` / `delete` / `toggle`
   * cover CRUD + enable/disable flips. `trigger` covers
   * `POST /:id/run` — an admin manually firing a task outside its cron
   * cadence; `preview` covers the dry-run delivery preview.
   *
   * `tick` is emitted once per scheduler tick by the `POST /tick` endpoint
   * (Vercel Cron / external scheduler). Uses the reserved `system:scheduler`
   * actor since the tick has no HTTP-bound admin. Emits even at zero tasks
   * so the absence of a tick row over a cadence window is the signal that
   * the scheduler stopped — consistent with the F-27 purge-cycle pattern.
   * See F-29.
   */
  schedule: {
    create: "schedule.create",
    update: "schedule.update",
    delete: "schedule.delete",
    toggle: "schedule.toggle",
    trigger: "schedule.trigger",
    preview: "schedule.preview",
    tick: "schedule.tick",
  },
  apikey: {
    create: "apikey.create",
    revoke: "apikey.revoke",
  },
  /**
   * OAuth 2.1 client lifecycle (#2024 PR D — admin Settings → OAuth Clients).
   * `revoke` atomically deletes a Dynamically-Registered Client and every
   * outstanding access/refresh token + consent row for that client, scoped
   * to the active workspace. The four DELETEs run inside a single
   * transaction so a transient pool error mid-sequence cannot leave the
   * workspace with stale refresh tokens after a 500. Without this entry an
   * admin can sever an MCP integration's authorization with zero forensic
   * record — the `oauthClient` table churns on every DCR onboarding and
   * revocation is the only customer-facing kill switch.
   *
   * Success metadata: `{ clientId, clientName, accessTokensRevoked,
   * refreshTokensRevoked, consentRowsRevoked }`.
   *
   * `found: false` (pre-fetch miss) or `{ found: false, race: true }`
   * (concurrent revoke won the race) emits a `status: "success"` row — the
   * attempt itself is forensic signal even when nothing changed.
   *
   * Failure metadata: `{ clientId, clientName, phase, error }` where
   * `phase ∈ "access_tokens" | "refresh_tokens" | "consent" | "client" |
   * "commit"` — answers "did anything actually delete?" without forcing
   * the reviewer to grep logs. The captured `clientName` from the
   * pre-fetch carries through; `errorMessage()` strips pg userinfo from
   * the error string. See F-29.
   */
  oauth_client: {
    revoke: "oauth_client.revoke",
    /**
     * Per-OAuth-client rate-limit override change (#2071). Fired by the
     * admin PATCH route at `/admin/oauth-clients/:id/rate-limit` whenever
     * an admin sets, updates, or clears the per-minute quota for a
     * registered client. Metadata: `{ clientId, clientName,
     * previousRpm, newRpm }` where either bound being `null` means
     * "use workspace default". Distinct from `mcp_session.rate_limited`
     * (which fires on every blocked dispatch) — this row is the
     * configuration trail; that row is the enforcement trail.
     */
    rateLimitUpdate: "oauth_client.rate_limit_update",
  },
  /**
   * Workspace-scoped API key lifecycle (#4046 / ADR-0027 §6). The unattended-CI
   * credential — a Better Auth `apiKey()` key carrying `{orgId, role, claims}`
   * metadata so it resolves to its owning member's bound workspace. `mint` fires
   * when a member creates a key via the Atlas mint route (which injects the
   * metadata server-side); metadata: `{ keyId, role, hasClaims }`. The full key
   * value is NEVER audited (it is shown to the minter once and never stored in
   * plaintext). Revocation is the native Better Auth `/api/auth/api-key/delete`
   * mount, which has its own request log.
   */
  workspace_key: {
    mint: "workspace_key.mint",
  },
  /**
   * OAuth 2.1 token lifecycle audit (#2066). Emitted when Better Auth's
   * `oauthProvider` issues a fresh access token via the `refresh_token`
   * grant — the load-bearing event for "the agent stayed connected past
   * the original JWT's expiry". The hosted MCP path's only Atlas-side
   * trace of a refresh otherwise lives in pino (which retention rotates
   * out); this row is the queryable, retention-policy-aligned record.
   *
   * Metadata:
   *   - `clientId`         — the OAuth client_id that presented the
   *                          refresh token. Production wiring sets this
   *                          to `null` because Better Auth's
   *                          `customTokenResponseFields` hook does not
   *                          surface the `oauthClient.clientId` column
   *                          to user code (it only exposes the parsed
   *                          `metadata` JSONB blob, which Atlas does
   *                          not write `clientId` into). The audit row
   *                          falls back to `targetId = "unknown"` in
   *                          that case. The field is shaped to accept
   *                          a real value so a future hook upgrade or
   *                          a follow-up DB lookup can light up the
   *                          per-agent forensic split without changing
   *                          the schema.
   *   - `userId`           — the user the token is bound to.
   *   - `tokenJti`         — JWT id of the *new* access token. NOT
   *                          populated by the production hook in
   *                          v1.4.1; reserved for direct integration
   *                          callers and a future hook upgrade that
   *                          surfaces the issued JWT.
   *   - `ageAtRefreshSec`  — wall-clock seconds between the previous
   *                          token's `iat` and the refresh. Same caveat
   *                          as `tokenJti` — not populated by the
   *                          production hook today.
   *
   * Per-token revoke is intentionally NOT in this catalog — the v1.4.1
   * surface only exposes whole-client revoke, which lives under
   * `oauth_client.revoke`. See #2066 "out of scope".
   */
  oauth_token: {
    refresh: "oauth_token.refresh",
  },
  /**
   * Hosted MCP session lifecycle (#2024 PR C). Emitted on every new
   * session-init at `/mcp/{workspace_id}` — sampled per session,
   * not per JSON-RPC frame, since a single agent connection can issue
   * thousands of tool calls. Metadata carries `sessionId`, `orgId`,
   * `clientId` (the OAuth client_id, e.g. `claude-desktop` or a DCR
   * UUID), and `region` so forensic queries pivot on either the
   * workspace, the registered OAuth client, or the API region without
   * a join.
   *
   * The original PR A/B catalog had `mcp_token.{create,revoke,use}`.
   * Those actions were dropped along with the `mcp_tokens` table when
   * the hosted MCP path moved to OAuth 2.1 access tokens — token
   * lifecycle is now Better Auth's `oauthAccessToken` table and lives
   * in its built-in audit log if you wire one. The `start` action here
   * is the only Atlas-side trace of an MCP connection happening.
   */
  mcp_session: {
    start: "mcp_session.start",
    /**
     * Per-OAuth-client rate-limit hit on the hosted MCP endpoint (#2071).
     * Emitted once per denied tool dispatch — the same `(orgId, clientId)`
     * tuple may produce a burst of these rows during a runaway-agent
     * incident, which is the forensic signal we want. Metadata shape:
     *   - `clientId`, `userId`, `tool` at the top level
     *   - `ratelimitState: { limit, weight, retryAfterSec, remaining }`
     *     — the same numbers the agent saw in its `rate_limited`
     *     `AtlasMcpToolError` envelope (note: `isError: true` MCP tool
     *     result, not an HTTP 429). Forensic SQL must pivot through
     *     the nested key, e.g.
     *     `metadata->'ratelimitState'->>'retryAfterSec'`.
     * Lives under `mcp_session` because the existing `actorKind=mcp`
     * admin audit filter (#2067) already covers this surface.
     */
    rateLimited: "mcp_session.rate_limited",
    /**
     * Per-user read of live rate-limit bucket state (#2216). Emitted
     * once per call to `GET /api/v1/me/mcp-usage` — the endpoint that
     * powers the Settings → AI Agents usage chip ("this agent has used
     * 35/60 weighted requests this minute"). Volume is bounded by the
     * page's 10s polling cadence (and only while foregrounded), so the
     * row count for a given user is at most ~6/min, ~360/hour. Lives
     * under `mcp_session` so a single retention policy + dashboard
     * filter (`actorKind=mcp` or domain prefix `mcp_session.*`) covers
     * every rate-limit observability event without forking on a new
     * `mcp_usage` domain. Metadata: `{ clientIds, count }` — list of
     * peeked client ids and the integer count, sized by the user's
     * own client roster (so it scales with the row, not the workspace).
     */
    usageRead: "mcp_session.usage_read",
    /**
     * Workspace-admission denial on the hosted MCP edge (#2073). Emitted
     * for every cross_workspace_denied response AND for the 500-class
     * branch where the grants/membership lookup itself threw — without
     * this row, an attacker probing during a Postgres incident produces
     * no audit trail at all and forensic queries asking "show me every
     * cross-workspace request denied today" miss the DB-outage class
     * entirely. Metadata: `{ clientId, userId, pathWorkspaceId,
     * resolvedWorkspaceId?, reason }`. `reason` is one of:
     *   - `"single_scope_mismatch"` — legacy single-scope client whose
     *     path workspace doesn't match its JWT singular claim
     *   - `"missing_grant"` — multi-scope client; resolved workspace
     *     has no `oauth_client_workspace_grants` row
     *   - `"membership_revoked"` — multi-scope client; user is no
     *     longer a member of the resolved workspace (live check)
     *   - `"admission_lookup_failed"` — DB lookup itself threw (500)
     */
    denied: "mcp_session.denied",
  },
  /**
   * Approval-workflow domain. `approve` / `deny` cover the review decision
   * on a single pending request. `rule_create` / `rule_update` / `rule_delete`
   * cover rule-catalog CRUD; `expire_sweep` covers the manual
   * `POST /approval/expire` pass that flips stale pending requests to
   * `expired`. Without these entries an admin can disable the approval gate,
   * run the action the gate was protecting, and re-enable — end-to-end
   * invisible. See F-29.
   */
  approval: {
    approve: "approval.approve",
    deny: "approval.deny",
    ruleCreate: "approval.rule_create",
    ruleUpdate: "approval.rule_update",
    ruleDelete: "approval.rule_delete",
    expireSweep: "approval.expire_sweep",
  },
  ip_allowlist: {
    add: "ip_allowlist.add",
    remove: "ip_allowlist.remove",
  },
  mode: {
    publish: "mode.publish",
    archive: "mode.archive",
    /**
     * Archive-cascade reconciliation on an already-archived connection —
     * the connection row didn't flip state but stragglers got cleaned up.
     * Separated from `archive` so compliance queries counting state
     * transitions (`action_type = 'mode.archive'`) stay clean.
     */
    archiveReconcile: "mode.archive_reconcile",
    restore: "mode.restore",
  },
  scim: {
    connectionDelete: "scim.connection_delete",
    groupMappingCreate: "scim.group_mapping_create",
    groupMappingDelete: "scim.group_mapping_delete",
  },
  /**
   * EE custom RBAC mutations. Without these entries the Better-Auth
   * `user.change_role` trail covers platform-role changes but a workspace
   * admin can define a role with `admin:audit` / `connection:delete`, assign
   * it to any org member, and leave no forensic trace. See F-25 in
   * .claude/research/security-audit-1-2-3.md.
   */
  role: {
    create: "role.create",
    update: "role.update",
    delete: "role.delete",
    assign: "role.assign",
  },
  /**
   * Plugin lifecycle domain. `enable` / `disable` / `config_update` cover the
   * platform-wide plugin registry; `install` / `uninstall` / `config_update`
   * also cover per-workspace marketplace installs. `catalog_*` covers the
   * platform-admin catalog CRUD. `catalog_cascade_uninstall` fires once per
   * catalog delete that actually removed workspace installations — paired
   * with `catalog_delete` so forensic queries can distinguish no-op deletes
   * from the ones that yanked a data source out from every workspace.
   *
   * `config_update` metadata never includes values — only `keysChanged:
   * string[]`. Plugin configs carry credentials (BigQuery service-account
   * JSON, Snowflake passwords) and logging the values would defeat the point.
   */
  plugin: {
    install: "plugin.install",
    uninstall: "plugin.uninstall",
    enable: "plugin.enable",
    disable: "plugin.disable",
    configUpdate: "plugin.config_update",
    catalogCreate: "plugin.catalog_create",
    catalogUpdate: "plugin.catalog_update",
    catalogDelete: "plugin.catalog_delete",
    catalogCascadeUninstall: "plugin.catalog_cascade_uninstall",
  },
  /**
   * Knowledge Base pillar (#4207, ADR-0028). Collection install rides the shared
   * form-install audit (`integration.*`); this domain covers the lifecycle acts
   * on the `/admin/knowledge` surface: `ingest` (bundle upload → documents, with
   * created/demoted/rejected counts in metadata), `sync` (a manual "Sync now"
   * pull of a bundle-sync collection's endpoint, #4211 — scheduled syncs are
   * recorded in `knowledge_sync_state`, not audited per-run), and `uninstall`
   * (archive the collection's documents). `targetId` is the collection slug.
   */
  knowledge: {
    ingest: "knowledge.ingest",
    sync: "knowledge.sync",
    uninstall: "knowledge.uninstall",
  },
  /**
   * Without these entries a compromised admin could shrink retentionDays
   * and hard-delete the audit trail leaving zero forensic record.
   *
   * `hardDelete` covers the scheduler-driven automatic hard-delete emitted
   * by `hardDeleteExpired` at the library layer when `count > 0`. The
   * manual-trigger HTTP route emits `manualHardDelete` — forensic queries
   * can tell an admin-triggered erase from a retention-schedule erase by
   * filtering on the action type alone.
   */
  audit_retention: {
    policyUpdate: "audit_retention.policy_update",
    export: "audit_retention.export",
    manualPurge: "audit_retention.manual_purge",
    manualHardDelete: "audit_retention.manual_hard_delete",
    hardDelete: "audit_retention.hard_delete",
  },
  /**
   * Admin-action retention domain (F-36). Parallels `audit_retention.*`
   * but governs the `admin_action_log` table instead of `audit_log`.
   * `policyUpdate` is reserved for the Phase 2 admin-UI policy editor
   * (#1813 — no route emits it yet; the library layer in `ee/src/audit/retention.ts`
   * would add a `setAdminActionRetentionPolicy` sibling of the existing
   * `setRetentionPolicy` when that surface lands). `manualPurge` is also
   * reserved for the Phase 2 admin-UI hard-delete button. `hardDelete`
   * is live: emitted by the scheduler-driven `purgeAdminActionExpired`
   * when `count > 0` (consistent with the F-27 zero-row suppression to
   * keep scheduler health noise out of the admin trail). Design doc:
   * `.claude/research/design/admin-action-log-retention.md`.
   */
  admin_action_retention: {
    policyUpdate: "admin_action_retention.policy_update",
    manualPurge: "admin_action_retention.manual_purge",
    hardDelete: "admin_action_retention.hard_delete",
  },
  /**
   * Audit-log self-audit domain (F-27). `purgeCycle` is emitted once per
   * 24 h `runPurgeCycle` tick by the EE purge scheduler — even at zero
   * rows. The absence of a cycle row over a retention window IS the signal
   * that the scheduler stopped. Uses the reserved `system:audit-purge-scheduler`
   * actor since the cycle has no HTTP-bound admin.
   */
  audit_log: {
    purgeCycle: "audit_log.purge_cycle",
  },
  /**
   * Admin-action-log self-audit domain (F-36). Sibling to
   * `audit_log.purge_cycle`. Emitted by `runPurgeCycle()` once per tick
   * regardless of row count: one row for the audit-log side, one for the
   * admin-action-log side, so an outage on either can be detected
   * independently by forensic queries. Uses the same reserved
   * `system:audit-purge-scheduler` actor as the audit-log cycle — the
   * scheduler is one loop processing two tables.
   */
  admin_action_log: {
    purgeCycle: "admin_action_log.purge_cycle",
  },
  /**
   * BYOT email-provider mutations — workspace admin swaps the outbound
   * email transport (current providers live in `EMAIL_PROVIDERS`). Without
   * these entries an admin could swap the workspace sender to a
   * phishing-friendly domain (or harvest working API keys via the /test
   * route) with zero forensic record. Metadata never carries credential
   * material — `hasSecret: true` is the marker that a secret was supplied.
   */
  email_provider: {
    update: "email_provider.update",
    delete: "email_provider.delete",
    test: "email_provider.test",
  },
  /**
   * BYOT workspace LLM model-config mutations. Same threat as
   * `email_provider.*`: the test route accepts an apiKey in the body and
   * returns a delivery result, making it a free credential oracle for an
   * attacker with admin. Metadata never includes `apiKey` — use
   * `hasSecret: true` as the marker.
   */
  model_config: {
    update: "model_config.update",
    delete: "model_config.delete",
    test: "model_config.test",
    /**
     * BYOT discovery refresh (#2271) — workspace's saved provider key is used
     * to fetch the upstream model catalog (Anthropic /v1/models, etc.).
     * Metadata carries `{ provider, modelCount, source: 'cache' | 'fresh' }`;
     * the apiKey is never logged. Audited because the discovery call exercises
     * the stored credential server-side and a misconfigured key (401) is the
     * same forensic signal as a `model_config.test` failure.
     *
     * `catalogRefreshCycle` (#2284) — emitted once per scheduler tick by the
     * BYOT catalog refresh job, even at zero rows. The absence of a cycle row
     * over a **48-hour window** is the signal the refresh scheduler stopped
     * (one missed daily tick is noise; two is a problem). Status is `success`
     * on a healthy cycle; `failure` if the stale-row query itself threw
     * before producing per-row counts. Same forensic invariant as
     * `audit_log.purge_cycle`. Uses the reserved `system:byot-catalog-refresh`
     * actor.
     *
     * `catalogRefreshSkip` (#2284) — emitted per workspace the refresh job
     * skipped without contacting the upstream provider. Metadata carries
     * `{ provider, reason }` where reason ∈ `ByotCatalogRefreshSkipReason`
     * (`@useatlas/types`). Status is `failure` for `decrypt_failed` and
     * `malformed_bedrock_bundle` (admin must re-enter credentials);
     * `success` for `in_backoff` / `ee_unavailable` / `missing_byot_key`
     * (deliberate suppressions).
     */
    catalogRefresh: "model_config.catalog_refresh",
    catalogRefreshCycle: "model_config.catalog_refresh_cycle",
    catalogRefreshSkip: "model_config.catalog_refresh_skip",
  },
  /**
   * Workspace white-label branding. Enterprise-gated. Without these entries
   * an admin can silently re-skin the product before phishing tenant users
   * and the audit trail shows nothing. See F-32.
   */
  branding: {
    update: "branding.update",
    delete: "branding.delete",
  },
  /**
   * Proactive chat admin opt-in (#2294, PRD #2291). The reaction-first
   * tracer (#2292) shipped with an env-var allowlist; the admin console
   * replaces it with persisted state. Every flip — master toggle,
   * sensitivity, classifier mode, monthly cap, channel override
   * upsert/delete — emits an audit row so a workspace admin can't
   * silently widen the agent's interjection radius across the tenant
   * without a forensic trail. Enterprise-gated.
   */
  proactive: {
    workspaceUpdate: "proactive.workspace_update",
    channelUpsert: "proactive.channel_upsert",
    channelDelete: "proactive.channel_delete",
    workspaceKillEnable: "proactive.workspace_kill_enable",
    workspaceKillDisable: "proactive.workspace_kill_disable",
    // Slice #2296 — lifecycle audit row siblings of the meter events.
    classify: "proactive.classify",
    react: "proactive.react",
    answer: "proactive.answer",
    feedback: "proactive.feedback",
    // Slice #2297 — admin writes to the unlinked-asker public dataset.
    publicDatasetUpsert: "proactive.public_dataset_upsert",
    publicDatasetDelete: "proactive.public_dataset_delete",
    /**
     * Slice #2622 — admin labels a classify decision as
     * `misfire` / `correct` / `unsure` from the drill-down panel. Upsert
     * on (workspace_id, message_id), so re-labelling the same message
     * emits a fresh audit row each time (the new verdict overrides any
     * prior one; the trail records the history). Metadata: `{ workspaceId,
     * channelId, messageId, verdict, previousVerdict, note? }`. `channelId`
     * lets forensic queries pivot on the chat-platform channel without a
     * second join onto `proactive_meter_events`; `previousVerdict` is
     * `null` on first write and the prior value on every subsequent
     * relabel. Without this row, a workspace admin can quietly relabel
     * ambiguous classifies and shift the misfire-rate metric the rest
     * of the team trusts.
     */
    review: "proactive.review",
  },
  /**
   * Compliance / PII-classification mutations. `pii_config_update` covers
   * the PUT /classifications/{id} path (category / masking-strategy /
   * dismissed / reviewed changes on a single classification row).
   * `pii_config_delete` covers the DELETE /classifications/{id} path that
   * drops a classification row and its cache entry. Deliberately distinct
   * from the `audit_retention.*` domain — these do NOT control retention
   * windows, only the shape of PII-masking enforcement on query results.
   * See F-32 in .claude/research/security-audit-1-2-3.md.
   */
  compliance: {
    piiConfigUpdate: "compliance.pii_config_update",
    piiConfigDelete: "compliance.pii_config_delete",
  },
  /**
   * Prompt library CRUD — collections + prompt items. Content-governance
   * trail: these writes reshape the prompts end-users see in the workspace
   * library. Without these entries a workspace admin can edit / delete /
   * reorder prompts (or the collections they live in) with zero forensic
   * record. `collection_*` actions target the collection; `create` /
   * `update` / `delete` / `reorder` target individual prompt items.
   * See F-35.
   */
  prompt: {
    collectionCreate: "prompt.collection_create",
    collectionUpdate: "prompt.collection_update",
    collectionDelete: "prompt.collection_delete",
    create: "prompt.create",
    update: "prompt.update",
    delete: "prompt.delete",
    reorder: "prompt.reorder",
  },
  /**
   * Starter-prompt moderation queue. Approve / hide / unhide flip
   * `approval_status` on a `query_suggestions` row; `author_update`
   * covers the admin-authored seed path that skips the pending queue.
   * Starter prompts are surfaced on the first-run / empty-state
   * surfaces, so a workspace admin can reshape the landing experience
   * for every tenant user — unaudited, nobody knows who authored what.
   * See F-35.
   */
  starter_prompt: {
    approve: "starter_prompt.approve",
    hide: "starter_prompt.hide",
    unhide: "starter_prompt.unhide",
    authorUpdate: "starter_prompt.author_update",
  },
  /**
   * Load-testing surface (#2135). `mintMcpToken` fires once per call to
   * the self-mint endpoint at `POST /api/v1/me/load-test/mcp-token` that
   * issues short-lived MCP-scoped JWTs for k6-driven load runs. Scope
   * is `workspace` — the caller mints for their own active workspace
   * only, so the audit row pivots cleanly on `org_id`. Distinct domain
   * from `oauth_token.refresh` because the threat model differs: these
   * are minted directly (no OAuth ceremony), so the audit row is the
   * only forensic trace that one was issued. Awaited write via
   * `logAdminActionAwait` (NOT fire-and-forget): credential issuance
   * where the audit row IS the security control means a DB hiccup
   * mid-mint must surface to the caller as a 500, not leave a silent
   * token in the wild. Metadata: `{ workspaceId, region, ttlSeconds,
   * sub, jti, expiresAt }`. The bearer is NEVER logged — the `jti` is
   * the audit's correlation handle.
   */
  load_test: {
    mintMcpToken: "load_test.mint_mcp_token",
  },
  /**
   * Per-conversation cost-ceiling rejection (F-77). Emitted by the chat
   * handler when `reserveConversationBudget` returns `exceeded`.
   * Audited so abuse detection picks up on a workspace grinding a single
   * conversation up to the aggregate ceiling — the per-request step cap
   * and wall-clock budgets bound a single run, but the long-tail
   * follow-up flow on one conversation isn't covered without this row.
   * Metadata: `{ totalSteps, cap }`. Target id is the conversation id.
   * The chat handler passes `scope: "workspace"` explicitly —
   * `logAdminAction` defaults to `"workspace"` only when no
   * `systemActor` is set, so the explicit pass keeps a future
   * system-actor codepath from silently inverting the row's scope to
   * `"platform"`.
   */
  conversation: {
    budgetExceeded: "conversation.budget_exceeded",
    /**
     * Admin reset of a session's durable working memory (#3758, ADR-0020).
     * Emitted by `admin-session-memory.ts` when an admin clears another
     * user's accumulated agent state. Audited because it is a destructive
     * action on memory the agent threads into future turns. Metadata:
     * `{ cleared, namespace }` — `namespace: null` is a full-session wipe,
     * a non-null value is a single-slot clear. Target id is the
     * conversation id.
     */
    memoryReset: "conversation.memory_reset",
  },
  /**
   * Query-result cache lifecycle. `flush` covers the manual purge from
   * the admin cache surface (`admin-cache.ts`). The cache is a
   * process-wide singleton — flushing clears entries for every workspace
   * sharing the runtime, so a forensic row is the only way to attribute
   * a fleet-wide cache invalidation to a specific admin once #2167 widened
   * the gate from `platform_admin` to `admin/owner/platform_admin`.
   * Metadata: `{ flushed }` — count of entries cleared.
   */
  cache: {
    flush: "cache.flush",
  },
  /**
   * Platform-operator CRM outbox actions (#2735). The outbox table
   * holds SaaS-only marketing-funnel leads (demo signups, Better Auth
   * signups, talk-to-sales submissions); operators inspecting the
   * queue can manually `retry` a dead row (resets `status` to
   * `pending` and clears `last_error`, leaving `attempts` untouched so
   * backoff resumes where it stopped) or `markDead` a pending/in-flight
   * row (the manual escape hatch when an operator knows dispatch will
   * never succeed). Without these entries a platform admin can unstick
   * or kill leads with zero forensic record, defeating the
   * durable-outbox guarantee that slice 2 (#2729) shipped. Scope is
   * always `platform`; the prior-state snapshot captured in metadata
   * is the audit signal that lets a reviewer reconstruct what the
   * operator overrode — see `platform-crm-outbox.ts` for the metadata
   * shape on each action.
   */
  crm_outbox: {
    retry: "crm_outbox.retry",
    markDead: "crm_outbox.mark_dead",
  },
  /**
   * Operator-tier integration credential mutations (#3735). A platform admin
   * sets/rotates Atlas's OWN integration app registrations (Slack OAuth app,
   * etc.) from the Admin console instead of a Railway redeploy. `update`
   * covers the PUT upsert; `delete` reverts the platform to the env fallback.
   * Scope is always `platform` — these are operator-shared across every
   * workspace, not tenant-scoped. The raw secret NEVER lands in metadata:
   * `hasSecret: true` is the load-bearing marker that a credential was
   * supplied (same convention as `email_provider.*` / `model_config.*`).
   * `fieldsSet` lists the env-var NAMES written (never values) so a reviewer
   * can see which key rotated — the threat is a silent swap of Atlas's app
   * credentials (e.g. pointing the Slack OAuth app at an attacker-controlled
   * client secret) with no forensic trail.
   */
  operator_integration: {
    update: "operator_integration.update",
    delete: "operator_integration.delete",
  },
  /**
   * MCP action policy — the per-workspace customer-admin kill-switch (#3509,
   * ADR-0016 gate 1). `update` is emitted when a workspace admin toggles a
   * category between `allowed` / `blocked`. Workspace scope, target id is the
   * org. Metadata carries `{ category, status, previousStatus }` so a reviewer
   * sees the delta — the threat is silently re-enabling a category a prior
   * admin disabled.
   */
  mcpActionPolicy: {
    update: "mcp_action_policy.update",
  },
  /**
   * Agent Auth Protocol lifecycle (#4412 / #2058, Slice 4). The
   * `@better-auth/agent-auth` plugin emits an `onEvent` for every significant
   * mutation across the register → enroll → request → approve/deny → execute →
   * revoke lifecycle; `lib/auth/agent-auth-audit.ts` maps the audited subset onto
   * these actions so the grant/approval trail is queryable in `admin_action_log`
   * alongside every other admin surface. `targetType` is the domain prefix
   * `agent` for all of them (see {@link AdminTargetType}); the sub-domain
   * (`host` / `capability`) lives in the action verb, not a nested target type.
   *
   * `logAdminAction` resolves the `actor_id` / `org_id` COLUMNS only from the
   * ambient Atlas request context, which is absent on the Better Auth catch-all
   * these events fire from — so those columns are `unknown`/`null` regardless of
   * what the event carries. The trustworthy forensic identifiers travel in
   * `metadata` instead: `actorId` (the owning/approving user), `actorType`,
   * `agentId`, `hostId`, and `orgId` when the event carries one (execute rows add
   * `userId`) — exactly as the `mcp_session.*` rows carry `clientId`/`userId`
   * there. Capability `arguments` / `output` are DELIBERATELY never recorded
   * (they can carry customer SQL / PII); only the capability name + outcome are.
   *
   * `capabilityExecute` is the one high-volume verb, so it is NOT written
   * per-call: successful executes are SUMMARIZED — one row per
   * `EXECUTE_SUMMARY_INTERVAL` calls per `(agent, capability)`, with
   * `metadata.representedExecuteCount` recording how many the row stands for and
   * `metadata.sampled: true` marking it a summary. Execute FAILURES bypass the
   * sampler and always emit (`status: failure`) — they are rare and the
   * load-bearing signal. When `ATLAS_AGENT_AUTH_ENABLED` resolves off (fail
   * closed), NO agent-auth row is emitted at all.
   */
  agent: {
    register: "agent.register",
    revoke: "agent.revoke",
    hostEnroll: "agent.host.enroll",
    hostRevoke: "agent.host.revoke",
    capabilityRequest: "agent.capability.request",
    capabilityApprove: "agent.capability.approve",
    capabilityDeny: "agent.capability.deny",
    capabilityRevoke: "agent.capability.revoke",
    capabilityExecute: "agent.capability.execute",
  },
} as const;

/** Union of all admin action type string values. */
type AdminActionValues = {
  [D in keyof typeof ADMIN_ACTIONS]: (typeof ADMIN_ACTIONS)[D][keyof (typeof ADMIN_ACTIONS)[D]];
}[keyof typeof ADMIN_ACTIONS];

export type AdminActionType = AdminActionValues;

/** Target type is the domain prefix of the action type. */
export type AdminTargetType = keyof typeof ADMIN_ACTIONS;
