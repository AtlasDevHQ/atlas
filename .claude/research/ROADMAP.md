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

No tag in flight — the train is between tags. `v0.0.8` was tagged + released 2026-06-03 (a 5-item rollup — dashboard parameters + text/section-block cards, with the CRM-flusher / sandbox-v2 / legacy-chat-install work folded in; see [History](#history)); the next tag's scope firms up as work begins, with `v0.0.9` ([Planned tags](#planned-tags)) the nearest candidate. The **Staging environment** track continues in parallel, independent of the tag train.

Banked since `v0.0.8`:

- [x] Text-card review hardening — blocks remote images in text-card markdown (a tracking-pixel IP-leak vector on public shared dashboards), forces full-width shared text cards, and guards the bound editor against SQL/chart edits on text cards. Bumps `@useatlas/types` → 0.1.13 (**unpublished — needs a `types-v0.1.13` tag push before the next tag**). ([#3147](https://github.com/AtlasDevHQ/atlas/pull/3147))

- [x] Static-bot install spine ([#3140](https://github.com/AtlasDevHQ/atlas/issues/3140) → [#3148](https://github.com/AtlasDevHQ/atlas/pull/3148), Architecture Backlog) — the cap-gated routing-identifier install path for the four form-shaped chat platforms (Telegram / Teams / Google Chat / WhatsApp): extends `/install-form` for `install_model="static-bot"`, an explicit `oauthShaped` discriminator (refuses Discord, whose `guild_id` rides on OAuth), a `coming_soon` dormancy gate (409 — the route can't reach a handler before its slice cap-gates `confirmInstall`), a declared-key `extras` whitelist, and the admin routing-id modal on a shared type-aware `<ConfigSchemaFields>` renderer. **Spine only** — per-platform enablement is the #2994 umbrella's sub-issues #3141–#3144 (+ dead-store cleanup #3145). Arch-win #81.

- [x] KPI / scorecard cards ([#3137](https://github.com/AtlasDevHQ/atlas/issues/3137) → [#3149](https://github.com/AtlasDevHQ/atlas/pull/3149), milestone #60) — the #2267 slice-2 card type: a single-stat scorecard (value + label + optional comparison delta) driven by a saved query. First slice of the v0.0.9 milestone.

- [x] Static-bot platforms enabled — the four [#2994](https://github.com/AtlasDevHQ/atlas/issues/2994) umbrella sub-issues land on the v0.0.8 spine: Telegram ([#3141](https://github.com/AtlasDevHQ/atlas/issues/3141) → [#3152](https://github.com/AtlasDevHQ/atlas/pull/3152)), Google Chat + WhatsApp ([#3143](https://github.com/AtlasDevHQ/atlas/issues/3143)/[#3144](https://github.com/AtlasDevHQ/atlas/issues/3144) → [#3153](https://github.com/AtlasDevHQ/atlas/pull/3153)), Teams ([#3142](https://github.com/AtlasDevHQ/atlas/issues/3142) → [#3156](https://github.com/AtlasDevHQ/atlas/pull/3156), with a runtime `executeQuery` branch), each cap-gated behind a cross-workspace routing-id ownership guard. Discord's residual uncapped OAuth bypass also retired ([#3145](https://github.com/AtlasDevHQ/atlas/issues/3145) → [#3160](https://github.com/AtlasDevHQ/atlas/pull/3160)); dead-store cleanup ([#3161](https://github.com/AtlasDevHQ/atlas/issues/3161)) + family-wide disconnect/auth hardening ([#3154](https://github.com/AtlasDevHQ/atlas/issues/3154)) remain open under #2994/#3145.

- [x] Tenant admin role single-sourced ([#2890](https://github.com/AtlasDevHQ/atlas/issues/2890) → [#3155](https://github.com/AtlasDevHQ/atlas/pull/3155), arch-win #82) — drops the redundant `admin` value from `user.role` so `member.role` is the sole source of truth for tenant admins. Deferred follow-ups: last-admin TOCTOU [#3158](https://github.com/AtlasDevHQ/atlas/issues/3158), target-workspace resolution [#3157](https://github.com/AtlasDevHQ/atlas/issues/3157), admin-plugin removal eval [#3159](https://github.com/AtlasDevHQ/atlas/issues/3159).

- [x] Deferred Group B majors landed — `fumadocs-mdx` and `syncpack` 14 → 15 ([#3132](https://github.com/AtlasDevHQ/atlas/issues/3132) → [#3150](https://github.com/AtlasDevHQ/atlas/pull/3150)/[#3151](https://github.com/AtlasDevHQ/atlas/pull/3151)), the two v0.0.7 deferrals that gate no tag.

- [ ] Staging environment (PRD #2893) — code-complete; only the HITL provisioning slices remain (#2900–#2918). Target late June 2026.

---

## Planned tags

Lightweight forward-look. No committed scope; conviction firms as work begins.

- **`v0.0.9` — Dashboard Primitives & Polish** ([milestone #60](https://github.com/AtlasDevHQ/atlas/milestone/60)) — takes the dashboard surface from "saved query gallery" toward Looker/Mode-class, sitting after the v0.0.8 params + text-blocks rollup. Opened by the now-shipped KPI / scorecard cards ([#3137](https://github.com/AtlasDevHQ/atlas/issues/3137) → #3149, the #2267 slice-2 card) plus findings from end-to-end prod user-testing. Candidate scope: KPI comparison/format polish, click-to-drilldown / cross-filtering, goal lines & thresholds, annotations, per-card CSV + dashboard export. Scope firms as testing notes land.

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

- `v0.0.8` — **Dashboard Parameters & Text Blocks** (no milestone — 5-item rollup tag) — first dashboard-primitives slices off the closed [#2267](https://github.com/AtlasDevHQ/atlas/issues/2267) design pass: a top-level parameter bar binds every card via safe `:param` substitution through the SQL guard (parameterized, never string-interpolated; #3136), plus text / section-block cards for narrative dashboards (#3138 → #3139). Folds in the eventized CRM outbox flusher — 5s poll replaced by an edge-triggered kick + retry timers + low-freq backstop (#2874 → #3134); `@vercel/sandbox` v2 ergonomics (`await using` + v2 `fs` API, following the v0.0.7 v1→v2 bump; #3126 → #3135); and legacy chat-install hardening — the uncapped, non-routable Telegram/Teams/Google-Chat/WhatsApp connect routes now 404 (#2994 → #3146; functional ADR-0007 installs deferred to sub-issues #3140–#3145). Tagged `v0.0.8` 2026-06-03. (Text-card review hardening #3147 + the `@useatlas/types` 0.1.13 bump landed just after the tag and bank into the next tag.)
- `v0.0.7` — **Dependency Refresh** (no milestone — dep-refresh rollup tag) — monorepo-wide dependency sweep on the new `/deps-update` discipline (#3124). Group A within-major bumps across every workspace (#3123 — `kysely` held at 0.28.17 via root override; better-auth 1.6.13's kysely-adapter breaks on 0.29). Group B majors landed one-PR-each, security-first: `@vercel/sandbox` v1 → v2 (#3125 — ESM-first dual-package desynced `require()` test mocks → dynamic `import()`), `just-bash` 3 (#3128), `stripe` 22.2.0 (#3129 — `apiVersion` now pinned explicitly via `lib/billing/stripe-api-version.ts` so a future SDK bump is a compile error, not a silent prod billing-schema shift), `react-day-picker` 10 (#3130), `diff` 9 (#3131); safe deferrables (shadcn, @duckdb r-series, esbuild) folded into the rollup (#3133). `fumadocs-mdx` 15 + `syncpack` 15 deferred — neither gates a tag → #3132. Tagged `v0.0.7` 2026-06-03.
- `v0.0.6` — **Webhook Delivery & Multi-Tenant Hardening** (no milestone — patch-rollup tag) — unifies Atlas's three outbound webhook senders (sub-processor change feed, SLA alerts, webhook-action plugin) onto `@useatlas/webhook-publisher` — HMAC signing + bounded retry + per-attempt timeout, every wire format unchanged; SLA alerts are now signed + retried where they were previously sent unsigned and dropped on one network blip (#2016 → #3118–#3121, arch-win #80). Multi-tenant ConnectionRegistry correctness: retires the `DISTINCT ON` collision via per-(workspace, install) registration (#2783 → #3110) and threads workspace context through the read-side bare readers + eagerly drains stale org pools (#3109 → #3114, win #79); datasource edits/uninstalls now tear down the pool immediately. Usage page surfaces the v0.0.5 prompt-cache split + billed/effective tokens (#3106 → #3107). Reliability: backups verify/restore structural error mapping + row-count assert (#2989 → #3115), per-tick scheduler spans (#2987 → #3112), dormant-org BYOT catalog-refresh gating (#2377 → #3113), chat installs capped before the Slack OAuth redirect (#2998 → #3108). Architecture deepening: env-profile phase-2 (#2937 → #3116), exhaustive `Record<DeployRegion, …>` region routing (#2983 → #3111), shared OAuth reconnect/refresh harness (#2708 → #3117); admin auth-client consent `.url` fix (#3122). Tagged `v0.0.6` 2026-06-02.
- `v0.0.5` — **Gateway Caching & Billing Accuracy** (no milestone — first patch-rollup tag) — AI Gateway→Anthropic prompt caching now active in prod with the cache-token split now recorded per request (#3103); the usage-page surfacing of that split landed just after the tag (#3106/#3107) and banks into the next tag; billing/usage report the actual model and default SaaS workspaces to the gateway (#3104); a test-only circuit-breaker recovery-fiber leak fixed (#3092); two test-gate flakes resolved (#3105). Also lands the prod-inert staging soak environment — staging milestone #57 stays open pending HITL provisioning. Tagged `v0.0.5` 2026-06-02.
- `v0.0.4` — **Conversation Scope** ([milestone #59](https://github.com/AtlasDevHQ/atlas/milestone/59), 8 issues) — per-conversation data scope across two axes: SQL routing (connection group + Auto/Pin/All) and REST scope (exclude-set + REST-only focus that suspends SQL); sticky workspace pref seeds new chats; active conversation persists in the URL; primary workspace chat unified onto the single `AtlasChat` component. ADR-0011; fixes reset-on-reload (#3063). Closed + tagged `v0.0.4` 2026-06-02.
- `v0.0.3` — **Spec Lifecycle** ([milestone #58](https://github.com/AtlasDevHQ/atlas/milestone/58), 6 issues) — keeps an installed OpenAPI datasource's upstream view current: per-install refresh interval, structured drift diff, shared cross-workspace spec/graph cache (credential never shared), scheduler auto re-discovery fiber, breaking-change drift signal. Split from v0.0.2 per #3013. Closed + tagged `v0.0.3` 2026-05-31.
- `v0.0.2` — **REST Datasources** ([milestone #54](https://github.com/AtlasDevHQ/atlas/milestone/54), 24 issues) — generic OpenAPI primitive makes REST services (Twenty, Stripe, GitHub, Notion) first-class read-side datasources; per-endpoint write allowlist + confirm-before-write; SSRF egress guard. Maps 1:1 to PRD #2868. Closed 2026-05-31.
- `v0.0.1` — **Release Process Bootstrap** ([milestone #56](https://github.com/AtlasDevHQ/atlas/milestone/56), 7 issues) — first git tag; tag-gated prod deploys (dedicated `prod`-branch trigger), customer-facing Stability Contract, ADR-0008/0009, `/release` flow. Docs + tooling only — no runtime feature.
- `v0.1` → `v1.3` — pre-public-tag internal milestones (foundation, deploy-anywhere, semantic layer, Better Auth, Hono API, MCP, Python sandbox, integration builder, plugin refactor)
- `0.6.0` → `1.6.0` — post-public-repo internal milestones (governance, performance, intelligence, SaaS infrastructure, launch, Effect.ts, MCP DX, multi-env, proactive chat, architecture deepening, multi-platform integrations, CRM lead capture)
- Closed parallel tracks — MFA hardening, security sweeps, sandbox exclusivity, dogfood-driven hotfixes, palette consolidation, Better Auth invitations cutover, docs static export

Issues + PR bodies remain the source of truth; archive entries are hooks, not commitments. The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is the SaaS-launch event in 2026-03, separate from the future git tag `v1.0.0`.
