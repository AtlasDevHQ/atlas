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
