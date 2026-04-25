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
   * `improveDraft` marks a new chat-driven draft session, `improveApply`
   * fires when a DB-backed amendment review flips a pending row to
   * applied (YAML written to disk), `improveAccept` / `improveReject`
   * cover the in-memory session proposal decisions. Note: the DB-backed
   * review route branches on `decision` — rejection emits
   * `improve_reject` so forensic queries can filter on a single
   * action_type regardless of which surface rejected it. See F-35.
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
    improveAccept: "semantic.improve_accept",
    improveReject: "semantic.improve_reject",
  },
  pattern: {
    approve: "pattern.approve",
    reject: "pattern.reject",
    delete: "pattern.delete",
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
  },
} as const;

/** Union of all admin action type string values. */
type AdminActionValues = {
  [D in keyof typeof ADMIN_ACTIONS]: (typeof ADMIN_ACTIONS)[D][keyof (typeof ADMIN_ACTIONS)[D]];
}[keyof typeof ADMIN_ACTIONS];

export type AdminActionType = AdminActionValues;

/** Target type is the domain prefix of the action type. */
export type AdminTargetType = keyof typeof ADMIN_ACTIONS;
