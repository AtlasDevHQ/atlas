import { parseAsString } from "nuqs";

export const chatSearchParams = {
  id: parseAsString.withDefault(""),
  /** When set, the chat input is prefilled and submitted on first render.
   *  Used by /wizard's Done step and /signup/success starter prompts. */
  prompt: parseAsString.withDefault(""),
};
