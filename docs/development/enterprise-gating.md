# Enterprise & SaaS Gating (`/ee`)

Long-form reference for the `/ee` rules summarized in [CLAUDE.md](../../CLAUDE.md) § *Enterprise & SaaS Gating*. The terse rules there are the day-to-day checklist; this doc holds the rationale, enforcement mechanics, and the drift-checked membership lists.

## What goes in `/ee`

Any feature that exists specifically to make Atlas work as a hosted SaaS product (app.useatlas.dev) lives in `ee/src/` under the commercial license: deploy-mode detection, SaaS admin UX branching, plugin marketplace, multi-tenant billing, platform admin tools, data-residency routing, SLA monitoring, automated backups, PII masking, SSO/SCIM, approval workflows, abuse prevention, white-labeling.

The commercial license (`ee/LICENSE`) prohibits using `/ee` in a competing product. This is the business model: self-hosted is free (AGPL); the hosted SaaS and enterprise features are the commercial offering.

## The core → ee inversion (enforced)

Core AGPL never depends on `/ee`. Self-hosted gets the full product (agent, tools, admin, plugins via config); `/ee` adds governance, compliance, scale, and polished SaaS UX.

- **Exactly one file** in `packages/api/src/` may import from `@atlas/ee`: `lib/effect/enterprise-layer.ts` (boot-time composition via `await import("@atlas/ee/layers")`).
- `scripts/check-ee-imports.sh` (drift CI job) fails any other `@atlas/ee` import.
- The `ee-stub-build` job replaces `ee/` with a no-op stub and re-runs `bun run type` + `bun run build` to prove core compiles standalone.
- Every enterprise subsystem (residency, model routing, masking, approval, SLA, backups, audit retention, IP allowlist, SSO, SCIM, roles, branding, domains, proactive, deploy mode) is reachable via a `Context.Tag` in `lib/effect/services.ts` — `yield* TheTag`, never `await import("@atlas/ee/...")`.

## Reading the enterprise flag

Core code never imports `isEnterpriseEnabled` from `@atlas/ee` (closeout grep gate rejects it). Branch on capability instead: `yield* TheTag` and let the `NoopXxxLayer` default short-circuit when EE isn't installed — e.g. `ProactiveGate.requireEnabled` yields `EnterpriseError`; `RolesPolicy.checkPermission` falls back to legacy admin/member mapping.

For the rare value-level boolean (CLI helpers, `enterprise-layer.ts` itself), use `isEnterpriseEnabled()` from `packages/api/src/lib/effect/enterprise-config.ts` — the core mirror that doesn't import `@atlas/ee`.

`requireEnterprise()` / `requireEnterpriseEffect()` are defined in `ee/src/index.ts` for use *inside* `ee/`; core uses `EnterpriseError` from `@atlas/api/lib/effect/errors` directly.

## EnterpriseError

Always throw/catch `EnterpriseError`. Core imports it from `@atlas/api/lib/effect/errors`; `@atlas/ee` re-exports the same class for use *inside* `ee/`. Use `instanceof EnterpriseError`, never string matching. Route handlers map `EnterpriseError` to 403.

## `Tag.available` — when to add the flag

When authoring a new enterprise Tag in `lib/effect/services.ts`, **omit** `readonly available: boolean` by default. The Noop layer's `Effect.fail(EnterpriseError(...))` + Hono 403 mapping is the canonical "feature unavailable" signal — routes don't need a flag.

Add `available` **only** when a non-test consumer must branch into a *different* response shape than the 403 envelope: a 404 `not_available`, a 200-with-empty-shape body, or a DB-skip short-circuit. Document the consumer(s) in the Tag's JSDoc so the next reviewer can confirm the flag is still load-bearing.

Domain-specific boolean flags (`customRolesActive`, `enabled`, etc.) are **not** permitted — fold into `available` or surface via method return value.

### Current membership (drift-checked)

Verify with `grep -n "readonly available: boolean" packages/api/src/lib/effect/services.ts` (10 boolean-form field hits + 1 comment line):

