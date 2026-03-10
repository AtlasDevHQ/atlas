import { parseAsString } from "nuqs"

export const tokenUsageSearchParams = {
  from: parseAsString.withDefault(""),
  to: parseAsString.withDefault(""),
}
