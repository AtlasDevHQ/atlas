import { parseAsString, parseAsStringLiteral } from "nuqs"
import { COMPLIANCE_REPORT_TYPES } from "@/ui/lib/types"

const complianceTabs = ["classifications", "reports"] as const

export const complianceSearchParams = {
  tab: parseAsStringLiteral(complianceTabs).withDefault("classifications"),
  reportType: parseAsStringLiteral(COMPLIANCE_REPORT_TYPES).withDefault("data-access"),
  from: parseAsString.withDefault(""),
  to: parseAsString.withDefault(""),
  userId: parseAsString.withDefault(""),
  role: parseAsString.withDefault(""),
  table: parseAsString.withDefault(""),
}
