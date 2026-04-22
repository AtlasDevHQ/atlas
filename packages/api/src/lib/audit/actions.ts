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
} as const;

/** Union of all admin action type string values. */
type AdminActionValues = {
  [D in keyof typeof ADMIN_ACTIONS]: (typeof ADMIN_ACTIONS)[D][keyof (typeof ADMIN_ACTIONS)[D]];
}[keyof typeof ADMIN_ACTIONS];

export type AdminActionType = AdminActionValues;

/** Target type is the domain prefix of the action type. */
export type AdminTargetType = keyof typeof ADMIN_ACTIONS;
