-- Consolidate the `__demo__` connection under org_id = '__global__'.
--
-- Before this migration each workspace that completed onboarding owned its
-- own `__demo__` row. Combined with the platform_admin visibility bypass,
-- workspaces saw other tenants' demo connections in their admin
-- connections list — see #2303. After this migration `__demo__`
-- lives once at org_id = '__global__' and is surfaced to every org by the
-- updated `getVisibleConnectionIds` global-fallback rule.
--
-- Semantic entities attached to `__demo__` are migrated alongside so the
-- entity shape stays paired with the connection. The unique constraint
-- (org_id, entity_type, name, COALESCE(connection_id, '__default__')) is
-- not at risk because no rows exist at org_id = '__global__' today.

-- 1. Promote the most-recently-touched per-org __demo__ row to __global__.
WITH chosen AS (
  SELECT id, url, url_key_version, type, description, schema_name, status
  FROM connections
  WHERE id = '__demo__' AND org_id <> '__global__'
  ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
  LIMIT 1
)
INSERT INTO connections (id, url, url_key_version, type, description, schema_name, org_id, status, created_at, updated_at)
SELECT id, url, url_key_version, type, description, schema_name, '__global__', status, NOW(), NOW()
FROM chosen
ON CONFLICT (id, org_id) DO NOTHING;

-- 2. Re-scope semantic entities attached to `__demo__` to the global org.
UPDATE semantic_entities
SET org_id = '__global__', updated_at = NOW()
WHERE connection_id = '__demo__' AND org_id <> '__global__';

-- 3. Drop the now-redundant per-org `__demo__` connection rows.
DELETE FROM connections WHERE id = '__demo__' AND org_id <> '__global__';
