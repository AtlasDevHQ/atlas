import { parseAsInteger, parseAsString } from "nuqs";

export const orgsSearchParams = {
  page: parseAsInteger.withDefault(1),
  search: parseAsString.withDefault(""),
};
