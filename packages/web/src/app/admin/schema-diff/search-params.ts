import { parseAsString } from "nuqs";

export const schemaDiffSearchParams = {
  connection: parseAsString.withDefault("default"),
};
