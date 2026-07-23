/**
 * Collection-slug vocabulary shared by every knowledge form handler.
 *
 * Split out of `okf-upload-form-handler.ts` (#4235) so the two collection
 * gates in `knowledge-collection-install.ts` can reach
 * {@link KNOWLEDGE_INSTALL_ID_FIELD} without importing a concrete handler —
 * which would close an import cycle, since every handler imports those gates.
 *
 * @module
 */

import { FormInstallValidationError } from "./email-form-handler";

/**
 * Reserved form key carrying the collection slug (= `install_id`). Same wire key
 * the datasource install modal uses (`__install_id__`), so the shared web
 * install form drives collection creation with no new field. Stripped from the
 * persisted config. When omitted, the first collection defaults to the catalog
 * slug, matching the datasource single-instance default.
 */
export const KNOWLEDGE_INSTALL_ID_FIELD = "__install_id__";

/** Max collection-slug length — generous, bounded so a paste can't bloat the row key. */
export const COLLECTION_SLUG_MAX = 128;

/**
 * A collection slug becomes the `install_id` (row key), the `collection_id` on
 * every document, and the URL path segment of the ingest endpoint — so restrict
 * it to the same URL-safe id alphabet a connection id uses (letters, digits,
 * `.`, `-`, `_`), rejecting slashes/whitespace/delimiters.
 */
const COLLECTION_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the collection slug from the reserved form value, defaulting to
 * `defaultSlug` when omitted/blank. A supplied slug is trimmed and validated
 * against {@link COLLECTION_SLUG_PATTERN} — an invalid one is a field-level 400
 * (it becomes the row key, document `collection_id`, and URL segment), never
 * silently coerced.
 */
export function resolveCollectionSlug(raw: unknown, defaultSlug: string): string {
  if (raw === undefined || raw === null) return defaultSlug;
  if (typeof raw !== "string") {
    throw new FormInstallValidationError({
      fieldErrors: { [KNOWLEDGE_INSTALL_ID_FIELD]: ["Collection id must be a string."] },
      formErrors: [],
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return defaultSlug;
  if (trimmed.length > COLLECTION_SLUG_MAX) {
    throw new FormInstallValidationError({
      fieldErrors: {
        [KNOWLEDGE_INSTALL_ID_FIELD]: [`Collection id must be ${COLLECTION_SLUG_MAX} characters or fewer.`],
      },
      formErrors: [],
    });
  }
  if (!COLLECTION_SLUG_PATTERN.test(trimmed)) {
    throw new FormInstallValidationError({
      fieldErrors: {
        [KNOWLEDGE_INSTALL_ID_FIELD]: [
          "Collection id may contain only letters, digits, dots, dashes, and underscores.",
        ],
      },
      formErrors: [],
    });
  }
  return trimmed;
}
