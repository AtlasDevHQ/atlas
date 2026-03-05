import { parseAsInteger, parseAsString, parseAsBoolean } from "nuqs"

export const auditSearchParams = {
  page: parseAsInteger.withDefault(1),
  user: parseAsString.withDefault(""),
  from: parseAsString.withDefault(""),
  to: parseAsString.withDefault(""),
  errorOnly: parseAsBoolean.withDefault(false),
}
