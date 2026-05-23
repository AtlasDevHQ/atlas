# @useatlas/obsidian-reader

Read-only Obsidian vault reader — connects Atlas to a user's Obsidian
vault via the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api).

## Prerequisites

1. Install the **Local REST API** plugin in Obsidian: Settings → Community
   plugins → Browse → "Local REST API".
2. Enable it and copy the API key from its settings tab.
3. Note the listen URL — defaults to `http://127.0.0.1:27123`.

## Install

```bash
bun add @useatlas/obsidian-reader
```

## Usage

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { obsidianReaderPlugin } from "@useatlas/obsidian-reader";

export default defineConfig({
  plugins: [
    obsidianReaderPlugin({
      api_url: "http://127.0.0.1:27123",
      api_key: process.env.OBSIDIAN_API_KEY!,
    }),
  ],
});
```

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `api_url` | `string?` | `http://127.0.0.1:27123` | Base URL of the REST API plugin |
| `api_key` | `string` | — | Bearer token from the REST API plugin settings |

## Reference

- [Plugin SDK docs](https://docs.useatlas.dev/plugins/sdk)
- [Authoring guide](https://docs.useatlas.dev/plugins/authoring-guide)
- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
