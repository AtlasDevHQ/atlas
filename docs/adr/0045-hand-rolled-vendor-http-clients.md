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

## Amendment (2026-08-31, [#5569](https://github.com/AtlasDevHQ/atlas/issues/5569)): the deferral's trigger fired — `lib/vendor-http` exists, actions-scope

The alternative above declined the `lib/vendor-http` extraction *for now*, on one stated condition: the duplication "has not yet produced a cross-connector bug that the shared trio above didn't catch." The 2026-08-31 architecture survey found that it had, twice, in the action clients:

- **Timeout/abort** was present in the Linear action and absent in jira/github/salesforce — siblings written the same week. On a default deployment `executeWithTimeout(fn, undefined)` returns `fn()` unguarded, so a hung vendor host hung the agent turn.
- **The egress guard on a tenant-typed base URL** was present in Salesforce (`normalizeInstanceUrl`) and absent in Jira, on the same class of value: a `workspace_action_credentials` row typed by a tenant admin, with Basic auth attached to whatever host it names. Two independent derivations of one check, one of them missing.

[#5567](https://github.com/AtlasDevHQ/atlas/pull/5567) fixed both live instances directly, which left `isAbortError` as three verbatim marked copies. So the extraction is taken, at the scope the evidence supports:

**`packages/api/src/lib/vendor-http` owns exactly four concerns** — the discriminated result shape; bounded failure-detail narrowing (one definition of the 200-character truncation, and one statement of what that bound is for and what it is not); timeout/abort (one `isAbortError`, one deadline wrapper); and host pinning through `openapi/egress-guard`, which is consumed and did not move. The **five action clients** consume it. The ~10 `lib/brain/ingest` connectors adopt **opportunistically when next touched, not in this arc** — migrating connectors still being written is the cost this ADR declined in the first place, and it is still declined.

**This amendment refines; it does not reopen.** Everything above stays ratified, and three of this ADR's positions are named in the spine's own header as things it deliberately does not own, so that extending it into them is a visible act rather than a drift:

- **Retries and backoff** stay with `withRateLimitBackoff` / `ConnectorRateLimitError` per ADR-0030. Backoff belongs to the engine precisely so no vendor owns a retry policy; a retry helper in the spine would be a second one.
- **Token caching** stays a per-module security decision, on the fourth property above.
- **Vendor SDKs** stay declined by default, runtime and types-only alike, on all five grounds.

What changed is where four pieces of shared code live — not whether SDKs enter the tree, which is what this ADR decided. The rejected alternative's own framing holds: it "can be revisited later without reopening this decision." This is that revisit.
