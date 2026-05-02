import { parseAsInteger, parseAsString } from "nuqs";

export const wizardSearchParams = {
  step: parseAsInteger.withDefault(1),
  connectionId: parseAsString.withDefault(""),
};
