# @useatlas/bigquery

Google BigQuery datasource plugin for Atlas.

## Install

```bash
bun add @useatlas/bigquery @google-cloud/bigquery
```

## Usage

```typescript
// atlas.config.ts
import { defineConfig } from "@atlas/api/lib/config";
import { bigqueryPlugin } from "@useatlas/bigquery";

export default defineConfig({
  plugins: [
    bigqueryPlugin({
      projectId: process.env.GCP_PROJECT_ID!,
      dataset: "analytics",
      location: "US",
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    }),
  ],
});
```

## Configuration

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `projectId` | `string` | No | from credentials/ADC | GCP project ID |
| `dataset` | `string` | No | — | Default dataset for unqualified table references |
| `location` | `string` | No | — | Geographic location for query jobs (e.g. `US`, `EU`) |
| `keyFilename` | `string` | No | — | Path to service account JSON key file |
| `credentials` | `object` | No | — | Service account credentials object (parsed JSON key) |

### Authentication

The plugin supports three authentication methods (in priority order):

1. **Credentials object** — pass the parsed service account JSON key directly
2. **Key file** — path to a service account JSON key file via `keyFilename`
3. **Application Default Credentials** — automatic in GCP environments (GCE, Cloud Run, GKE)

## References

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/overview)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
