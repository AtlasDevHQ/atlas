/**
 * Cache key generation for query result caching.
 *
 * Keys are SHA-256 hashes of the trimmed SQL + connectionId + orgId + claims.
 *
 * Isolation invariant: two requests share a cache entry only when *all four*
 * key components match. orgId contributes to the key, but it is NOT the sole
 * discriminator — it may be undefined (auth mode "none", or claims-only tenancy
 * where the tenant lives inside `claims`), so isolation cannot rely on orgId
 * "by construction". The claims serialization below therefore has to be
 * faithful: the RLS discriminator may sit at a nested claim path
 * (`resolveClaimPath` dot-paths, `lib/rls.ts`), and if the serialization drops
 * nested values two users collide on one key and one is served the other's
 * RLS-filtered rows for the cache TTL. That is why claims are canonicalized
 * recursively rather than with a top-level replacer array.
 */

/**
 * Deep, order-insensitive canonical serialization of a claims value.
 *
 * Sorts object keys at *every* nesting level so key stability across
 * property-insertion order is preserved, while every nested value stays part of
 * the output. A `JSON.stringify` replacer array cannot be used here: it applies
 * the top-level key whitelist at every depth, so a nested object like
 * `{ app_metadata: { org_id: "org-42" } }` serializes to `{"app_metadata":{}}`
 * and the discriminating value is erased (see the header note).
 *
 * Arrays preserve order (position is semantically meaningful); objects sort by
 * key. Primitives round-trip through `JSON.stringify`.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Build a deterministic cache key from query parameters.
 *
 * Includes orgId in the key material so different organizations never
 * share cached results, even for identical SQL. Claims are deep-canonicalized
 * so nested claim values (e.g. a nested RLS tenant discriminator) are part of
 * the key material — see the header note.
 */
export function buildCacheKey(
  sql: string,
  connectionId: string,
  orgId?: string,
  claims?: Readonly<Record<string, unknown>>,
): string {
  const parts = [
    sql.trim(),
    connectionId,
    orgId ?? "",
    claims ? canonicalize(claims) : "",
  ];
  const material = parts.join("\0");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(material);
  return hasher.digest("hex");
}
