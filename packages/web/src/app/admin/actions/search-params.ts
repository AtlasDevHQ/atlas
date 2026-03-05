import { parseAsString, parseAsStringLiteral } from "nuqs"

export const actionsSearchParams = {
  status: parseAsStringLiteral(["pending", "executed", "denied", "failed", "all"] as const).withDefault("pending"),
  expanded: parseAsString,
}
