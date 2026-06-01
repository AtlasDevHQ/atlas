# Atlas Roadmap

> Public repo: [AtlasDevHQ/atlas](https://github.com/AtlasDevHQ/atlas). Tracking lives in [GitHub Issues](https://github.com/AtlasDevHQ/atlas/issues) and [Milestones](https://github.com/AtlasDevHQ/atlas/milestones).
>
> **How this file is organized:** Tag-shaped per [ADR-0009](../../docs/adr/0009-tag-organized-roadmap.md). The current in-flight tag lives in `## Next`; lightweight forward-look lives in `## Planned tags`; shipped milestones live in [`ROADMAP-archive.md`](./ROADMAP-archive.md).
>
> **Versioning:** Git tags gate prod deploys ([ADR-0008](../../docs/adr/0008-versioning-and-release-tags.md)). The tag train starts at `v0.0.1` — a pre-launch development train, cut once the release-process bundle is ready. `v0.1.0` is reserved for the public launch (target July 2026, [#2919](https://github.com/AtlasDevHQ/atlas/issues/2919)). The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is **not** the future git tag `v1.0.0` — that's reserved for frozen REST + MCP + plugin SDK contracts.

---

## Today

Atlas is a deploy-anywhere text-to-SQL data analyst agent that connects to a customer's database, reads a YAML-defined semantic layer, and answers data questions in chat. The hosted SaaS at [app.useatlas.dev](https://app.useatlas.dev) runs across three regions (US/EU/APAC) with per-region data residency, per-workspace BYOT model configuration, and Vercel-sandbox-isolated explore/python tools.

The product spans a chat UI, an embeddable React widget, an OAuth-2.1 MCP server at [mcp.useatlas.dev](https://mcp.useatlas.dev), a notebook surface, a dashboard surface with draft/published mode, multi-environment query routing across connection groups, and eight chat-platform adapters (Slack live; Teams/Discord/Telegram/WhatsApp/Linear/GitHub/Google Chat wired). Proactive chat (reaction-first answers to natural questions) ships behind an enterprise gate. CRM lead capture pipes demo/signup/sales-form/Stripe-conversion events to a Twenty CRM at crm.useatlas.dev via a durable outbox. The CLI ships an operator surface for tenant data ops, a profiler, and a migrate tool.

The codebase is Hono + Next.js + TypeScript + Effect.ts + Vercel AI SDK + bun, organized as a 9-package monorepo with 20 plugins and three deploy modes (Docker, Vercel standalone, Railway). Enterprise features live under `ee/` behind a Context.Tag inversion that lets core compile and ship standalone. AGPL for self-host + commercial license for `ee/`; the hosted SaaS is the primary commercial offering.

---

## Next

**`v0.0.4` — Conversation Scope** ([milestone #59](https://github.com/AtlasDevHQ/atlas/milestone/59), 8 issues — 7 shipped) — in flight. Unifies the chat scope picker (`ChatScopePicker`, was `ChatEnvPicker`) across two axes: **SQL routing** (connection group + members + Auto/Pin/All) and **REST scope** (exclude-set + REST-only focus). Per-conversation authoritative, with a sticky workspace-scoped preference that seeds new chats; fixes the [#3063](https://github.com/AtlasDevHQ/atlas/issues/3063) reset-on-reload bug at the seed/restore seam. See [ADR-0011](../../docs/adr/0011-unified-conversation-scope.md) (supersedes ADR-0010 picker-surface only) + `CONTEXT.md` → Conversation scope.

Slices form a near-linear chain (S1a → S1b → S2a → S2b), with S3 + the #3071 doc-fix independent:

- [x] S1a — Restore the sticky scope preference on a fresh chat — fixes reset-on-reload ([#3064](https://github.com/AtlasDevHQ/atlas/issues/3064), bug, no deps) — PR #3070
- [x] S1b — Restore a conversation's scope when it is opened ([#3065](https://github.com/AtlasDevHQ/atlas/issues/3065), bug) — PR #3072 + scope-validation follow-up
- [x] S2a — REST scope: exclude datasources from a conversation ([#3066](https://github.com/AtlasDevHQ/atlas/issues/3066), feature) — PR #3077 (migration 0112 `rest_excluded_datasource_ids`; resolver + bound-tool enforcement; checkbox picker)
- [x] S2b — REST-only focus: suspend SQL for a conversation ([#3067](https://github.com/AtlasDevHQ/atlas/issues/3067), feature) — PR #3079 (migration 0113 `rest_focus_datasource_id`; resolver short-circuits group-scope + exclude-set; agent loop strips `executeSQL` + fails closed on a load/reconnect error)
- [x] S3 — Persist the active conversation in the URL ([#3068](https://github.com/AtlasDevHQ/atlas/issues/3068), refactor) — PR #3084 (conversationId → URL via co-located `search-params.ts`; URL-driven open effect; history push/replace; composer locked while loading)
- [x] REST-only-workspace picker visibility + independent exclude-set lifecycle ([#3078](https://github.com/AtlasDevHQ/atlas/issues/3078), feature) — PR #3082 (zero-group REST-only picker; decoupled `restProvenance`)
- [x] OpenAPI drift — `ConversationSchema` omits `routingMode` ([#3071](https://github.com/AtlasDevHQ/atlas/issues/3071), bug, independent doc-fix surfaced by S1b) — PR #3075
- [ ] Primary workspace chat `(workspace)/page.tsx` lacks Conversation REST scope (exclude-set + focus) — parity with the embeddable `<AtlasChat>` ([#3081](https://github.com/AtlasDevHQ/atlas/issues/3081), feature) ⟵ last open; gates `/release v0.0.4`

Parent [#3063](https://github.com/AtlasDevHQ/atlas/issues/3063) stays in the Architecture Backlog (left unmodified per `/to-issues`). The **Staging environment** track (below) continues in parallel, independent of the tag train.

---

## Planned tags

Lightweight forward-look. No committed scope; conviction firms as work begins.

- **Staging environment** ([milestone #57](https://github.com/AtlasDevHQ/atlas/milestone/57)) — separate work track on a late-June target; ships independently of the tag train. PRD [#2893](https://github.com/AtlasDevHQ/atlas/issues/2893) at [`docs/prd/staging-environment.md`](../../docs/prd/staging-environment.md); 22 slices (slices 1–4, 6, 7, 9 + Railway dual-trigger [#2921](https://github.com/AtlasDevHQ/atlas/issues/2921) landed). Runs in parallel to the tag train; the open HITL provisioning slices (#2916/#2917/#2918) + `deploy/api-staging/` config (#2912) remain.

- **`v0.1.0` — Public launch** ([#2919](https://github.com/AtlasDevHQ/atlas/issues/2919)) — the July 2026 launch event; first minor out of the `v0.0.x` train. Points at the banked changelog accumulated under `v0.0.x` (release-process plumbing, REST datasources, staging live). Tracked outside the tag train until the bundle firms up.

---

## Backlog

Untracked-but-noted work lives in the [Architecture Backlog milestone](https://github.com/AtlasDevHQ/atlas/milestone/49). Issues graduate out by being moved to a `v0.x.0` milestone when work begins.

Persistent candidate clusters (not milestoned):

- **SaaS Trust & Compliance** — [#1928](https://github.com/AtlasDevHQ/atlas/issues/1928) SOC 2 + ISO 27001 + pen test + IR drills, [#1922](https://github.com/AtlasDevHQ/atlas/issues/1922) DPA PDF, [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936) OpenStatus Starter. Promote when enterprise pipeline signals adoption pressure.

---

## History

Shipped milestones live in [`ROADMAP-archive.md`](./ROADMAP-archive.md):

- `v0.0.3` — **Spec Lifecycle** ([milestone #58](https://github.com/AtlasDevHQ/atlas/milestone/58), 6 issues) — keeps an installed OpenAPI datasource's upstream view current: per-install refresh interval, structured drift diff, shared cross-workspace spec/graph cache (credential never shared), scheduler auto re-discovery fiber, breaking-change drift signal. Split from v0.0.2 per #3013. Closed + tagged `v0.0.3` 2026-05-31.
- `v0.0.2` — **REST Datasources** ([milestone #54](https://github.com/AtlasDevHQ/atlas/milestone/54), 24 issues) — generic OpenAPI primitive makes REST services (Twenty, Stripe, GitHub, Notion) first-class read-side datasources; per-endpoint write allowlist + confirm-before-write; SSRF egress guard. Maps 1:1 to PRD #2868. Closed 2026-05-31.
- `v0.0.1` — **Release Process Bootstrap** ([milestone #56](https://github.com/AtlasDevHQ/atlas/milestone/56), 7 issues) — first git tag; tag-gated prod deploys (dedicated `prod`-branch trigger), customer-facing Stability Contract, ADR-0008/0009, `/release` flow. Docs + tooling only — no runtime feature.
- `v0.1` → `v1.3` — pre-public-tag internal milestones (foundation, deploy-anywhere, semantic layer, Better Auth, Hono API, MCP, Python sandbox, integration builder, plugin refactor)
- `0.6.0` → `1.6.0` — post-public-repo internal milestones (governance, performance, intelligence, SaaS infrastructure, launch, Effect.ts, MCP DX, multi-env, proactive chat, architecture deepening, multi-platform integrations, CRM lead capture)
- Closed parallel tracks — MFA hardening, security sweeps, sandbox exclusivity, dogfood-driven hotfixes, palette consolidation, Better Auth invitations cutover, docs static export

Issues + PR bodies remain the source of truth; archive entries are hooks, not commitments. The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is the SaaS-launch event in 2026-03, separate from the future git tag `v1.0.0`.
