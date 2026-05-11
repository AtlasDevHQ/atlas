import { parseAsInteger, parseAsString } from "nuqs";

export const adminActionsSearchParams = {
  page: parseAsInteger.withDefault(1),
  actor: parseAsString.withDefault(""),
  actionType: parseAsString.withDefault(""),
  targetType: parseAsString.withDefault(""),
  from: parseAsString.withDefault(""),
  to: parseAsString.withDefault(""),
  search: parseAsString.withDefault(""),
};
