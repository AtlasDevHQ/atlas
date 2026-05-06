import { parseAsString, parseAsStringLiteral } from "nuqs"

const auditTabs = ["log", "analytics", "retention"] as const

// `actorKind` is parsed as a string-literal union so an invalid
// `?actorKind=robot` reverts to "" — the route also rejects invalid
// values with a 400, but the parser keeps a stale URL from issuing a
// pointless round-trip. The empty literal represents "All actors".
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
