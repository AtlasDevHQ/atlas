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

## Next: v0.0.3 — Spec Lifecycle

Successor to v0.0.2 ([milestone #58](https://github.com/AtlasDevHQ/atlas/milestone/58)), split out per [#3013](https://github.com/AtlasDevHQ/atlas/issues/3013) to keep v0.0.2 inside its PRD contract. Keeps an installed OpenAPI datasource's view of its upstream current — refresh cadence, auto re-discovery, drift detection, and a shared cross-workspace spec cache so a public upstream is downloaded once.

- [x] **Per-install spec refresh interval** ([#2977](https://github.com/AtlasDevHQ/atlas/issues/2977)) — customer-configurable cadence + "Refresh now". Shipped in [#3002](https://github.com/AtlasDevHQ/atlas/pull/3002).
- [x] **Structured drift diff** ([#2976](https://github.com/AtlasDevHQ/atlas/issues/2976)) — added/removed/changed-operation changeset on (re-)discovery. Shipped in [#3041](https://github.com/AtlasDevHQ/atlas/pull/3041).
- [x] **Shared cross-workspace spec/graph cache** ([#2970](https://github.com/AtlasDevHQ/atlas/issues/2970)) — public upstream (Stripe/GitHub/Notion) downloaded + normalized once across workspaces, refreshed by conditional GET; the credential is never shared. Shipped in [#3042](https://github.com/AtlasDevHQ/atlas/pull/3042).
- [ ] **Scheduler-driven auto re-discovery** ([#2978](https://github.com/AtlasDevHQ/atlas/issues/2978)) — background fiber walks due installs and re-probes on the configured interval (the active path behind the already-shipped setting).
- [ ] **Breaking-change drift signal** ([#2979](https://github.com/AtlasDevHQ/atlas/issues/2979)) — surface when scheduled re-discovery removes or changes operations the agent depends on.

3 of 5 shipped ahead of a formal kickoff — promoted from "Planned tags" on v0.0.2 closeout (2026-05-31) since work was already underway. Remaining two (#2978, #2979) form the scheduler arm.

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

- `v0.0.2` — **REST Datasources** ([milestone #54](https://github.com/AtlasDevHQ/atlas/milestone/54), 24 issues) — generic OpenAPI primitive makes REST services (Twenty, Stripe, GitHub, Notion) first-class read-side datasources; per-endpoint write allowlist + confirm-before-write; SSRF egress guard. Maps 1:1 to PRD #2868. Closed 2026-05-31.
- `v0.0.1` — **Release Process Bootstrap** ([milestone #56](https://github.com/AtlasDevHQ/atlas/milestone/56), 7 issues) — first git tag; tag-gated prod deploys (dedicated `prod`-branch trigger), customer-facing Stability Contract, ADR-0008/0009, `/release` flow. Docs + tooling only — no runtime feature.
- `v0.1` → `v1.3` — pre-public-tag internal milestones (foundation, deploy-anywhere, semantic layer, Better Auth, Hono API, MCP, Python sandbox, integration builder, plugin refactor)
- `0.6.0` → `1.6.0` — post-public-repo internal milestones (governance, performance, intelligence, SaaS infrastructure, launch, Effect.ts, MCP DX, multi-env, proactive chat, architecture deepening, multi-platform integrations, CRM lead capture)
- Closed parallel tracks — MFA hardening, security sweeps, sandbox exclusivity, dogfood-driven hotfixes, palette consolidation, Better Auth invitations cutover, docs static export

Issues + PR bodies remain the source of truth; archive entries are hooks, not commitments. The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is the SaaS-launch event in 2026-03, separate from the future git tag `v1.0.0`.
