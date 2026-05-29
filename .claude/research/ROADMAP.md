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

## Next: v0.0.1 — Release Process Bootstrap

First git tag (`v0.0.1`) — the start of the pre-launch `v0.0.x` development train. Establishes the tag-gated release process and the customer-facing stability contract. Scope is docs + tooling — no runtime feature ships under this tag. Tag-cut as soon as the bundle below is ready; the public launch is a separate event (`v0.1.0`, target July 2026) that points at the banked changelog accumulated under the `v0.0.x` train.

- [ ] **Slice 6 cutover** ([#2802](https://github.com/AtlasDevHQ/atlas/issues/2802)) — replace the custom `scripts/test-isolated.ts` subprocess-per-file runner with native `bun test --parallel`. Mechanical diff prepared on `claude/practical-hamilton-Ycwto`. Parked on bun 1.4.0 GA — under the `>=1.3.13 <1.3.14` engine pin the full `packages/api/` suite passes 3020/3020 in 19.58s. Re-apply once bun 1.4.0 ships and lift the engine pin in the same PR.
- [x] **Stability Contract docs page** ([`apps/docs/content/docs/reference/stability.mdx`](../../apps/docs/content/docs/reference/stability.mdx)) — customer-facing commitments for REST API (`/api/v1/*`), MCP tool surface, plugin SDK, semantic layer wire format. Shipped with ADR-0008/0009 in [#2920](https://github.com/AtlasDevHQ/atlas/pull/2920).
- [x] **ROADMAP restructure** — this file. Five-section shape per ADR-0009; shipped milestones consolidated to [`ROADMAP-archive.md`](./ROADMAP-archive.md). Shipped in [#2920](https://github.com/AtlasDevHQ/atlas/pull/2920).
- [x] **`/prod-audit` pre-launch pass** ([#2896](https://github.com/AtlasDevHQ/atlas/issues/2896)) — all three legs ran clean (0 CRITICAL, ✅ gate pass); inline fixes in [#2949](https://github.com/AtlasDevHQ/atlas/pull/2949)/[#2948](https://github.com/AtlasDevHQ/atlas/pull/2948)/[#2957](https://github.com/AtlasDevHQ/atlas/pull/2957)/[#2962](https://github.com/AtlasDevHQ/atlas/pull/2962), remaining findings tracked + scoped before tag.
- [x] **`/release` skill** ([`.claude/commands/release.md`](../../.claude/commands/release.md)) — bundles `/ci` + annotated tag + push + `prod`-branch advance + `gh release create --generate-notes`. Shipped in [#2920](https://github.com/AtlasDevHQ/atlas/pull/2920).

Decoupled from this bundle: the **staging environment build track**. The grilling session captured a staging design ([PRD #2893](https://github.com/AtlasDevHQ/atlas/issues/2893), landed at [`docs/prd/staging-environment.md`](../../docs/prd/staging-environment.md)) broken into 22 slices ([milestone #57](https://github.com/AtlasDevHQ/atlas/milestone/57)) with a late-June target. Staging is not a v0.0.1 tag-cut gate. The tag-gated Railway trigger advances a dedicated `prod` branch on tag ([#2922](https://github.com/AtlasDevHQ/atlas/pull/2922)); `main → staging` auto-deploys.

---

## Planned tags

Lightweight forward-look. No committed scope; conviction firms as work begins.

- **`v0.0.2` — REST Datasources** ([milestone #54](https://github.com/AtlasDevHQ/atlas/milestone/54)) — extend Atlas's datasource model beyond SQL so REST services (Twenty, Stripe) become first-class read-side datasources via a generic OpenAPI primitive (GraphQL / OpenSearch are out-of-scope follow-up PRDs). Motivated by 1.6.0 Slice 6 ([#2728](https://github.com/AtlasDevHQ/atlas/issues/2728)) — Twenty Cloud doesn't expose Postgres. PRD [#2868](https://github.com/AtlasDevHQ/atlas/issues/2868) broken into 8 tracer-bullet slices ([#2923](https://github.com/AtlasDevHQ/atlas/issues/2923)–[#2931](https://github.com/AtlasDevHQ/atlas/issues/2931)); slice 0 (openapi-spec + openapi-client deep modules) shipped ([#2935](https://github.com/AtlasDevHQ/atlas/pull/2935), arch-win #72), slice 1b runs a representation bake-off (raw operation-graph context vs generated semantic YAML) against the Twenty acceptance suite to pick slice 2's default, slice 6 (expansion targets) is HITL.

- **Staging environment** ([milestone #57](https://github.com/AtlasDevHQ/atlas/milestone/57)) — separate work track on a late-June target; ships independently of the tag train. PRD [#2893](https://github.com/AtlasDevHQ/atlas/issues/2893) at [`docs/prd/staging-environment.md`](../../docs/prd/staging-environment.md); 22 slices (2/22 landed). May land before or after `v0.0.2` depending on adoption signal.

- **`v0.1.0` — Public launch** ([#2919](https://github.com/AtlasDevHQ/atlas/issues/2919)) — the July 2026 launch event; first minor out of the `v0.0.x` train. Points at the banked changelog accumulated under `v0.0.x` (release-process plumbing, REST datasources, staging live). Tracked outside the tag train until the bundle firms up.

---

## Backlog

Untracked-but-noted work lives in the [Architecture Backlog milestone](https://github.com/AtlasDevHQ/atlas/milestone/49). Issues graduate out by being moved to a `v0.x.0` milestone when work begins.

Persistent candidate clusters (not milestoned):

- **SaaS Trust & Compliance** — [#1928](https://github.com/AtlasDevHQ/atlas/issues/1928) SOC 2 + ISO 27001 + pen test + IR drills, [#1922](https://github.com/AtlasDevHQ/atlas/issues/1922) DPA PDF, [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936) OpenStatus Starter. Promote when enterprise pipeline signals adoption pressure.

---

## History

Shipped milestones live in [`ROADMAP-archive.md`](./ROADMAP-archive.md):

- `v0.1` → `v1.3` — pre-public-tag internal milestones (foundation, deploy-anywhere, semantic layer, Better Auth, Hono API, MCP, Python sandbox, integration builder, plugin refactor)
- `0.6.0` → `1.6.0` — post-public-repo internal milestones (governance, performance, intelligence, SaaS infrastructure, launch, Effect.ts, MCP DX, multi-env, proactive chat, architecture deepening, multi-platform integrations, CRM lead capture)
- Closed parallel tracks — MFA hardening, security sweeps, sandbox exclusivity, dogfood-driven hotfixes, palette consolidation, Better Auth invitations cutover, docs static export

Issues + PR bodies remain the source of truth; archive entries are hooks, not commitments. The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is the SaaS-launch event in 2026-03, separate from the future git tag `v1.0.0`.
