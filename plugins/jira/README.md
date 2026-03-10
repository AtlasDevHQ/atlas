# @useatlas/jira

Create JIRA tickets from Atlas analysis findings with manual approval.

## Install

```bash
bun add @useatlas/jira
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { jiraPlugin } from "@useatlas/jira";

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

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/docs/plugins/authoring-guide)
