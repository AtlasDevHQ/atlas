/**
 * Cache key generation for query result caching.
 *
 * Keys are SHA-256 hashes of the trimmed SQL + connectionId + orgId + claims.
 * This ensures org-scoped isolation by construction.
 */

/**
 * Build a deterministic cache key from query parameters.
 *
 * Includes orgId in the key material so different organizations never
 * share cached results, even for identical SQL.
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
    claims ? JSON.stringify(claims, Object.keys(claims).sort()) : "",
  ];
  const material = parts.join("\0");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(material);
  return hasher.digest("hex");
}
