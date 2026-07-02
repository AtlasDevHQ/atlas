import { parseAsString } from "nuqs";

/**
 * URL state for `/admin/knowledge`. The selected collection slug drives the
 * documents drawer so a review link (a specific collection's document list) is
 * shareable and survives a refresh.
 */
export const knowledgeSearchParams = {
  collection: parseAsString,
};
