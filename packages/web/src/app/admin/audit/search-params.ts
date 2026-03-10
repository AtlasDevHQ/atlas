import { parseAsInteger, parseAsString, parseAsBoolean, parseAsStringLiteral } from "nuqs"

export const auditTabs = ["log", "analytics"] as const;
export type AuditTab = (typeof auditTabs)[number];

export const auditSearchParams = {
  tab: parseAsStringLiteral(auditTabs).withDefault("log"),
  page: parseAsInteger.withDefault(1),
  user: parseAsString.withDefault(""),
  from: parseAsString.withDefault(""),
  to: parseAsString.withDefault(""),
  errorOnly: parseAsBoolean.withDefault(false),
}
