# Vendor HTTP clients are hand-rolled against fetch, and that is the ratified pattern

Status: accepted (2026-08-30, arch-backlog decision session — [#4975](https://github.com/AtlasDevHQ/atlas/issues/4975))

Every vendor integration in this repo hand-rolls its HTTP client against `fetch` — Zoom, Slack, Confluence (Cloud + DC), GitBook, Intercom, Front, Freshdesk, Zendesk, Notion, Salesforce, Outlook/Microsoft Graph — and zero vendor SDKs are in the tree, including for vendors that publish good ones (Notion, Microsoft). Until now that was a precedent that had only ever been repeated, its reasoning living in per-connector module headers. This ADR makes it the decision: **new vendor integrations hand-roll their client; vendor SDKs (runtime *and* types-only) are declined by default.**

## Why hand-rolling is load-bearing, not habit

Four properties of the architecture are each something an SDK's headline features actively fight:

1. **The non-throwing result contract.** `BrainSourceVendorClient` and the ADR-0030 knowledge-connector seam are built on `{ ok: true, … } | ReadError`, so the caller decides per read whether a failure is fatal to a record, a collection, or a pass. Every SDK throws, so an SDK-backed client gets wrapped straight back into this shape — the SDK version of a connector is the hand-rolled file plus a dependency tree.
2. **Backoff belongs to the engine.** ADR-0030 puts 429 handling in the shared connector engine (`withRateLimitBackoff`, fed by the one shared `ConnectorRateLimitError`) precisely so no vendor has its own retry policy. SDKs retry internally by default; adopting one means disabling its best feature.
3. **Guards on vendor-supplied URLs.** `@odata.nextLink` (Graph) and signed CDN redirects (Zoom) are SSRF surfaces this repo pins or routes through `guardedFetch` explicitly. SDK pagination and redirect middleware are exactly where those guards would be bypassed.
4. **Token caching is a security decision here.** Ingest clients deliberately do NOT cache tokens across passes — a process-wide cache is a cross-tenant object holding decrypted-credential derivatives on a shared region process. `@azure/identity` and friends cache by design.

Types-only SDK packages fall to a fifth: these modules parse from `unknown` on purpose, because a missing field is a runtime condition the guards exist to catch, and a compile-time vendor model asserts it is present.

## The accepted cost, stated honestly

Roughly ten near-identical files of pagination, error mapping, Retry-After parsing, and defensive JSON narrowing, each with its own bugs; the Retry-After parser has been written from scratch at least three times; vendor drift is discovered in production rather than at `bun install`. This bill is known and accepted. What already IS shared stays the *only* shared surface: `ConnectorRateLimitError` (`lib/knowledge/connectors.ts`), `withRateLimitBackoff` (`lib/knowledge/connector-sync.ts`), and `guardedFetch` (`lib/openapi/egress-guard.ts`).

## Alternatives rejected

- **Extract the shared half** (`lib/vendor-http` owning the result shape, Retry-After parsing, host pinning, content-length pre-filtering, defensive narrowing) — the issue's own leaning, and declined *for now*, not refuted: it is a refactor that can be revisited later without reopening this decision, since it changes where the shared code lives, not whether SDKs enter the tree. It was declined because proving the seam mid-arc means migrating connectors still being written, and the duplication, while real, has not yet produced a cross-connector bug that the shared trio above didn't catch.
- **Adopt SDKs where they're good** (Notion, Graph), wrapped back into the result contract — rejected because the wrapper re-implements the connector anyway and the four properties above still have to be switched off or fought per SDK.

## The template header

A new connector's client module opens with a header stating, in order: (1) the discriminated result contract and which error becomes `ConnectorRateLimitError`; (2) "Why not `<vendor SDK>`" — cite this ADR and state which of the four properties the SDK fights; (3) the token-handling posture (fetched per pass, held in closure, never module-cached — and why); (4) every vendor-supplied URL the module follows and the guard on it. `packages/api/src/lib/brain/ingest/outlook/api.ts` is the reference example — copy its header shape, not the last connector's code.

See also: ADR-0030 (the engine/vendor split this pattern serves); #4975 (the decision record and the duplication inventory).
