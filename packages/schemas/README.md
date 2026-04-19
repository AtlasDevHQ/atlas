# @useatlas/schemas

Shared Zod schemas for the Atlas wire format. Single source of truth for
runtime validation on both the API route layer (`@atlas/api`, via
`@hono/zod-openapi`) and the web admin layer (`@atlas/web`, via
`useAdminFetch`).

## Why this exists

Before this package, the admin surface had parallel Zod schemas describing
the same wire shapes — one on the route (for OpenAPI + request validation)
and one on the web client (for response parsing). Renames and field
additions type-checked cleanly while both schemas kept the old key,
producing silent drift.

One source, imported from both sides, closes that drift window.

## What lives here

Only the wire-format schemas. Route-request validators, web-only form
schemas, and internal DB schemas stay local to their package. If a shape
crosses the network boundary and both API and web care about it, it
belongs here.

## Dependency direction

```
@useatlas/types  (pure TS, zero runtime)
        ↓
@useatlas/schemas  (adds Zod validators; re-exports @useatlas/types enum tuples)
        ↓
@atlas/api   @atlas/web
```

`@useatlas/schemas` must **never** import from `@atlas/api`, `@atlas/web`, or
`@atlas/ee`. This is enforced by an ESLint `no-restricted-imports` rule in
`eslint.config.mjs` scoped to `packages/schemas/**` — an upward import
fails lint, not just review. Keeping `@useatlas/types` Zod-free preserves
zero-dep imports for SDK consumers.

## Publishing

Currently `private: true`. We'll flip to published (`@useatlas/schemas
0.0.1`) once a meaningful slice of the schema surface has migrated — the
react package and external SDK users will need it at that point, but not
before.

## Follow-up schemas to migrate

Tracked in #1648 (follow-up tracker; #1642 was the scaffold-plus-abuse PR). Next
candidates (highest drift risk first):

1. `ApprovalRule` / `ApprovalRequest` — complex nested shapes.
2. `CustomDomain` — DNS-verification-status union is easy to drift.
3. `IntegrationStatus` family (10 platforms × the same shape).
4. `PlatformWorkspace` / `NoisyNeighbor` / `BillingStatus`.
5. Region/SLA/Backup/Audit analytics shapes.

Migrate one schema per PR so each change stays reviewable and the OpenAPI
diff is inspectable at merge time.
