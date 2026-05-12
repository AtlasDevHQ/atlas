import { parseAsString } from "nuqs";

export const notebookSearchParams = {
  id: parseAsString.withDefault(""),
  cell: parseAsString.withDefault(""),
  /** Workspace-shell modals (schema explorer / prompt library) deliver picks
   *  via this param. Notebook sends as a message; cleared after dispatch. */
  prompt: parseAsString.withDefault(""),
};
