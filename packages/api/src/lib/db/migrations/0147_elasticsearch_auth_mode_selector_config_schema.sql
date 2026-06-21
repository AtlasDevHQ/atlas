-- 0147_elasticsearch_auth_mode_selector_config_schema.sql
--
-- Progressive-disclosure pass on the built-in Elasticsearch / OpenSearch
-- datasource catalog row. Replaces the flat 11-field schema (every auth mode's
-- fields shown at once) from 0125 with an `authMode` selector plus `showWhen`-
-- gated fields, so the admin install form reveals only the credentials for the
-- chosen mode. Adds an explicit `none` mode for security-disabled clusters
-- (the plugin's resolver now honors `authMode: "none"`).
--
-- Why a separate migration (not an edit to 0125): migrations are immutable, and
-- the boot seed inserts ON CONFLICT DO NOTHING (never UPDATEs an existing row).
-- This UPDATE converges existing deploys' catalog row to the new schema; fresh
-- deploys run 0123 (insert) -> 0125 (full set) -> this (selector form), then the
-- boot seed is a no-op. `seed-builtin-datasource-catalog.ts`'s elasticsearch
-- row mirrors this exact JSON for the delete-and-self-heal re-insert path.
--
-- `config_schema` mirrors the plugin's `getConfigSchema()`
-- (plugins/elasticsearch/src/index.ts). The four `secret: true` fields
-- (apiKey / password / awsSecretAccessKey / awsSessionToken) still drive
-- `plugins/secrets.ts::encryptSecretFields`.
--
-- Idempotent: a plain UPDATE keyed on the slug. A no-op (0 rows) if the row was
-- deleted out-of-band — the boot seed re-inserts it with the same schema.

UPDATE plugin_catalog
   SET config_schema = '[
         {"key": "url", "type": "string", "label": "Connection URL", "required": true, "description": "elasticsearch://host:9200 or opensearch://host:9200. HTTPS by default; append ?ssl=false for a plaintext cluster."},
         {"key": "authMode", "type": "select", "label": "Authentication", "required": true, "default": "basic", "options": [{"value": "basic", "label": "Username & password"}, {"value": "apiKey", "label": "API key"}, {"value": "sigv4", "label": "AWS SigV4"}, {"value": "none", "label": "None (no auth)"}], "description": "How Atlas authenticates to the cluster."},
         {"key": "username", "type": "string", "label": "Username", "required": true, "showWhen": {"field": "authMode", "equals": ["basic"]}, "description": "Cluster username."},
         {"key": "password", "type": "string", "label": "Password", "required": true, "secret": true, "showWhen": {"field": "authMode", "equals": ["basic"]}, "description": "Cluster password. Encrypted at rest."},
         {"key": "apiKey", "type": "string", "label": "API key", "required": true, "secret": true, "showWhen": {"field": "authMode", "equals": ["apiKey"]}, "description": "Base64-encoded API key, sent as `Authorization: ApiKey`. Encrypted at rest."},
         {"key": "awsRegion", "type": "string", "label": "AWS region", "required": true, "showWhen": {"field": "authMode", "equals": ["sigv4"]}, "description": "Region of the Amazon OpenSearch domain, e.g. us-east-1."},
         {"key": "awsAccessKeyId", "type": "string", "label": "AWS access key ID", "showWhen": {"field": "authMode", "equals": ["sigv4"]}, "description": "Optional. Falls back to the AWS_ACCESS_KEY_ID environment variable."},
         {"key": "awsSecretAccessKey", "type": "string", "label": "AWS secret access key", "secret": true, "showWhen": {"field": "authMode", "equals": ["sigv4"]}, "description": "Optional. Falls back to AWS_SECRET_ACCESS_KEY. Encrypted at rest."},
         {"key": "awsSessionToken", "type": "string", "label": "AWS session token", "secret": true, "showWhen": {"field": "authMode", "equals": ["sigv4"]}, "description": "Optional, for temporary credentials. Falls back to AWS_SESSION_TOKEN. Encrypted at rest."},
         {"key": "awsService", "type": "string", "label": "AWS service", "showWhen": {"field": "authMode", "equals": ["sigv4"]}, "description": "Service code to sign with. Defaults to `es`."},
         {"key": "engine", "type": "select", "label": "Engine", "options": [{"value": "elasticsearch", "label": "Elasticsearch"}, {"value": "opensearch", "label": "OpenSearch"}], "description": "Auto-detected from the URL scheme. Override only if the cluster reports otherwise."},
         {"key": "description", "type": "string", "label": "Description", "description": "Optional. Shown to the agent in its system prompt."}
       ]'::jsonb,
       updated_at = NOW()
 WHERE slug = 'elasticsearch';
