import { parseAsString } from "nuqs";

export const notebookSearchParams = {
  id: parseAsString.withDefault(""),
  cell: parseAsString.withDefault(""),
};
