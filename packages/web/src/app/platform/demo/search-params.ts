import { parseAsString } from "nuqs";

/**
 * URL state for /platform/demo.
 *
 * `selectedEmail` — the demo lead whose transcript Sheet is open. Deep-linkable
 * so an operator can share a direct link to a lead's question history.
 */
export const demoSearchParams = {
  selectedEmail: parseAsString,
};
