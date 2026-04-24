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
  },
  domain: {
    register: "domain.register",
    verify: "domain.verify",
    delete: "domain.delete",
  },
  residency: {
    assign: "residency.assign",
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
  },
  sso: {
    configure: "sso.configure",
    update: "sso.update",
    delete: "sso.delete",
    test: "sso.test",
  },
  semantic: {
    createEntity: "semantic.create_entity",
    updateEntity: "semantic.update_entity",
    deleteEntity: "semantic.delete_entity",
    updateMetric: "semantic.update_metric",
    updateGlossary: "semantic.update_glossary",
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
   */
  audit_retention: {
    policyUpdate: "audit_retention.policy_update",
    export: "audit_retention.export",
    manualPurge: "audit_retention.manual_purge",
    manualHardDelete: "audit_retention.manual_hard_delete",
  },
} as const;

/** Union of all admin action type string values. */
type AdminActionValues = {
  [D in keyof typeof ADMIN_ACTIONS]: (typeof ADMIN_ACTIONS)[D][keyof (typeof ADMIN_ACTIONS)[D]];
}[keyof typeof ADMIN_ACTIONS];

export type AdminActionType = AdminActionValues;

/** Target type is the domain prefix of the action type. */
export type AdminTargetType = keyof typeof ADMIN_ACTIONS;
