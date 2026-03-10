import { parseAsInteger, parseAsString, parseAsStringLiteral } from "nuqs";

export const runHistorySearchParams = {
  page: parseAsInteger.withDefault(1),
  task: parseAsString,
  status: parseAsStringLiteral(["all", "running", "success", "failed", "skipped"] as const).withDefault("all"),
  dateFrom: parseAsString,
  dateTo: parseAsString,
  expandedRun: parseAsString,
};