`ResidencyResolver`, `ModelRouter`, `MaskingPolicy`, `ApprovalGate`, `SlaMetrics`, `BackupsManager`, `AuditRetention`, `IpAllowlistPolicy`, `SCIMProvenance`, `Domains`.

Plus two that the boolean-form grep does **not** match:

- **`SaasCrm`** — carries `available` as a discriminated-union discriminant (`available: false | true`), branched on by `POST /api/v1/contact` + the platform CRM-outbox routes (`platform-crm-outbox.ts`) to return 404 `not_available`.
- **`DeployModeResolver`** — the single sentinel-returning Tag; `"saas" | "self-hosted"` is the *value*, and that pattern is reserved for it.

`MaskingPolicy` / `ApprovalGate` / `AuditRetention` / `ResidencyResolver` are the four consumer-side fail-closed audit sites from `lib/effect/enterprise-layer.ts` — they branch on `available === false` to surface the 503 `enterprise_load_failed` envelope.

Re-run the grep (and check `SaasCrm`'s union form) when adding or removing a flag so this list stays in lockstep.

## Deploy mode is enterprise-gated

`ATLAS_DEPLOY_MODE=saas` requires `/ee`. Without enterprise enabled, deploy mode always resolves to `self-hosted`. The frontend reads `deployMode` from the API to branch admin UX.

## Deploy-mode parity contract

Outcome of the #3374 drift audit. The recurring bug class: a feature surface (admin control, settings flag, install path, marketplace listing) exists in both deploy modes but its runtime consumer is only wired in one — so one mode shows controls that silently do nothing, or applies gates meant for the other mode (exemplars: #3370, #3295, #3301, #3375–#3379). These rules exist to make that class un-writable, or at least un-reviewable-past.

### Rule 1 — every admin-visible write names its runtime reader, in both modes

Before shipping any admin mutation (settings PUT, connect/install endpoint, config save), the PR must be able to answer: **what non-test code reads this value at runtime, on SaaS and on self-hosted?** A display-only reader (status endpoint echoing the stored value back to the UI) does not count — that's how #3370 shipped a four-provider connect flow whose credentials nothing consumed. If one mode has no reader, either wire it or gate the surface out of that mode in the same PR; "stored for future use" requires explicit UI copy saying so.

The same test applies in reverse when *removing* a reader: if runtime code stops consuming a stored value, the admin surface that writes it must go (or be re-scoped) in the same PR.

### Rule 2 — where deploy-mode branches may live

Mode branch points are expensive (each one is half of a potential drift pair), so they're restricted to the blessed sources of truth and their direct consumers:

- **API:** branch on capability via `yield* TheTag` (Noop layers short-circuit), or — for the rare value-level boolean — `isEnterpriseEnabled()` / `getConfig()?.deployMode` from `lib/effect/enterprise-config.ts` / the resolved config. Never `process.env.ATLAS_DEPLOY_MODE` reads scattered in feature code, and never `hasInternalDB()` as a deploy-mode proxy (it gates *storage*, not mode).
- **Web:** `useDeployMode()` only. Its resolution can be a **guess** (hostname fallback while loading / on fetch error / `enabled: false`), so consumers commit to it by risk tier: purely cosmetic read-only branches (copy, icons) may render from the guess; a component that swaps whole mode-specific views renders a neutral/loading state until `loading === false`; and a flow that *writes* mode-specific values (e.g. a settings vocabulary that differs per mode) must not save while `loading` is `true` or `error` is non-null — a guessed mode never decides what gets persisted (#3378).
- **Deploy pins:** SaaS-specific runtime defaults (sandbox priority, plugin catalog) live in `deploy/api/atlas.config.ts`, not in code-level `if (saas)` branches.

A web mode branch and the API route it talks to form a **pair**: whatever the UI hides in a mode, the API must reject in that mode (and vice versa). Hiding in the UI alone is not a gate — `saas_eligible` got this right only after #3301 added the install-time refusal to match the listing filter.

### Rule 3 — one value vocabulary per setting, end to end

A stored value must mean the same thing to every reader and every writer, in both modes. The sandbox page wrote provider keys (`"e2b"`) into a setting whose runtime reader matches backend ids (`"e2b-sandbox"`) — both sides worked in isolation and the feature was silently inert (#3375). When a setting's value set is an enum consumed by both `@atlas/api` and `@atlas/web`, it belongs in `@useatlas/schemas`/`@useatlas/types` (see #3371), and the settings-registry `description` documents the canonical value set.

### Rule 4 — `saasVisible` is a read+write contract, not a display hint

If a setting is hidden from SaaS workspace admins on `GET /admin/settings`, the PUT/DELETE path must enforce the same boundary — an invisible-but-writable setting is undebuggable (written once, no UI to see or clear it). The decided semantics (#3376) are two axes on `SettingDefinition`:

- **`saasVisible`** is the read/display axis: it controls whether the key appears on the generic `GET /admin/settings` listing for SaaS workspace admins. Defaults to `true`.
- **`saasWritable`** is the write axis: PUT and DELETE on `/admin/settings/{key}` reject (403) for SaaS workspace admins when the *effective* value is `false`. When unset it **defaults to the `saasVisible` value**, so for most keys visibility and writability remain a single decision and hidden ⇒ un-writable holds automatically.

A key managed by a dedicated admin page on SaaS (today: `ATLAS_SANDBOX_BACKEND` via `/admin/sandbox` — its sibling `ATLAS_SANDBOX_URL` is written only by the self-hosted view, so it inherits hidden ⇒ un-writable) uses the split — `saasVisible: false, saasWritable: true` — so it stays off the generic settings page but its own surface keeps saving through the same PUT route. Platform admins and self-hosted deployments are never restricted by either flag, and both flags are registry-internal (stripped from the GET response).

Two probe decisions ride on this rule (#3389). Settings **write-path** mode probes fail closed: the PUT/DELETE gates share `isSaasModeForGuard()` from `lib/settings.ts`, so a config-resolution *failure* at request time is treated as SaaS (restrictive) — only a legitimately-unloaded config (`getConfig()` → `null`) counts as self-hosted, and the GET filter's probe stays display-only and permissive. And the write path classifies a "SaaS workspace admin" exactly as GET does — `!isPlatformAdmin`, with no `orgId` requirement — so a SaaS session with no active workspace gets workspace-admin restrictions on writes, not a platform-scope bypass; because clearing an override is a write, `deleteSetting` also enforces `SAAS_IMMUTABLE_KEYS` like `setSetting` (DELETE returns the same 409 envelope as PUT).

The no-org workspace-admin classification also covers **workspace-scoped** keys (#3395). With no org context, a workspace-scoped PUT/DELETE would land on the global `org_id IS NULL` row — the tier-2 default every workspace resolves through — so a no-org SaaS non-platform-admin session can never reach that row: both verbs reject 403 (same envelope as the platform-scope gate, same fail-closed `isSaasModeForGuard()` probe). Self-hosted no-org sessions keep the global-override path — that is the legitimate self-hosted admin write. GET's `showAll` classification now matches the same rule: on SaaS, only platform admins get showAll (a no-org session no longer sees platform-scoped settings), while no-org self-hosted keeps it — implemented with GET's display-only permissive `getConfig()?.deployMode` probe, not the fail-closed guard.

### Rule 5 — docs state mode scope explicitly

A guide for a surface that behaves differently per mode says so per mode; "works on Atlas" claims that are true in only one mode are class-6 drift. When a parity bug is fixed or scoped (e.g. a feature declared SaaS-only), the docs change rides the same PR — same discipline as the chat-plugin contract table.

### Review checklist (the short form)

For any PR touching an admin surface, a settings key, an install path, or a `useDeployMode()`/Tag branch:

1. Name the runtime reader of every new write, per mode (Rule 1).
2. If the UI hides/shows something by mode, point to the API gate that matches it (Rule 2).
3. If a setting's value set changed, confirm every reader and writer share the vocabulary (Rule 3).
4. If a setting is `saasVisible: false`, decide its effective `saasWritable` explicitly — omit it to inherit hidden ⇒ un-writable, or set `saasWritable: true` only when a dedicated page is the writer (Rule 4).
5. If mode behavior changed, the docs say which mode (Rule 5).
