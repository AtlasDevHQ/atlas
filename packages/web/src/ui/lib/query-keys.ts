/**
 * Centralized query key factory for TanStack Query.
 *
 * Each key is a function returning a readonly tuple, enabling precise
 * invalidation (e.g. invalidate all conversations, or just one detail).
 *
 * Convention: keys use hierarchical segments so `invalidateQueries({ queryKey: ["admin"] })`
 * invalidates all admin queries (TanStack Query uses prefix matching by default),
 * while `["admin", "users"]` targets only users.
 *
 * The optional `params` argument on list keys is a serialized URL search string
 * (e.g. `new URLSearchParams(...).toString()`) used to distinguish paginated/filtered queries.
 */
export const queryKeys = {
  // ---- Public / Chat ----
  health: () => ["health"] as const,
  branding: () => ["branding"] as const,

  suggestions: {
    popular: (limit?: number) => ["suggestions", "popular", limit] as const,
    forTable: (table: string, limit?: number) => ["suggestions", "table", table, limit] as const,
  },

  prompts: {
    all: () => ["prompts"] as const,
    detail: (id: string) => ["prompts", id] as const,
  },

  conversations: {
    all: () => ["conversations"] as const,
    list: () => ["conversations", "list"] as const,
    detail: (id: string) => ["conversations", id] as const,
    share: (id: string) => ["conversations", id, "share"] as const,
  },

  semantic: {
    entities: () => ["semantic", "entities"] as const,
    entity: (name: string) => ["semantic", "entities", name] as const,
  },

  onboarding: {
    tourStatus: () => ["onboarding", "tour-status"] as const,
  },

  // ---- Admin ----
  admin: {
    all: () => ["admin"] as const,
    overview: () => ["admin", "overview"] as const,
    passwordStatus: () => ["admin", "me", "password-status"] as const,

    settings: () => ["admin", "settings"] as const,
    connections: () => ["admin", "connections"] as const,
    connectionPool: () => ["admin", "connections", "pool"] as const,
    plugins: () => ["admin", "plugins"] as const,
    cache: () => ["admin", "cache"] as const,
    branding: () => ["admin", "branding"] as const,
    domain: () => ["admin", "domain"] as const,
    sandbox: () => ["admin", "sandbox"] as const,
    modelConfig: () => ["admin", "model-config"] as const,
    integrations: () => ["admin", "integrations", "status"] as const,
    apiKeys: () => ["admin", "api-keys"] as const,
    organizations: () => ["admin", "organizations"] as const,

    users: {
      all: () => ["admin", "users"] as const,
      list: (params?: string) => ["admin", "users", "list", params] as const,
      stats: () => ["admin", "users", "stats"] as const,
      invitations: () => ["admin", "users", "invitations"] as const,
    },

    audit: {
      all: () => ["admin", "audit"] as const,
      list: (params?: string) => ["admin", "audit", "list", params] as const,
      stats: () => ["admin", "audit", "stats"] as const,
      connections: () => ["admin", "audit", "connections"] as const,
      facets: () => ["admin", "audit", "facets"] as const,
      retention: () => ["admin", "audit", "retention"] as const,
      analytics: {
        volume: () => ["admin", "audit", "analytics", "volume"] as const,
        slow: () => ["admin", "audit", "analytics", "slow"] as const,
        frequent: () => ["admin", "audit", "analytics", "frequent"] as const,
        errors: () => ["admin", "audit", "analytics", "errors"] as const,
        users: () => ["admin", "audit", "analytics", "users"] as const,
      },
    },

    tokens: {
      summary: (params?: string) => ["admin", "tokens", "summary", params] as const,
      trends: (params?: string) => ["admin", "tokens", "trends", params] as const,
      byUser: (params?: string) => ["admin", "tokens", "by-user", params] as const,
    },

    sessions: {
      all: () => ["admin", "sessions"] as const,
      list: (params?: string) => ["admin", "sessions", "list", params] as const,
      stats: () => ["admin", "sessions", "stats"] as const,
    },

    roles: () => ["admin", "roles"] as const,

    learnedPatterns: {
      all: () => ["admin", "learned-patterns"] as const,
      list: (params?: string) => ["admin", "learned-patterns", "list", params] as const,
    },

    prompts: () => ["admin", "prompts"] as const,

    semantic: {
      all: () => ["admin", "semantic"] as const,
      entities: () => ["admin", "semantic", "entities"] as const,
      glossary: () => ["admin", "semantic", "glossary"] as const,
      metrics: () => ["admin", "semantic", "metrics"] as const,
      catalog: () => ["admin", "semantic", "catalog"] as const,
      raw: (path: string) => ["admin", "semantic", "raw", path] as const,
      versions: (entityName: string) => ["admin", "semantic", "versions", entityName] as const,
      versionDetail: (id: string) => ["admin", "semantic", "versions", "detail", id] as const,
    },

    schemaDiff: {
      connections: () => ["admin", "schema-diff", "connections"] as const,
      diff: (params?: string) => ["admin", "schema-diff", "diff", params] as const,
    },

    approval: {
      rules: () => ["admin", "approval", "rules"] as const,
      queue: (params?: string) => ["admin", "approval", "queue", params] as const,
    },

    sso: {
      providers: () => ["admin", "sso", "providers"] as const,
      enforcement: () => ["admin", "sso", "enforcement"] as const,
    },

    scim: {
      config: () => ["admin", "scim", "config"] as const,
      groupMappings: () => ["admin", "scim", "group-mappings"] as const,
    },

    ipAllowlist: () => ["admin", "ip-allowlist"] as const,
    abuse: {
      all: () => ["admin", "abuse"] as const,
      config: () => ["admin", "abuse", "config"] as const,
    },
    compliance: () => ["admin", "compliance"] as const,

    residency: {
      config: () => ["admin", "residency"] as const,
      migration: () => ["admin", "residency", "migration"] as const,
    },

    billing: () => ["admin", "billing"] as const,
    usage: () => ["admin", "usage"] as const,

    scheduledTasks: () => ["admin", "scheduled-tasks"] as const,
    actions: (params?: string) => ["admin", "actions", params] as const,
  },

  // ---- Platform Admin ----
  platform: {
    all: () => ["platform"] as const,
    stats: () => ["platform", "stats"] as const,
    workspaces: () => ["platform", "workspaces"] as const,
    workspaceDetail: (id: string) => ["platform", "workspaces", id] as const,
    neighbors: () => ["platform", "neighbors"] as const,

    domains: () => ["platform", "domains"] as const,

    residency: {
      regions: () => ["platform", "residency", "regions"] as const,
      assignments: () => ["platform", "residency", "assignments"] as const,
    },

    backups: {
      list: () => ["platform", "backups"] as const,
      config: () => ["platform", "backups", "config"] as const,
    },

    sla: {
      metrics: () => ["platform", "sla", "metrics"] as const,
      alerts: () => ["platform", "sla", "alerts"] as const,
      thresholds: () => ["platform", "sla", "thresholds"] as const,
      detail: (workspaceId: string) => ["platform", "sla", "detail", workspaceId] as const,
    },

    plugins: () => ["platform", "plugins"] as const,
  },

  // ---- Wizard ----
  wizard: {
    connections: () => ["wizard", "connections"] as const,
  },
} as const;
