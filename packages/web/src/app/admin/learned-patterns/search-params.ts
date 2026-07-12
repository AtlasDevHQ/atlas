import { parseAsString, parseAsInteger, parseAsBoolean } from "nuqs";

export const learnedPatternsSearchParams = {
  status: parseAsString.withDefault(""),
  source_entity: parseAsString.withDefault(""),
  // Confidence bounds are the exact API params (`min_confidence`/`max_confidence`,
  // decimals in [0,1]) so the URL is directly shareable and maps 1:1 onto the
  // route's validated filter. Empty string = unset.
  min_confidence: parseAsString.withDefault(""),
  max_confidence: parseAsString.withDefault(""),
  // Seen-once view toggle (#4581): off by default so the queue shows evidence
  // (repeated patterns), not raw single-capture noise. `true` reveals the
  // `repetition_count = 1` rows the route hides from the default view.
  include_seen_once: parseAsBoolean.withDefault(false),
  page: parseAsInteger.withDefault(1),
};
