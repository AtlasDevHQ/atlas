import { parseAsString } from "nuqs";

export const sessionsSearchParams = {
  search: parseAsString.withDefault(""),
};
