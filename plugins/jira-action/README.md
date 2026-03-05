# @atlas/plugin-jira-action

Create JIRA tickets from Atlas analysis findings with manual approval.

## Install

```json
{
  "dependencies": { "@useatlas/plugin-sdk": "workspace:*" },
  "peerDependencies": { "ai": "^6.0.0", "zod": "^4.0.0" }
}
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { jiraPlugin } from "@atlas/plugin-jira-action";

export default defineConfig({
  plugins: [
    jiraPlugin({
      host: "https://myco.atlassian.net",
      email: "bot@myco.com",
      apiToken: process.env.JIRA_API_TOKEN!,
      projectKey: "ENG",
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | `string` | — | JIRA instance URL |
| `email` | `string` | — | Email for Basic auth |
| `apiToken` | `string` | — | JIRA API token |
| `projectKey` | `string` | — | Default project key (uppercase, e.g. `ENG`) |
| `labels` | `string[]?` | — | Labels applied to every created issue |

## Reference

- [Plugin SDK docs](../../packages/plugin-sdk/README.md)
- [Authoring guide](../../docs/guides/plugin-authoring-guide.md)
