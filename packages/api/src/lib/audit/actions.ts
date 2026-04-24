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
  connection: {
    create: "connection.create",
    update: "connection.update",
    delete: "connection.delete",
  },
  user: {
    invite: "user.invite",
    remove: "user.remove",
    changeRole: "user.change_role",
    ban: "user.ban",
    unban: "user.unban",
    removeFromWorkspace: "user.remove_from_workspace",
    /**
     * Bulk revocation (`session_revoke_all`) is emitted by two admin
     * surfaces — the dedicated session route and the users route — so
     * downstream queries filtering on `action_type` see one event shape
     * per admin intent, not two.
     */
    sessionRevoke: "user.session_revoke",
    sessionRevokeAll: "user.session_revoke_all",
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
  sso: {
    configure: "sso.configure",
    update: "sso.update",
    delete: "sso.delete",
    test: "sso.test",
  },
  /**
   * Semantic-layer mutations. `createEntity` / `updateEntity` /
   * `deleteEntity` / `updateMetric` / `updateGlossary` cover direct
   * entity CRUD (`admin-semantic.ts` and the admin bulk import). The
   * `improve*` variants cover the AI-assisted expert-agent surface
   * (`admin-semantic-improve.ts`): `improveDraft` marks a new
   * chat-driven draft session, `improveApply` fires when a DB-backed
   * amendment review flips a pending row to applied (YAML written to
   * disk), `improveAccept` / `improveReject` cover the in-memory
   * session proposal decisions. Note: the DB-backed review route
   * branches on `decision` — rejection emits `improve_reject` so
   * forensic queries can filter on a single action_type regardless of
   * which surface rejected it. See F-35.
   */
  semantic: {
    createEntity: "semantic.create_entity",
    updateEntity: "semantic.update_entity",
    deleteEntity: "semantic.delete_entity",
    updateMetric: "semantic.update_metric",
    updateGlossary: "semantic.update_glossary",
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
  integration: {
    enable: "integration.enable",
    disable: "integration.disable",
    configure: "integration.configure",
  },
  schedule: {
    create: "schedule.create",
    update: "schedule.update",
    delete: "schedule.delete",
    toggle: "schedule.toggle",
  },
  apikey: {
    create: "apikey.create",
    revoke: "apikey.revoke",
  },
  approval: {
    approve: "approval.approve",
    deny: "approval.deny",
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
} as const;

/** Union of all admin action type string values. */
type AdminActionValues = {
  [D in keyof typeof ADMIN_ACTIONS]: (typeof ADMIN_ACTIONS)[D][keyof (typeof ADMIN_ACTIONS)[D]];
}[keyof typeof ADMIN_ACTIONS];

export type AdminActionType = AdminActionValues;

/** Target type is the domain prefix of the action type. */
export type AdminTargetType = keyof typeof ADMIN_ACTIONS;
