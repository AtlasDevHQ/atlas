# create-atlas-agent

Scaffold a new [Atlas](https://github.com/msywu/data-agent) text-to-SQL agent project.

## Usage

```bash
bun create atlas-agent my-app
cd my-app
bun run dev
```

The interactive setup asks for your database (SQLite or PostgreSQL), LLM provider, and API key. SQLite is the default — zero setup, no Docker required.

### Non-interactive mode

Skip all prompts with sensible defaults (SQLite + Anthropic + demo data):

```bash
bun create atlas-agent my-app --defaults
```

## Requirements

- [Bun](https://bun.sh/) v1.3+
- An LLM API key (Anthropic, OpenAI, or another supported provider)

## What you get

A self-contained Next.js 16 project with:

- Text-to-SQL agent with multi-layer SQL validation
- Auto-generated semantic layer (YAML) from your database schema
- Chat UI with streaming responses
- Docker, Railway, Fly.io, Render, and Vercel deployment configs
- SQLite (default) or PostgreSQL support

## Local development

To test changes to the scaffolding CLI from the repo root:

```bash
# Refresh template files from the repo
cd create-atlas && bun run prepublishOnly && cd ..

# Test interactive mode
bun create-atlas/index.ts test-app

# Test non-interactive mode
bun create-atlas/index.ts test-app --defaults
```

## Publishing

```bash
cd create-atlas
bun run prepublishOnly    # Copies src/, bin/, data/, docs/deploy.md into template/
bun publish --access public
```

After publishing, verify from the registry:

```bash
bun create atlas-agent verify-test --defaults
```

## License

MIT
