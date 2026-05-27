# How to verify CRM changes locally

The `atlas ops smoke-crm` CLI mechanizes the manual A1–A4 / B7 / C9 / D12
verification flow used during the 1.6.0 milestone. It exists because the
filter-syntax regression in PR #2865 silently corrupted every customer
Person record in production for several days before manual smoke caught
it. Running this command on every PR that touches the CRM dispatch
pipeline turns that into a one-line check.

## When to run

Run before opening any PR that touches:

- `plugins/twenty/src/client.ts` — the Twenty REST client.
- `plugins/twenty/src/lead-normalizer.ts` — the `AtlasLeadEvent`
  → Twenty payload translation.
- `ee/src/saas-crm/index.ts` — the SaaS dispatcher Layer.
- `packages/api/src/lib/lead-outbox/outbox.ts` — the outbox flusher and
  retry / dead-letter logic.
- Anything that changes the wire format on `crm_outbox.payload`.

It's a local-only check. The smoke command runs against your local
Atlas dev DB and the live `crm.useatlas.dev` Twenty workspace, and is
not wired into CI today (the CI integration depends on a CI-only
Twenty workspace + secret-rotation strategy that isn't built yet).

## Prerequisites

1. `bun run db:up` — local Postgres + sandbox sidecar running.
2. `bun run dev:api` — Atlas API booting, which starts the `crm_outbox`
   flusher. The smoke command enqueues rows and waits for that flusher
   to drain them.
3. A Twenty API bearer token in the env (or pass `--twenty-api-key`).
   For Atlas's own SaaS workspace, the token lives in the api service
   on Railway as `TWENTY_API_KEY`; for a self-hosted Twenty, generate one
   under Twenty → Settings → API & Webhooks.

## Usage

```bash
# Required: a persona fixture. Default fixture lives at
# scripts/test-fixtures/crm-personas.yml and covers 10 personas across
# every lead variant (4× sales-form, 1 demo, 1 signup, 1 demo→signup
# stickiness pair, 1 demo→demo idempotency pair).
bun run atlas -- ops smoke-crm \
  --personas ./scripts/test-fixtures/crm-personas.yml \
  --twenty-api-key "$TWENTY_API_KEY"

# Wipe the Twenty workspace before running — DESTRUCTIVE. Mirrors the
# `ops wipe` double-confirm gate: needs BOTH the flag AND
# ATLAS_SMOKE_WIPE_OK=1 in the env.
ATLAS_SMOKE_WIPE_OK=1 \
  bun run atlas -- ops smoke-crm \
    --personas ./scripts/test-fixtures/crm-personas.yml \
    --twenty-api-key "$TWENTY_API_KEY" \
    --wipe-twenty

# Tune the drain timeout (default 60s). The Twenty hosted instance can
# be slow under spike load — raise this if you see TIMEOUT exits.
bun run atlas -- ops smoke-crm \
  --personas ./scripts/test-fixtures/crm-personas.yml \
  --timeout-seconds 120
```

## Exit codes

Pinned so chained scripts can branch on the failure mode:

| Code | Meaning                                                    |
|------|------------------------------------------------------------|
| 0    | Clean diff — every expected Person + Note matches Twenty.  |
| 1    | Usage error — bad args, missing env, fixture parse failure |
| 2    | `crm_outbox` did not drain within `--timeout-seconds`.     |
| 3    | Diff dirty — what Twenty observed ≠ what the fixture said. |
| 4    | Wipe phase failed (FK cascade, network, etc.).             |

A diff-dirty exit (3) prints a structured report identifying:

- Missing Persons (expected emails that aren't in Twenty).
- Field mismatches (`atlasFirstSource` / `atlasLastSource` / `name.*`).
- Missing Notes (expected note titles not attached to the right Person).
- Note count mismatches per Person (the signature of the #2865 bug —
  all expected Persons collapse onto one observed Person, and every
  expected Note piles up on it).

## What this catches that the unit tests don't

Mock-based unit tests can verify the URL the client constructs, but they
can't verify Twenty actually interprets that URL correctly. The #2865
filter syntax bug was invisible to mock tests because the URL substring
matched both the correct and broken forms. The smoke command is the
first check that asserts on Twenty's actual response — `N` distinct
enqueues → `N` distinct Persons.

## What this doesn't cover (manual still required)

- **Form-layer concerns** — Cloudflare Turnstile siteverify, CSP, the
  `<noscript>` mailto fallback, and the `/api/v1/contact` route's auth +
  rate-limit. The smoke command injects leads BELOW the form, so any
  bug in the form layer itself needs a manual test (submit a form on
  `/pricing` and confirm the resulting `crm_outbox` row).
- **Read-side datasource verification** — the analytics-side `demo_leads`
  / `crm_outbox` query semantics live under a separate slice (#2728).
- **Stripe → Twenty conversion stamping (D12)** — parked behind a flag
  in the default fixture pending Stripe test-fixture wiring.

## Extending the fixture

Adding a persona is one block under `personas:` in
`scripts/test-fixtures/crm-personas.yml`. The shape is the same as the
`AtlasLeadEvent` discriminated union — `parseFixtureYaml` validates each
persona's required-field set against its `source`. The parser fails
loudly on the first invalid persona with a per-index error message;
there's no "best-effort" parsing mode.

The shipped fixture is deliberately small (10 personas) so the smoke
command runs in under a minute on a local Postgres. If your change
needs broader coverage, prefer a second fixture file over expanding the
default — separate fixtures keep the manual + automated runs from
diverging.
