import { parseAsString, parseAsInteger } from "nuqs";

export const learnedPatternsSearchParams = {
  status: parseAsString.withDefault(""),
  source_entity: parseAsString.withDefault(""),
  // Confidence bounds are the exact API params (`min_confidence`/`max_confidence`,
  // decimals in [0,1]) so the URL is directly shareable and maps 1:1 onto the
  // route's validated filter. Empty string = unset.
  min_confidence: parseAsString.withDefault(""),
  max_confidence: parseAsString.withDefault(""),
  page: parseAsInteger.withDefault(1),
};
