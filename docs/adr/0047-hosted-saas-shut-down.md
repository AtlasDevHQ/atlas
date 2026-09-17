# The hosted service is shut down; Atlas continues as open source

Status: accepted (2026-09-17, maintainer decision)

Atlas ran as a hosted, multi-region SaaS: `app`, `api`, `mcp` and `www` under `useatlas.dev`, the docs at `docs.useatlas.dev`, an anonymous NovaMart demo behind `/mcp/demo`, and a `staging` environment that mirrored prod. All of it ran on one Railway project.

This ADR records the decision: **the hosted service and every environment behind it are shut down. Atlas continues as AGPL open source that people run themselves, and there is no Atlas-operated endpoint for any client to default to.**

## Why

Three reasons, none sufficient alone:

- **Cost.** The project bill was dominated by always-on memory, and an idle region cost the same as a busy one. Parking `eu` and `apac` (#5582) cut 43% and still left a monthly bill for a service nobody was using.
- **No traction.** Measured against the three regional internal databases just before the shutdown: **3 external signups** across all regions, **0 subscriptions**, and **0 conversations by an external user in the preceding 30 days**. The rest of the activity was seeded admin accounts and the demo workspace.
- **Time.** Operating a hosted service (releases to prod, regional parity, secrets, soak on staging) took time that the product did not return.

## What was deleted

The entire Railway project contents, in both `production` and `staging`:

- services `api`, `web`, `www`, `docs`, `demo-data`, `api-eu`, `api-apac`, `api-staging`, `web-staging`
- databases `us-int-postgres`, `eu-int-postgres`, `apac-int-postgres`, `staging-postgres`, and both `backup-scratch-*` instances, with all their volumes
- the `atlas-backups-us`, `atlas-backups-eu` and `atlas-backups-staging` buckets

Before deletion every database was dumped with `pg_dump -Fc` and each dump was verified to list its tables with a Postgres 18 `pg_restore`. Those dumps, held privately by the maintainer, are the only remaining copy of any hosted data. Nothing restores automatically, and nothing in this repo references them.

## What stays

- **The code, under the same licenses.** AGPL-3.0 for the server and core, MIT for the client libraries and plugins, the commercial license for `ee/`. The SaaS code paths (deploy mode `saas`, residency, billing, the MCP OAuth spine) stay in the tree: a self-hoster may run them, and deleting them would be a large change with no user to benefit.
- **The published npm packages.** `@useatlas/mcp` stops defaulting `init --hosted` and `init --demo` to `mcp.useatlas.dev`; both now require `--api-url` or `ATLAS_PUBLIC_API_URL` and otherwise fail with a message pointing at `init --local`.
- **Self-hosting**, via `bun create atlas-agent`, Docker, or a deploy of the monorepo.

## What follows from it

- Any guidance about prod, staging, regions, parked regions, releasing to prod, `railway ssh`, or verifying a deployed surface describes infrastructure that no longer exists. It is history, not procedure.
- Workflows that could only target the hosted service (`staging-smoke.yml`, `load-test-mcp.yml`) are removed.
- Milestone 103 (the launch cycle) has no surface to launch and closes unfinished.

## Undecided

- **Where the docs are served.** `docs.useatlas.dev` is down; the source stays in `apps/docs/content`, and the README links there. Static hosting (GitHub Pages or similar) is an open question.
- **Whether `apps/www` stays in the tree.** It no longer deploys anywhere.
