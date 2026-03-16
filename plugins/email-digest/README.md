# @useatlas/email-digest

Atlas email digest plugin for scheduled metric summary subscriptions.

Users subscribe to metric digests with configurable frequency (daily/weekly). The plugin provides API routes for subscription management and generates formatted HTML digest emails with metric results, trend indicators, and data tables.

## Installation

```bash
bun add @useatlas/email-digest
```

## Configuration

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { emailDigestPlugin } from "@useatlas/email-digest";

export default defineConfig({
  plugins: [
    emailDigestPlugin({
      from: "Atlas <digest@myco.com>",
      transport: "sendgrid",
      apiKey: process.env.SENDGRID_API_KEY!,
      executeMetric: async (metricName) => {
        // Run the metric query via Atlas agent
        return { name: metricName, value: 42 };
      },
    }),
  ],
});
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/digest/subscriptions` | List current user's subscriptions |
| `POST` | `/digest/subscriptions` | Create a new subscription |
| `PUT` | `/digest/subscriptions/:id` | Update a subscription |
| `DELETE` | `/digest/subscriptions/:id` | Cancel a subscription |

## Documentation

See [docs.useatlas.dev/plugins/interactions/email-digest](https://docs.useatlas.dev/plugins/interactions/email-digest) for full documentation.

## License

MIT
