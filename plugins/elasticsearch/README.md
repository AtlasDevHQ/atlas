# @useatlas/elasticsearch

Elasticsearch / OpenSearch datasource plugin for Atlas. A single unified plugin
that connects an Elasticsearch (and, in a later slice, OpenSearch) cluster as a
read-only Atlas datasource over a thin `fetch`-based HTTP client — no official
SDK dependency.

> **Status — connection + auth modes + engines + SQL & Query DSL surfaces + CLI
> mapping profiler.** This release ships the connection layer (an authenticated
> cluster-info/ping health check, ConnectionRegistry registration); **both
> engines** (Elasticsearch and OpenSearch — see [Engine selection](#engine-selection));
> **three auth modes** (API key / HTTP Basic / AWS SigV4 — see
> [Authentication](#authentication)), with an Elastic **Cloud ID** as an
> alternative connection target; **two query surfaces** — the **SQL surface**
> (tabular/aggregate questions via the standard `executeSQL` tool — see
> [SQL query surface](#sql-query-surface)) and the dedicated **Query DSL surface**
> (`queryElasticsearch` tool for full-text / relevance + deeply-nested
> aggregations — see [Query DSL surface](#query-dsl-surface)); and the
> **CLI semantic-layer profiler** (`atlas init` / `atlas diff` over index
> `_mapping`s — see [Semantic layer](#semantic-layer-atlas-init-and-atlas-diff)).
> See the [PRD (#3259)](https://github.com/AtlasDevHQ/atlas/issues/3259).

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

A connection needs an **endpoint** (`url` or `cloudId`), an **engine**
(auto-detected from the URL scheme, overridable), and **one auth mode**.

| Field         | Secret | Description                                                                 |
| ------------- | ------ | --------------------------------------------------------------------------- |
| `url`         | no     | `elasticsearch://host[:port][/prefix]` or `opensearch://host[:port][/prefix]`. HTTPS by default; `?ssl=false` → HTTP. Alternative to `cloudId`. |
| `cloudId`     | no     | Elastic **Cloud ID** (`<name>:<base64>`), decoded to the cluster endpoint. Alternative to `url`. |
| `engine`      | no     | `elasticsearch` \| `opensearch`. Overrides the engine inferred from the URL scheme. |
| `apiKey`      | yes    | API-key auth: Base64 key sent as `Authorization: ApiKey`. Encrypted at rest. |
| `username`    | no     | HTTP Basic username (pair with `password`).                                 |
| `password`    | yes    | HTTP Basic password. Encrypted at rest.                                      |
| `awsRegion`   | no     | AWS SigV4: region (e.g. `us-east-1`). **Setting this selects SigV4.**         |
| `awsAccessKeyId` | no  | AWS SigV4: access key id. Falls back to `AWS_ACCESS_KEY_ID`.                  |
| `awsSecretAccessKey` | yes | AWS SigV4: secret key. Falls back to `AWS_SECRET_ACCESS_KEY`. Encrypted at rest. |
| `awsSessionToken` | yes | AWS SigV4: session token. Falls back to `AWS_SESSION_TOKEN`. Encrypted at rest. |
| `awsService`  | no     | AWS SigV4: service code to sign with. Defaults to `es`.                       |
| `description` | no     | Optional. Surfaced to the agent in the system prompt.                        |

Every `secret: true` field is encrypted at rest (`encryptSecretFields`) and
masked in the admin UI. Secrets are never returned in plaintext: connection /
health / query errors are scrubbed (any literal secret is redacted and messages
tripping auth markers are collapsed) before they reach the agent, the user, or
logs. Credentials must **never** be placed in the URL — the parser rejects URL
userinfo and auth query params.

### Engine selection

The engine routes the SQL surface (`/_sql` for Elasticsearch, `/_plugins/_sql`
for OpenSearch). It is resolved with this **precedence**:

1. An explicit `engine` config field — wins over everything.
2. Otherwise the **URL scheme**: `elasticsearch://` → `elasticsearch`, `opensearch://` → `opensearch`.
3. Otherwise (a Cloud ID, no scheme) → `elasticsearch`.

```typescript
elasticsearchPlugin({ url: "opensearch://localhost:9200?ssl=false", apiKey: "…" }); // OpenSearch
elasticsearchPlugin({ url: "elasticsearch://host:9200", engine: "opensearch", apiKey: "…" }); // forced OpenSearch
```

### Authentication

Supply exactly one mode's fields. If more than one is present, the resolver
picks by a documented **precedence: AWS SigV4 → HTTP Basic → API key.**

```typescript
// API key
elasticsearchPlugin({ url: "elasticsearch://host:9243", apiKey: process.env.ES_API_KEY! });

// HTTP Basic
elasticsearchPlugin({
  url: "elasticsearch://logs.internal:9200?ssl=false",
  username: process.env.ES_USER!,
  password: process.env.ES_PASSWORD!,
});

// AWS SigV4 (Amazon OpenSearch Service) — explicit keys, or the ambient AWS env chain
elasticsearchPlugin({
  url: "opensearch://search-mydomain.us-east-1.es.amazonaws.com",
  awsRegion: "us-east-1",
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// Elastic Cloud ID + API key (or Basic)
elasticsearchPlugin({ cloudId: process.env.ES_CLOUD_ID!, apiKey: process.env.ES_API_KEY! });
```

AWS SigV4 signs every health/query request fresh (Signature Version 4) with the
configured region + service; credentials resolve from the explicit fields first,
else the ambient `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` environment variables. Cloud ID is decoded to the cluster's
HTTPS endpoint and combined with the chosen auth mode.

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

Ask a tabular or aggregate question over a single index in chat and the agent
answers it through the standard `executeSQL` tool — the same tool, the same
4-layer validation pipeline, as any SQL datasource. Under the hood the
connection's `query()` POSTs your statement to the engine's SQL API, follows the
response `cursor` across pages up to the row cap, and normalizes the result into
the Atlas `{ columns, rows }` shape. The endpoint + response shape are
engine-specific:

| Engine | Endpoint | Response shape |
| ------ | -------- | -------------- |
| Elasticsearch | `POST /_sql?format=json` | `{ columns, rows, cursor }` |
| OpenSearch | `POST /_plugins/_sql?format=jdbc` | `{ schema, datarows, cursor }` |

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

## Query DSL surface

Some questions don't fit SQL — full-text relevance ranking and deeply-nested
aggregations chief among them. For those the plugin registers a dedicated
`queryElasticsearch` agent tool (only in static-datasource mode; see
[Per-workspace mode](#per-workspace-saas-mode) below) that issues a **read-only**
Elasticsearch / OpenSearch Query DSL request and flattens the response into the
Atlas `{ columns, rows }` table shape.

```text
"Which products match 'wireless' best?"
  → POST /products/_search { "query": { "match": { "title": "wireless" } } }
  → a table of _id, _score, and the flattened _source fields, ranked by relevance

"Average price by category, top sellers first"
  → POST /products/_search { "size": 0, "aggs": { "by_category": { "terms": {...},
      "aggs": { "avg_price": { "avg": { "field": "price" } } } } } }
  → a table of category, doc_count, avg_price
```

The agent receives guidance on **when to prefer DSL over SQL**: full-text
(`match` / `multi_match` / `match_phrase` / `query_string` ranked by `_score`),
multi-level aggregations (`terms` within `terms`, `date_histogram` with
sub-aggregations, `percentiles`, `cardinality`), and geo / span / other DSL-only
queries. Ordinary tabular questions stay on SQL.

### Tool inputs

| Field | Required | Description |
| ----- | -------- | ----------- |
| `index` | yes | A single index / alias / data stream (or comma-separated list) **from the semantic layer**. Wildcards, `_all`, and system indices are rejected. |
| `endpoint` | no | `_search` (default) for hits/aggregations, or `_count` for a match count. |
| `body` | no | The Query DSL request body, e.g. `{"query": {...}}` or `{"size": 0, "aggs": {...}}`. Omit for a `match_all` search. |
| `explanation` | yes | A short rationale, surfaced in the result. |

### Read-only validator (default-deny)

The DSL surface is gated by a custom read-only validator — the security boundary.
**Default-deny**: anything not explicitly allowed is rejected. Only read endpoints
(`_search`, `_count`, `_msearch`, `_field_caps`, `_mapping`, read-only `_cat/*`)
are allowed; mutating/administrative endpoints, smuggled bulk-write actions,
mutating (`ctx`-referencing) scripts, and wildcard / `_all` / system-index targets
are all rejected. Per-index *membership* against the semantic-layer index list is
not yet enforced from the DSL tool (the SQL surface enforces the real whitelist via
the core pipeline) — tracked in
[#3307](https://github.com/AtlasDevHQ/atlas/issues/3307).

### Resource safeguards

Every DSL `_search` is bounded before it leaves Atlas: `size` is clamped to
`ATLAS_ROW_LIMIT` (an explicit `"size": 0` aggregation is preserved); a search
`timeout` of `ATLAS_QUERY_TIMEOUT` plus a hard client-side abort applies; and a
per-shard `terminate_after` (`ATLAS_ES_TERMINATE_AFTER`, default 100000, `0`
disables) is added **only** to non-aggregation searches so aggregate accuracy is
never compromised.

### Per-workspace (SaaS) mode

The dedicated `queryElasticsearch` tool is registered **only** for a static,
config-defined datasource. In adapter-only / SaaS per-workspace mode the
connection is queried over the SQL surface (`executeSQL`); per-workspace DSL
routing is a later slice (#3269/#3271).

## Security

- **Read-only — both surfaces.** Only `SELECT` reaches the cluster on the SQL
  surface, which goes through Atlas's standard 4-layer validation (regex DML/DDL
  guard → AST single-`SELECT` parse → index whitelist → auto-`LIMIT` + statement
  timeout), plus the ES-specific `SHOW`/`DESCRIBE` guard above (no custom SQL
  validator). The Query DSL surface is gated by its own **default-deny** read-only
  validator (read endpoints only, no smuggled writes, no mutating scripts, index
  rails) — see [Read-only validator](#read-only-validator-default-deny). The
  connection layer performs an authenticated cluster-info/ping round-trip and the
  `atlas init`/`diff` profiler issues only a read-only `GET /_mapping`.
- **Secrets encrypted at rest.** The `apiKey`, `password`, `awsSecretAccessKey`,
  and `awsSessionToken` fields are `secret: true` — encrypted via
  `encryptSecretFields` and masked in the admin UI. AWS SigV4 credentials for a
  DB-stored per-workspace datasource must be supplied explicitly; they never fall
  back to the operator's ambient AWS environment (only a self-hosted static
  `atlas.config.ts` datasource may use the ambient chain).
- **Secret-scrubbed errors.** Connection, health, query, and mapping errors are
  scrubbed before they reach the agent, the user, or logs: any literal secret is
  redacted and messages that trip auth-context markers are collapsed to a generic
  message (the detail stays in server logs). Query errors still surface the
  actionable engine reason (e.g. `Unknown column [foo]`) so the agent can
  self-correct.

## License

MIT
