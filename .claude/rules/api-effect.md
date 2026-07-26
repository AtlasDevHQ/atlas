---
paths:
  - "packages/api/src/**"
  - "ee/src/**"
---

# Effect.ts service architecture

- [ ] **Use Context.Tag for services** — `class Foo extends Context.Tag("Foo")<Foo, FooShape>()`. Interfaces are `FooShape` with `readonly` fields
- [ ] **Layer.effect vs Layer.scoped** — `Layer.scoped` when the service has a finalizer (cleanup on shutdown); `Layer.effect` for stateless
- [ ] **Tagged errors via Data.TaggedError** — Never plain `Error` subclasses with `_tag`. Use `Data.TaggedError("ErrorName")<{ ... }>`
- [ ] **runHandler for route handlers** — `runHandler(c, "label", async () => { ... })` bridges Hono → Effect Context and centralizes error-to-HTTP mapping
- [ ] **No `catch: (err) => err`** — In `Effect.tryPromise`, always normalize: `catch: (err) => err instanceof Error ? err : new Error(String(err))`. **Carve-out:** `lib/effect/semantic-generator.ts`'s profile `tryPromise` intentionally uses `catch: (err) => err` to preserve the raw rejection's identity (a cooperative `OperationCancelledError` from the MCP progress bridge) so the downstream `catchAll` can route cancellation → defect; normalizing there would erase the identity and surface a spurious `validation_failed`. Don't "fix" it
- [ ] **satisfies on service returns** — Always `satisfies FooShape` on returned service objects
- [ ] **Effect test layers + no top-level singleton mutation** — Prefer `Layer.provide` test layers over `mock.module()`; never mutate a registry/singleton at test module top-level. See [docs/development/testing.md](docs/development/testing.md)

## Core Tags

Backend services use Effect.ts for DI, typed errors, and lifecycle. Core Tags live in `packages/api/src/lib/effect/`:

| Service | File | Provides |
|---------|------|----------|
| `ConnectionRegistry` | `services.ts` | Analytics DB pools, health checks, metrics |
| `PluginRegistry` | `services.ts` | Plugin lifecycle, health checks |
| `RequestContext` | `services.ts` | `{ requestId, startTime }` per request |
| `AuthContext` | `services.ts` | `{ mode, user, orgId }` per request |
| `DurableSession` / `DurableState` | `services.ts` | Per-step checkpoints + durable memory (ADR-0020) |
| `Migration` | `services.ts` | Internal-DB migration runner |
| `AtlasAiModel` | `ai.ts` | Configured LLM (Vercel AI SDK LanguageModel) |
| `InternalDB` | `db/internal.ts` | Internal Postgres pool |
| `Settings` | `layers.ts` | Runtime settings registry (hot-reload) |
| `SemanticSync` | `layers.ts` | Startup semantic-layer sync |
| `Telemetry` / `Config` / `Scheduler` | `layers.ts` | OTel handle · resolved atlas.config.ts · scheduler lifecycle |

Enterprise seams (residency, masking, approvals, marketplace, SaaS CRM, …) are additional Tags in `services.ts` behind Noop layers — see **Enterprise & SaaS Gating** above.

- **Hono bridge:** `runHandler(c, "label", async () => { ... })` wraps every route handler — provides `RequestContext` + `AuthContext`, centralizes error-to-HTTP via `classifyError()`
- **Startup:** `buildAppLayer(config)` composes startup Layers (telemetry, migrations, semantic sync, settings, scheduler) into one DAG; `ManagedRuntime.make(appLayer)` boots eagerly
- **Tagged errors:** in `errors.ts` via `Data.TaggedError`; exhaustive `mapTaggedError()` switch maps each to HTTP status (compile-time check via `ATLAS_ERROR_TAG_LIST`)
- **Test utilities:** `__test-utils__/layers.ts` provides `TestAppLayer`, `TestAdminLayer`, `TestPlatformLayer`, `runTest()`, `buildTestLayer()`
