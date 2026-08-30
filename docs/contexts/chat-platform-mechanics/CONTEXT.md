# Chat Platform mechanics

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Chat Platform mechanics` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


These four terms are distinct and frequently confused. Pin them.

- **Chat Platform** — see [Pillars](../pillars/CONTEXT.md). Slack-shaped surfaces only (Slack, Teams, Discord, Google Chat, Telegram, WhatsApp).
- **Adapter** — the Atlas-side code under `plugins/chat/src/adapters/<platform>.ts` that translates Chat Platform events into the chat-SDK's neutral shape. One adapter per Chat Platform. Lives in the `@useatlas/chat` plugin.
- **App Registration** — the operator's developer-portal record with a Chat Platform vendor (e.g. "Atlas" as a Slack App in the Slack API console). Carries the `client_id` / `client_secret` / redirect URIs / event-subscription endpoints. **One per Chat Platform per Atlas deployment.** A SaaS operator runs one App Registration per supported Chat Platform; a self-host operator can run their own. Action Targets may also have App Registrations (e.g. a GitHub App), but the term originated and is most load-bearing for the chat pillar.
- **Workspace Connection** — the OAuth-completed link between a single customer Workspace and a single Chat Platform, holding the customer's per-workspace bot token in the chat-SDK's state store (`chat_cache:slack:installation:<teamId>` and equivalents). One per (Workspace × Chat Platform) pair. **Chat-pillar specific** — Action Target installs persist credentials elsewhere (see `db/secret-encryption.ts`) and are described as **Workspace Installs**, not Workspace Connections.

### Cardinality

- App Registrations: `Chat Platform → 1` per deployment (operator-owned)
- Workspace Connections: `(Workspace, Chat Platform) → 1` (customer-owned, OAuth-completed)
- Adapters in code: `Chat Platform → 1` per Atlas codebase (always present, conditionally activated)

### Anti-confusions

- "Slack integration" is ambiguous — disambiguate to App Registration (operator-side), Adapter (code), or Workspace Connection (customer-side).
- "Adapter is enabled" is ambiguous — say either "Adapter has credentials wired" (deploy-level, operator-controlled) or "Workspace Connection exists" (workspace-level, customer-controlled).
