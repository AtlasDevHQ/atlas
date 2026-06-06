# @useatlas/elasticsearch

Elasticsearch / OpenSearch datasource plugin for Atlas. A single unified plugin
that connects an Elasticsearch (and, in a later slice, OpenSearch) cluster as a
read-only Atlas datasource over a thin `fetch`-based HTTP client — no official
SDK dependency.

> **Status — connection foundation only.** This release ships the connection
> layer: `elasticsearch://` URL + **API-key** auth parsing, an authenticated
> cluster-info/ping health check, and ConnectionRegistry registration. The query
> surfaces (SQL via `executeSQL` and a dedicated Query DSL tool), the remaining
> auth modes (Basic / Cloud ID / AWS SigV4), the OpenSearch engine, and
> `atlas init` mapping profiling arrive in later slices. See the
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

## Security

- **Read-only.** This foundation slice performs only an authenticated
  cluster-info/ping round-trip. Query surfaces (added later) are read-only by
  design.
- **Secret-scrubbed errors.** Connection/health errors are scrubbed before they
  reach the agent, the user, or logs: the literal API key is redacted and
  messages that trip auth-context markers are collapsed to a generic message
  (the detail stays in server logs).

## License

MIT
