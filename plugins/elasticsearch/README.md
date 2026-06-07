# @useatlas/elasticsearch

Elasticsearch / OpenSearch datasource plugin for Atlas. A single unified plugin
that connects an Elasticsearch (and, in a later slice, OpenSearch) cluster as a
read-only Atlas datasource over a thin `fetch`-based HTTP client — no official
SDK dependency.

> **Status — connection + SQL query surface + CLI mapping profiler.** This
> release ships the connection layer (`elasticsearch://` URL + **API-key** auth,
> an authenticated cluster-info/ping health check, ConnectionRegistry
> registration), the **SQL query surface** (tabular/aggregate questions over a
> single index via the standard `executeSQL` tool — see
> [SQL query surface](#sql-query-surface)), and the **CLI semantic-layer
> profiler** (`atlas init` / `atlas diff` over index `_mapping`s — see
> [Semantic layer](#semantic-layer-atlas-init-and-atlas-diff)). The dedicated
> Query DSL tool, the remaining auth modes (Basic / Cloud ID / AWS SigV4), and
> the OpenSearch engine arrive in later slices. See the
> [PRD (#3259)](https://github.com/AtlasDevHQ/atlas/issues/3259).

## Install

```bash
bun add @useatlas/elasticsearch
```

No official Elasticsearch/OpenSearch SDK is required — the connector talks to the
cluster's read endpoints over `fetch`.

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { elasticsearchPlugin } from "@useatlas/elasticsearch";

export default defineConfig({
  plugins: [
    elasticsearchPlugin({
      // Elastic Cloud is HTTPS by default. Append `?ssl=false` for a plaintext
      // local cluster, e.g. `elasticsearch://localhost:9200?ssl=false`.
      url: "elasticsearch://my-deployment.es.us-east-1.aws.found.io:9243",
      apiKey: process.env.ES_API_KEY!,
    }),
  ],
});
```

## Configuration

| Field         | Required | Secret | Description                                                                 |
| ------------- | -------- | ------ | --------------------------------------------------------------------------- |
| `url`         | yes      | no     | `elasticsearch://host[:port][/prefix]`. HTTPS by default; `?ssl=false` → HTTP. |
| `apiKey`      | yes      | yes    | Base64-encoded API key sent as `Authorization: ApiKey <key>`. Encrypted at rest. |
| `description` | no       | no     | Optional. Surfaced to the agent in the system prompt.                       |

The `apiKey` field is marked `secret: true` so Atlas encrypts it at rest and
masks it in the admin UI. It is not returned in plaintext: connection/health
errors are scrubbed (the literal key is redacted and messages tripping auth
markers are collapsed) before they reach the agent, the user, or logs.

## Semantic layer (`atlas init` and `atlas diff`)

Atlas profiles an Elasticsearch cluster into the semantic layer straight from
index `_mapping`s — there is no SQL schema to introspect, so each index becomes
an entity and each mapped field becomes a dimension.

Because the API key is **not** carried in the `elasticsearch://` URL (the URL
parser rejects credentials), the CLI reads it from `ATLAS_ES_API_KEY`:

```bash
export ATLAS_DATASOURCE_URL="elasticsearch://my-cluster.es.io:9243"
export ATLAS_ES_API_KEY="<base64-api-key>"

# Profile every (non-system) index into semantic/entities/*.yml
bun run atlas -- init

# Limit to specific indices
bun run atlas -- init --tables products,customers

# Report drift between the live mappings and the on-disk semantic layer
bun run atlas -- diff
```

Mapping → entity rules:

| Mapping shape | Result |
| ------------- | ------ |
| scalar (`keyword`, `long`, `boolean`, …) | one dimension at the field path |
| `date` / `date_nanos` | dimension typed `timestamp` |
| object (`properties`) | dotted child dimensions (`vendor.name`); no dimension for the container |
| `nested` object | dotted child dimensions, flagged `nested: true` (array semantics) |
| multi-field (`fields`) | the main field **plus** each sub-field (`title.keyword`), flagged `multi_field: true` |

Numeric ES types map to `number`, string-like types (`text`, `keyword`, `ip`, …)
and unsupported types (`geo_point`, `dense_vector`, …) map to `string`.
Dot-prefixed system indices (`.kibana`, `.security`) are skipped. The generated
entities are queryable by the agent over the [SQL query surface](#sql-query-surface);
the `table:` field is the raw index name (the SQL whitelist + `FROM` qualifier).

## SQL query surface

Ask a tabular or aggregate question over a single Elasticsearch index in chat and
the agent answers it through the standard `executeSQL` tool — the same tool, the
same 4-layer validation pipeline, as any SQL datasource. Under the hood the
connection's `query()` POSTs your statement to the cluster SQL API
(`POST /_sql?format=json`), follows the response `cursor` across pages up to the
row cap, and normalizes ES SQL's `{ columns:[{name,type}], rows:[[…]] }` into the
Atlas `{ columns, rows }` shape.

```text
"How many orders per status?"
  → SELECT status, COUNT(*) AS n FROM orders GROUP BY status
  → a table of statuses and counts
```

### Supported SQL subset

ES SQL **is** standard SQL, so it rides the unmodified Atlas pipeline. The plugin
declares `parserDialect: "PostgresQL"` (no custom validator) — verified against
`node-sql-parser` 5.4.0, PostgreSQL mode cleanly parses the documented subset and
PostgreSQL's double-quoted identifier quoting matches ES SQL's index-name quoting
(MySQL mode would expect backticks).

| Supported                                                                 | Notes |
| ------------------------------------------------------------------------- | ----- |
| `SELECT` projection / `SELECT *`                                          | Read-only — the pipeline rejects everything that isn't a single `SELECT`. |
| `FROM <index>` (one index per query)                                      | Each index is a table. Quote names with `-`, `.`, `:` in double quotes: `FROM "logs-2024.01.01"`. **No JOINs across indices.** |
| `WHERE` with `=`,`<`,`>`,`IN`,`BETWEEN`,`LIKE`,`IS NULL`                  | Standard predicates. |
| `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`                                  | `LIMIT` is auto-appended by Atlas (`ATLAS_ROW_LIMIT`, default 1000) if you omit it. |
| `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `COUNT(DISTINCT …)`                   | Aggregates. |
| Nested fields by dotted path (`geo.dest`)                                  | Addressed like a column. |

Beyond the base DML/DDL guard, the connection adds ES-specific
`forbiddenPatterns` that block the catalog/schema-disclosure verbs `SHOW …` and
`DESCRIBE …` (they enumerate every index/field and so bypass the index
whitelist). These are anchored to the statement start, so a field literally named
`show` or `description` mid-query is unaffected, and `ORDER BY … DESC` is fine.

> **Row cap.** The authoritative cap is the `LIMIT` Atlas appends
> (`ATLAS_ROW_LIMIT`). The connector also enforces a defensive client-side
> ceiling (10,000 rows) as a runaway-cursor backstop; if it ever truncates, it
> logs a warning rather than silently dropping rows.

## Security

- **Read-only.** Only `SELECT` reaches the cluster. The SQL surface goes through
  Atlas's standard 4-layer validation (regex DML/DDL guard → AST single-`SELECT`
  parse → index whitelist → auto-`LIMIT` + statement timeout), plus the
  ES-specific `SHOW`/`DESCRIBE` guard above. The plugin sets **no** custom
  validator, so this pipeline applies unchanged. The connection layer performs an
  authenticated cluster-info/ping round-trip and the `atlas init`/`diff` profiler
  issues only a read-only `GET /_mapping`.
- **Secret-scrubbed errors.** Connection, health, query, and mapping errors are
  scrubbed before they reach the agent, the user, or logs: the literal API key is
  redacted and messages that trip auth-context markers are collapsed to a generic
  message (the detail stays in server logs). Query errors still surface the
  actionable ES reason (e.g. `Unknown column [foo]`) so the agent can self-correct.

## License

MIT
