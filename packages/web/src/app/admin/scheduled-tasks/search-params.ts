import { parseAsInteger, parseAsString, parseAsStringLiteral } from "nuqs"

export const scheduledTasksSearchParams = {
  page: parseAsInteger.withDefault(1),
  enabled: parseAsStringLiteral(["all", "true", "false"] as const).withDefault("all"),
  expanded: parseAsString,
}
