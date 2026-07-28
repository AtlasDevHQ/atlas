---
paths:
  - "plugins/**"
  - "packages/api/src/lib/slack/**"
  - "packages/api/src/lib/integrations/install/**"
---

# Plugin and chat-adapter contract

- [ ] **Update the chat-plugin × Atlas contract doc when the boundary changes** — Any PR that adds/removes/reshapes a field at the `@useatlas/chat` / `@chat-adapter/*` boundary updates the table in [docs/architecture/chat-plugin-atlas-contract.md](docs/architecture/chat-plugin-atlas-contract.md) in the same commit. Before a PR touching `plugins/chat/src/`, `packages/api/src/lib/slack/`, or `packages/api/src/lib/integrations/install/*-oauth-handler.ts`, diff the contract table; open ⚠ rows block milestone closeout
