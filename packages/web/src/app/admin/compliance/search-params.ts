import { parseAsString, parseAsStringLiteral } from "nuqs"

const complianceTabs = ["classifications", "reports"] as const
const reportTypes = ["data-access", "user-activity"] as const

export const complianceSearchParams = {
  tab: parseAsStringLiteral(complianceTabs).withDefault("classifications"),
  reportType: parseAsStringLiteral(reportTypes).withDefault("data-access"),
  from: parseAsString.withDefault(""),
  to: parseAsString.withDefault(""),
  userId: parseAsString.withDefault(""),
  role: parseAsString.withDefault(""),
  table: parseAsString.withDefault(""),
}
