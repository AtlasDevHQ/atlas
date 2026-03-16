import { parseAsString, parseAsStringLiteral } from "nuqs"

export const actionsSearchParams = {
  status: parseAsStringLiteral(["pending", "executed", "denied", "failed", "rolled_back", "all"] as const).withDefault("pending"),
  expanded: parseAsString,
}
