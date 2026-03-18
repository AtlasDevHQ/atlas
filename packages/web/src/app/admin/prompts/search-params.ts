import { parseAsString, parseAsInteger } from "nuqs";

export const promptsSearchParams = {
  industry: parseAsString.withDefault(""),
  page: parseAsInteger.withDefault(1),
};
