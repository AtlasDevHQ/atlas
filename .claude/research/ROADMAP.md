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

No tag in flight — the train is between tags. `v0.0.5` was tagged + released 2026-06-02 (a patch rollup — gateway prompt caching, billing/model accuracy, reliability + the prod-inert staging code; see [History](#history)); the next tag's scope firms up as work begins. The **Staging environment** track ([Planned tags](#planned-tags)) continues in parallel, independent of the tag train.

**Banked since `v0.0.5`** (rolls into the next patch tag):

- [x] Usage page surfaces the prompt-cache read/write split + billed-vs-effective tokens (#3106 → #3107) — completes the v0.0.5 caching groundwork.
- [x] Chat-integration install cap enforced before the Slack OAuth redirect, not only in the callback (#2998 → #3108).
- [x] ConnectionRegistry retires the multi-tenant `DISTINCT ON` collision via per-(workspace, install) registration (#2783 → #3110); the read-side follow-up (#3109 → #3114) threads workspace context through the bare readers + eagerly drains stale org pools (win #79).
- [x] Reliability + observability hardening: backups verify/restore map structural failures to tagged errors + assert row counts (#2989 → #3115); per-tick spans now cover every periodic scheduler fiber (#2987 → #3112); BYOT catalog refresh skips dormant orgs via `organization.last_active_at` (#2377 → #3113).
- [x] Architecture deepening: env-profile phase-2 migrates the last per-env runtime defaults (#2937 → #3116); region routing forces an exhaustive `Record<DeployRegion, …>` decision (#2983 → #3111); the three per-platform OAuth reconnect errors + refresh-retry loops collapse into one shared harness (#2708 → #3117).

- [ ] Staging environment (PRD #2893) — code-complete; only the HITL provisioning slices remain (#2900–#2918). Target late June 2026.

---

## Planned tags

Lightweight forward-look. No committed scope; conviction firms as work begins.

- **Staging environment** ([milestone #57](https://github.com/AtlasDevHQ/atlas/milestone/57)) — separate work track on a late-June target; ships independently of the tag train. PRD [#2893](https://github.com/AtlasDevHQ/atlas/issues/2893) at [`docs/prd/staging-environment.md`](../../docs/prd/staging-environment.md). All code slices have landed (clamp wiring, `api-staging` config, misrouting coverage, smoke workflow, operator runbook #2899, and the review-surfaced hardening cluster #3095/#2984/#3088/#3096/#3097 via #3100); the staging services are live and green. Remaining: only the HITL OAuth/Railway provisioning slices (#2900–#2918), which need operator action.

- **`v0.1.0` — Public launch** ([#2919](https://github.com/AtlasDevHQ/atlas/issues/2919)) — the July 2026 launch event; first minor out of the `v0.0.x` train. Points at the banked changelog accumulated under `v0.0.x` (release-process plumbing, REST datasources, staging live). Tracked outside the tag train until the bundle firms up.

---

## Backlog

Untracked-but-noted work lives in the [Architecture Backlog milestone](https://github.com/AtlasDevHQ/atlas/milestone/49). Issues graduate out by being moved to a `v0.x.0` milestone when work begins.

Persistent candidate clusters (not milestoned):

- **SaaS Trust & Compliance** — [#1928](https://github.com/AtlasDevHQ/atlas/issues/1928) SOC 2 + ISO 27001 + pen test + IR drills, [#1922](https://github.com/AtlasDevHQ/atlas/issues/1922) DPA PDF, [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936) OpenStatus Starter. Promote when enterprise pipeline signals adoption pressure.

---

## History

Shipped milestones live in [`ROADMAP-archive.md`](./ROADMAP-archive.md):

- `v0.0.5` — **Gateway Caching & Billing Accuracy** (no milestone — first patch-rollup tag) — AI Gateway→Anthropic prompt caching now active in prod with the cache-token split now recorded per request (#3103); the usage-page surfacing of that split landed just after the tag (#3106/#3107) and banks into the next tag; billing/usage report the actual model and default SaaS workspaces to the gateway (#3104); a test-only circuit-breaker recovery-fiber leak fixed (#3092); two test-gate flakes resolved (#3105). Also lands the prod-inert staging soak environment — staging milestone #57 stays open pending HITL provisioning. Tagged `v0.0.5` 2026-06-02.
- `v0.0.4` — **Conversation Scope** ([milestone #59](https://github.com/AtlasDevHQ/atlas/milestone/59), 8 issues) — per-conversation data scope across two axes: SQL routing (connection group + Auto/Pin/All) and REST scope (exclude-set + REST-only focus that suspends SQL); sticky workspace pref seeds new chats; active conversation persists in the URL; primary workspace chat unified onto the single `AtlasChat` component. ADR-0011; fixes reset-on-reload (#3063). Closed + tagged `v0.0.4` 2026-06-02.
- `v0.0.3` — **Spec Lifecycle** ([milestone #58](https://github.com/AtlasDevHQ/atlas/milestone/58), 6 issues) — keeps an installed OpenAPI datasource's upstream view current: per-install refresh interval, structured drift diff, shared cross-workspace spec/graph cache (credential never shared), scheduler auto re-discovery fiber, breaking-change drift signal. Split from v0.0.2 per #3013. Closed + tagged `v0.0.3` 2026-05-31.
- `v0.0.2` — **REST Datasources** ([milestone #54](https://github.com/AtlasDevHQ/atlas/milestone/54), 24 issues) — generic OpenAPI primitive makes REST services (Twenty, Stripe, GitHub, Notion) first-class read-side datasources; per-endpoint write allowlist + confirm-before-write; SSRF egress guard. Maps 1:1 to PRD #2868. Closed 2026-05-31.
- `v0.0.1` — **Release Process Bootstrap** ([milestone #56](https://github.com/AtlasDevHQ/atlas/milestone/56), 7 issues) — first git tag; tag-gated prod deploys (dedicated `prod`-branch trigger), customer-facing Stability Contract, ADR-0008/0009, `/release` flow. Docs + tooling only — no runtime feature.
- `v0.1` → `v1.3` — pre-public-tag internal milestones (foundation, deploy-anywhere, semantic layer, Better Auth, Hono API, MCP, Python sandbox, integration builder, plugin refactor)
- `0.6.0` → `1.6.0` — post-public-repo internal milestones (governance, performance, intelligence, SaaS infrastructure, launch, Effect.ts, MCP DX, multi-env, proactive chat, architecture deepening, multi-platform integrations, CRM lead capture)
- Closed parallel tracks — MFA hardening, security sweeps, sandbox exclusivity, dogfood-driven hotfixes, palette consolidation, Better Auth invitations cutover, docs static export

Issues + PR bodies remain the source of truth; archive entries are hooks, not commitments. The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is the SaaS-launch event in 2026-03, separate from the future git tag `v1.0.0`.
