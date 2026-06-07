-- 0125_elasticsearch_auth_modes_config_schema.sql
--
-- v0.0.13 (#3263/#3264/#3265/#3266 / milestone #63) — extend the built-in
-- Elasticsearch / OpenSearch datasource catalog row's `config_schema` to cover
-- the three auth modes (API key / HTTP Basic / AWS SigV4) and the engine select
-- added by the auth + engine slices.
--
-- Why a separate migration (not an edit to 0123): migrations are immutable, and
-- the boot-time seed (`seed-builtin-datasource-catalog.ts`) inserts ON CONFLICT
-- DO NOTHING — so it never *updates* a row that already exists. Migration 0123
-- inserted the original 3-field schema (url / apiKey / description) on every
-- deploy that ran before this slice; this migration UPDATEs that row in place so
-- existing deploys' admin install form shows the new auth fields and the
-- form-install handler (`ElasticsearchFormInstallHandler`) encrypts the new
-- `secret: true` fields (`password`, `awsSecretAccessKey`, `awsSessionToken`).
-- The handler is schema-driven, so it picks the fields up with no code change.
--
-- Fresh deploys: 0123 inserts the 3-field schema, then THIS migration updates it
-- to the full set, then the seed pass is a no-op (row exists). The seed's
-- `BUILTIN_DATASOURCE_CATALOG_ROWS` elasticsearch row mirrors this exact schema
-- (the current desired state, used only for a delete-and-self-heal re-insert).
--
-- `config_schema` mirrors the plugin's `getConfigSchema()`
-- (plugins/elasticsearch/src/index.ts). The four `secret: true` fields drive
-- `plugins/secrets.ts::encryptSecretFields`. Cloud ID is intentionally not a form
-- field — it is an `atlas.config.ts` convenience.
--
-- Idempotent: a plain UPDATE keyed on the slug. Re-runs and re-deploys converge
-- on the same JSONB. A no-op (0 rows) if the row was deleted out-of-band — the
-- boot seed re-inserts it with the same schema.

UPDATE plugin_catalog
   SET config_schema = '[
         {"key": "url", "type": "string", "label": "Connection URL", "required": true, "description": "elasticsearch://host:9200 or opensearch://host:9200 — HTTPS by default; append ?ssl=false for a plaintext local cluster."},
         {"key": "engine", "type": "select", "label": "Engine", "options": ["elasticsearch", "opensearch"], "description": "Optional. Overrides the engine inferred from the URL scheme (defaults to elasticsearch)."},
         {"key": "apiKey", "type": "string", "label": "API Key", "secret": true, "description": "API-key auth: Base64-encoded API key, sent as `Authorization: ApiKey`. Encrypted at rest."},
         {"key": "username", "type": "string", "label": "Username", "description": "HTTP Basic auth: username (pair with Password)."},
         {"key": "password", "type": "string", "label": "Password", "secret": true, "description": "HTTP Basic auth: password. Encrypted at rest."},
         {"key": "awsRegion", "type": "string", "label": "AWS Region", "description": "AWS SigV4 (Amazon OpenSearch Service): region, e.g. us-east-1. Setting this selects SigV4 signing."},
         {"key": "awsAccessKeyId", "type": "string", "label": "AWS Access Key ID", "description": "AWS SigV4: access key id. Optional — falls back to the AWS_ACCESS_KEY_ID environment variable."},
         {"key": "awsSecretAccessKey", "type": "string", "label": "AWS Secret Access Key", "secret": true, "description": "AWS SigV4: secret access key. Optional — falls back to AWS_SECRET_ACCESS_KEY. Encrypted at rest."},
         {"key": "awsSessionToken", "type": "string", "label": "AWS Session Token", "secret": true, "description": "AWS SigV4: session token for temporary credentials. Optional — falls back to AWS_SESSION_TOKEN. Encrypted at rest."},
         {"key": "awsService", "type": "string", "label": "AWS Service", "description": "AWS SigV4: service code to sign with. Defaults to `es`."},
         {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown in the agent system prompt."}
       ]'::jsonb,
       updated_at = NOW()
 WHERE slug = 'elasticsearch';
