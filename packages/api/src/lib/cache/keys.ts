/**
 * Cache key generation for query result caching.
 *
 * Keys are SHA-256 hashes of the trimmed SQL + connectionId + orgId + claims +
 * the resolved RLS configuration. Governance principle: the key captures EVERY
 * input that determined the entry's rows (ADR-0033) — so any change to a
 * row-determining input makes pre-change entries unreachable *by construction*,
 * with no flush choreography to remember.
 *
 * Why RLS config is in the key (ADR-0033, closes audit H3): RLS is injected
 * into the SQL and the DB filters rows before the entry exists, so the cached
 * rows are already RLS-shaped at write time. If the resolved RLS configuration
 * later changes (an admin enabling or tightening a policy via the SaaS settings
 * overlay, or an env/config change on restart), rows cached under the OLD
 * policy would keep serving up to TTL. Folding the resolved RLS config into the
 * key means the post-change request hashes to a different key — an instant miss
 * that re-executes under the new policy. The RLS config the caller passes is the
 * *resolved effective* config (post-settings-overlay), the same one the RLS
 * injector applies, so advertised == enforced by construction.
 *
 * Isolation invariant: two requests share a cache entry only when *all* key
 * components match. `orgId` contributes to the key, but it is NOT the sole
 * discriminator — it may be undefined (auth mode "none", or claims-only tenancy
 * where the tenant lives inside `claims`), so isolation cannot rely on orgId
 * "by construction". The claims serialization below therefore has to be
 * faithful: the RLS discriminator may sit at a nested claim path
 * (`resolveClaimPath` dot-paths, `lib/rls.ts`), and if the serialization drops
 * nested values two users collide on one key and one is served the other's
 * RLS-filtered rows for the cache TTL. That is why claims are canonicalized
 * recursively rather than with a top-level replacer array.
 *
 * L9 invariant (audit L9 — the no-org/no-claims key collapse): when BOTH
 * `orgId` and `claims` are absent, an entry is isolated solely by
 * `connectionId` (plus SQL and the RLS fingerprint). This is correct ONLY
 * because absent-org AND absent-claims is a single-tenant-per-connection
 * deployment (auth mode "none" / no claims-based tenancy): every request to
 * that connection is the same principal by definition, so sharing one entry
 * across them serves each caller its own tenant's rows. The invariant a
 * deployment must uphold: any per-tenant discriminator MUST reach the key
 * through `orgId` or `claims` — never left implicit on the connection — or
 * entries collapse across tenants. A connection that fans out to multiple
 * tenants without surfacing a discriminator would violate this; the whitelist
 * + RLS layers, not the cache, are what make that configuration impossible.
 */

/**
 * Deep, order-insensitive canonical serialization of a value.
 *
 * Sorts object keys at *every* nesting level so key stability across
 * property-insertion order is preserved, while every nested value stays part of
 * the output. A `JSON.stringify` replacer array cannot be used here: it applies
 * the top-level key whitelist at every depth, so a nested object like
 * `{ app_metadata: { org_id: "org-42" } }` serializes to `{"app_metadata":{}}`
 * and the discriminating value is erased (see the header note).
 *
 * Arrays preserve order (position is semantically meaningful); objects sort by
 * key. Primitives round-trip through `JSON.stringify`. Used for both the claims
 * blob and the resolved RLS config fingerprint.
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
 * Build a deterministic cache key from every row-determining input (ADR-0033).
 *
 * Includes orgId in the key material so different organizations never share
 * cached results, even for identical SQL. Claims are deep-canonicalized so
 * nested claim values (e.g. a nested RLS tenant discriminator) are part of the
 * key material — see the header note. The resolved RLS config is deep-
 * canonicalized too, so enabling/tightening RLS orphans every pre-change entry
 * by construction (closes audit H3).
 *
 * @param resolvedRlsConfig The *effective* RLS configuration that governs this
 *   query's rows (post-settings-overlay), or `undefined` when RLS is not
 *   applied. Passing the resolved config — not the raw boot config — is what
 *   keeps the fingerprint aligned with what the RLS injector actually enforces.
 */
export function buildCacheKey(
  sql: string,
  connectionId: string,
  orgId?: string,
  claims?: Readonly<Record<string, unknown>>,
  resolvedRlsConfig?: unknown,
): string {
  const parts = [
    sql.trim(),
    connectionId,
    orgId ?? "",
    claims ? canonicalize(claims) : "",
    resolvedRlsConfig === undefined ? "" : canonicalize(resolvedRlsConfig),
  ];
  const material = parts.join("\0");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(material);
  return hasher.digest("hex");
}
