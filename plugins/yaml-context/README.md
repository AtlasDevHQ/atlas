# @atlas/plugin-yaml-context

Reference implementation of an `AtlasContextPlugin` for the Atlas Plugin SDK.

Reads entity definitions, glossary terms, and metrics from YAML files on disk (the standard Atlas semantic layer format) and injects a structured overview into the agent system prompt.

## Usage

```typescript
// atlas.config.ts
import { defineConfig } from "@atlas/api/lib/config";
import { contextYamlPlugin } from "@atlas/plugin-yaml-context";

export default defineConfig({
  plugins: [
    contextYamlPlugin({ semanticDir: "./semantic" }),
  ],
});
```

## Config

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `semanticDir` | `string` | `./semantic` | Path to the semantic layer directory |

## What it does

On first context request, the plugin reads (and caches):

- `entities/*.yml` — table names, descriptions, and dimension counts
- `glossary.yml` — glossary terms (highlights ambiguous terms)
- `metrics/*.yml` — metric names and descriptions

It formats this into a structured context string that gets appended to the agent's system prompt, giving the agent an upfront overview of available data before it explores the semantic layer.

## Expected directory structure

```
semantic/
├── entities/
│   ├── companies.yml
│   └── people.yml
├── glossary.yml
└── metrics/
    └── companies.yml
```

## Health check

The `healthCheck()` method verifies:

1. The semantic directory exists
2. An `entities/` subdirectory exists within it
3. At least one `.yml` file is present in `entities/`

## Building your own ContextPlugin

Use this reference as a starting point. A `ContextPlugin` needs:

1. `id` — unique plugin identifier (required by `AtlasPluginBase`)
2. `version` — semver version string (required by `AtlasPluginBase`)
3. `type: "context"` — identifies the plugin type
4. `contextProvider.load()` — returns a string that gets appended to the agent system prompt
5. `contextProvider.refresh()` (optional) — clears the in-memory cache so the next `load()` re-reads from disk

```typescript
import { definePlugin } from "@useatlas/plugin-sdk";
import type { AtlasContextPlugin } from "@useatlas/plugin-sdk";

export default definePlugin({
  id: "my-context",
  type: "context",
  version: "1.0.0",
  name: "My Custom Context",
  contextProvider: {
    async load() {
      return "## My Custom Context\n\nExtra information for the agent...";
    },
  },
} satisfies AtlasContextPlugin);
```
