import { parseAsString, parseAsStringLiteral } from "nuqs"

const auditTabs = ["log", "analytics", "retention"] as const

// #2067 — `actorKind` matches the audit_log column shape. The empty
// literal `""` represents the "All actors" default and is not a stored
// row value. Keeping the parser as a string-literal union (rather than
// a free `parseAsString`) keeps the URL bookmarkable + drift-safe: an
// invalid `?actorKind=robot` reverts to "" instead of poisoning a SQL
// `WHERE actor_kind = 'robot'` that would silently return 0 rows.
const actorKinds = ["", "human", "agent", "mcp", "scheduler"] as const

export const auditSearchParams = {
  tab: parseAsStringLiteral(auditTabs).withDefault("log"),
  search: parseAsString.withDefault(""),
  connection: parseAsString.withDefault(""),
  table: parseAsString.withDefault(""),
  column: parseAsString.withDefault(""),
  status: parseAsStringLiteral(["success", "error", ""] as const).withDefault(""),
  from: parseAsString.withDefault(""),
  to: parseAsString.withDefault(""),
  actorKind: parseAsStringLiteral(actorKinds).withDefault(""),
  clientId: parseAsString.withDefault(""),
  tool: parseAsString.withDefault(""),
}
