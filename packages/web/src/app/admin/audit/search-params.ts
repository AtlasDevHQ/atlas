import { parseAsString, parseAsStringLiteral } from "nuqs"

const auditTabs = ["log", "analytics"] as const

export const auditSearchParams = {
  tab: parseAsStringLiteral(auditTabs).withDefault("log"),
  search: parseAsString.withDefault(""),
  connection: parseAsString.withDefault(""),
  table: parseAsString.withDefault(""),
  column: parseAsString.withDefault(""),
  status: parseAsStringLiteral(["success", "error", ""] as const).withDefault(""),
  from: parseAsString.withDefault(""),
  to: parseAsString.withDefault(""),
}
