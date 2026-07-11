import { parseAsString, parseAsInteger } from "nuqs";

export const learnedPatternsSearchParams = {
  status: parseAsString.withDefault(""),
  source_entity: parseAsString.withDefault(""),
  page: parseAsInteger.withDefault(1),
};
