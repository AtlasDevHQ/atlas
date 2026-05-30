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

## Next: v0.0.2 — REST Datasources

Extend Atlas's datasource model beyond SQL so REST services (Twenty, Stripe) become first-class read-side datasources via a generic OpenAPI primitive. Motivated by 1.6.0 Slice 6 ([#2728](https://github.com/AtlasDevHQ/atlas/issues/2728)) — Twenty Cloud doesn't expose Postgres. PRD [#2868](https://github.com/AtlasDevHQ/atlas/issues/2868) broken into tracer-bullet slices ([milestone #54](https://github.com/AtlasDevHQ/atlas/milestone/54)). GraphQL / OpenSearch are out-of-scope follow-up PRDs.

- [x] **Slice 0 — openapi-spec + openapi-client deep modules** ([#2923](https://github.com/AtlasDevHQ/atlas/issues/2923)) — OpenAPI 3.x → operation graph + single-op execute. Shipped in [#2935](https://github.com/AtlasDevHQ/atlas/pull/2935) (arch-win #72).
- [x] **Slice 1 — Twenty acceptance suite** ([#2924](https://github.com/AtlasDevHQ/atlas/issues/2924)) — read-only generic agent + `executeRestOperation` tool, Path A operation-graph representation. Shipped in [#2971](https://github.com/AtlasDevHQ/atlas/pull/2971) (arch-win #73); writes deferred to slice 5.
- [x] **Slice 1b — representation bake-off** ([#2931](https://github.com/AtlasDevHQ/atlas/issues/2931)) — generated semantic YAML (Path B) vs raw operation-graph context (Path A) against the Twenty suite; picks slice 2's default representation. Shipped in [#2974](https://github.com/AtlasDevHQ/atlas/pull/2974) (arch-win #75).
- [x] **Slice 2 — install surface** ([#2926](https://github.com/AtlasDevHQ/atlas/issues/2926)) — code-seeded `openapi-generic` catalog row + `OpenApiGenericFormInstallHandler` (probe-on-install, `auth_value` encrypted via `secret:true`) + per-workspace DB resolver/`OpenApiDatasourceRegistry` (retires the slice-1 `ATLAS_OPENAPI_TWENTY*` env path) + `/admin/connections` block with per-install detail/rediscover/representation toggle. Default mode `operation-graph` (bake-off winner); both modes selectable. Shipped in [#2990](https://github.com/AtlasDevHQ/atlas/pull/2990).
- [x] **Slice 3 — sandbox networkPolicy threading** ([#2927](https://github.com/AtlasDevHQ/atlas/issues/2927)) — per-tenant base-URL allowlist (SaaS) + sidecar pass-through. Shipped in [#2975](https://github.com/AtlasDevHQ/atlas/pull/2975).
- [x] **Slice 4 — openapi-paginator registry** ([#2928](https://github.com/AtlasDevHQ/atlas/issues/2928)) — cursor/offset/page/link-header strategies + page-level L2 cache. Shipped in [#2973](https://github.com/AtlasDevHQ/atlas/pull/2973) (arch-win #74).
- [x] **Slice 5 — write-side opt-in** ([#2929](https://github.com/AtlasDevHQ/atlas/issues/2929)) — `validateRestOperation` safety stack + `write_allowlist` + confirm-before-write banner. Shipped in [#2993](https://github.com/AtlasDevHQ/atlas/pull/2993).
- [ ] **Slice 6 — expansion targets** ([#2930](https://github.com/AtlasDevHQ/atlas/issues/2930), HITL) — stripe-data + 2 REST candidates thin-wrapping the primitive.

Spec-lifecycle follow-ups (net-new v0.0.2 scope, milestone-tracked): customer-configurable refresh interval + Refresh now ([#2977](https://github.com/AtlasDevHQ/atlas/issues/2977)) shipped [#3002](https://github.com/AtlasDevHQ/atlas/pull/3002); still open — scheduler-driven re-discovery ([#2978](https://github.com/AtlasDevHQ/atlas/issues/2978)), structured drift diff ([#2976](https://github.com/AtlasDevHQ/atlas/issues/2976)) + breaking-change signal ([#2979](https://github.com/AtlasDevHQ/atlas/issues/2979)), and a shared cross-workspace spec/graph cache ([#2970](https://github.com/AtlasDevHQ/atlas/issues/2970)).

---

## Planned tags

Lightweight forward-look. No committed scope; conviction firms as work begins.

- **Staging environment** ([milestone #57](https://github.com/AtlasDevHQ/atlas/milestone/57)) — separate work track on a late-June target; ships independently of the tag train. PRD [#2893](https://github.com/AtlasDevHQ/atlas/issues/2893) at [`docs/prd/staging-environment.md`](../../docs/prd/staging-environment.md); 22 slices (slices 1–4 + Railway dual-trigger [#2921](https://github.com/AtlasDevHQ/atlas/issues/2921) landed). May land before or after `v0.0.2` depending on adoption signal.

- **`v0.1.0` — Public launch** ([#2919](https://github.com/AtlasDevHQ/atlas/issues/2919)) — the July 2026 launch event; first minor out of the `v0.0.x` train. Points at the banked changelog accumulated under `v0.0.x` (release-process plumbing, REST datasources, staging live). Tracked outside the tag train until the bundle firms up.

---

## Backlog

Untracked-but-noted work lives in the [Architecture Backlog milestone](https://github.com/AtlasDevHQ/atlas/milestone/49). Issues graduate out by being moved to a `v0.x.0` milestone when work begins.

Persistent candidate clusters (not milestoned):

- **SaaS Trust & Compliance** — [#1928](https://github.com/AtlasDevHQ/atlas/issues/1928) SOC 2 + ISO 27001 + pen test + IR drills, [#1922](https://github.com/AtlasDevHQ/atlas/issues/1922) DPA PDF, [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936) OpenStatus Starter. Promote when enterprise pipeline signals adoption pressure.

---

## History

Shipped milestones live in [`ROADMAP-archive.md`](./ROADMAP-archive.md):

- `v0.0.1` — **Release Process Bootstrap** ([milestone #56](https://github.com/AtlasDevHQ/atlas/milestone/56), 7 issues) — first git tag; tag-gated prod deploys (dedicated `prod`-branch trigger), customer-facing Stability Contract, ADR-0008/0009, `/release` flow. Docs + tooling only — no runtime feature.
- `v0.1` → `v1.3` — pre-public-tag internal milestones (foundation, deploy-anywhere, semantic layer, Better Auth, Hono API, MCP, Python sandbox, integration builder, plugin refactor)
- `0.6.0` → `1.6.0` — post-public-repo internal milestones (governance, performance, intelligence, SaaS infrastructure, launch, Effect.ts, MCP DX, multi-env, proactive chat, architecture deepening, multi-platform integrations, CRM lead capture)
- Closed parallel tracks — MFA hardening, security sweeps, sandbox exclusivity, dogfood-driven hotfixes, palette consolidation, Better Auth invitations cutover, docs static export

Issues + PR bodies remain the source of truth; archive entries are hooks, not commitments. The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is the SaaS-launch event in 2026-03, separate from the future git tag `v1.0.0`.
