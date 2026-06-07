# @useatlas/elasticsearch

Elasticsearch / OpenSearch datasource plugin for Atlas. A single unified plugin
that connects an Elasticsearch (and, in a later slice, OpenSearch) cluster as a
read-only Atlas datasource over a thin `fetch`-based HTTP client — no official
SDK dependency.

> **Status — connection + mapping profiler.** This release ships the connection
> layer (`elasticsearch://` URL + **API-key** auth parsing, an authenticated
> cluster-info/ping health check, ConnectionRegistry registration) and the
> CLI semantic-layer profiler (`atlas init` / `atlas diff` over index
> `_mapping`s — see [Semantic layer](#semantic-layer-atlas-init-and-atlas-diff)). The
> query surfaces (SQL via `executeSQL` and a dedicated Query DSL tool), the
> remaining auth modes (Basic / Cloud ID / AWS SigV4), and the OpenSearch engine
> arrive in later slices. See the
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
Dot-prefixed system indices (`.kibana`, `.security`) are skipped. Once the query
surface lands (#3262), the generated entities are queryable by the agent over
Elasticsearch SQL; the `table:` field is the raw index name (the SQL whitelist +
`FROM` qualifier).

## Security

- **Read-only.** The connection layer performs an authenticated
  cluster-info/ping round-trip; the profiler issues a read-only `GET /_mapping`.
  Query surfaces (added later) are read-only by design.
- **Secret-scrubbed errors.** Connection/health errors are scrubbed before they
  reach the agent, the user, or logs: the literal API key is redacted and
  messages that trip auth-context markers are collapsed to a generic message
  (the detail stays in server logs).

## License

MIT
