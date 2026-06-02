# Staging environment

Staging is the **soak environment** that sits between `main` and a tag-gated prod
deploy. Every merge to `main` deploys to staging automatically; prod only moves
when a release tag is cut (see [release-process.md](./release-process.md) and
[ADR-0008](../adr/0008-versioning-and-release-tags.md)). Staging is where we
dogfood a change against production-shaped infrastructure before it can reach
customers.

> **Status:** the staging services are provisioned and green; some repo-side
> config and HITL provisioning slices are still in flight
> ([milestone #57](https://github.com/AtlasDevHQ/atlas/milestone/57)). Update
> this runbook as those land.

## URLs

| Surface | Staging                      | Prod                  |
| ------- | ---------------------------- | --------------------- |
| App     | `app.staging.useatlas.dev`   | `app.useatlas.dev`    |
| API     | `api.staging.useatlas.dev`   | `api.useatlas.dev`    |
| Landing | `www.staging.useatlas.dev`   | `useatlas.dev`        |

## How you know you're on staging

The web app shell renders a full-width **amber "Staging environment" banner** on
every page (including pre-sign-in) whenever the API reports it is the staging
deploy. It is driven by `StagingBanner`
(`packages/web/src/ui/components/staging-banner.tsx`), which reads `region` from
the public `GET /api/health` response:

- The API stamps `region: "staging"` when `ATLAS_API_REGION=staging` (resolved by
  `getApiRegion()` in `packages/api/src/lib/residency/misrouting.ts`, surfaced in
  `health.ts`).
- The banner renders nothing on production regions (`us` | `eu` | `apac`) and on
  self-hosted/dev deploys (no region), so there is no layout shift outside
  staging.

If you ever see a tab with **no** amber banner that you *think* is staging, treat
it as production until proven otherwise — check `GET /api/health` directly.

## Outbound mail is clamped to a sink

Staging runs the **real** email-delivery code against real providers (Resend,
etc.), so without a guard a soak could email real-looking customer addresses and
burn sender reputation. Every outbound email is therefore redirected to a single
sink before the provider send (#2913):

- `sendEmail` (`packages/api/src/lib/email/delivery.ts`) routes every message
  through `clampOutbound` (`packages/api/src/lib/staging/clamp.ts`), which
  rewrites the recipient to `STAGING_MAIL_SINK` (default
  `staging-mail@useatlas.dev`). Subject, body, and headers are preserved.
- The clamp is **fail-closed** (#2985): it keys off `ATLAS_DEPLOY_ENV=staging`
  (the authoritative soak-box signal), so a misconfigured or fat-fingered
  `ATLAS_API_REGION` — even a *valid* prod value like `us` — cannot silently
  disable it. On a staging-shaped deploy, mail is **always** clamped.
- Boot **hard-fails** if a staging deploy doesn't also stamp
  `ATLAS_API_REGION=staging` (`assertStagingMailRegion`, wired into
  `StagingSeedLive`). A mislabeled staging box never serves — it exits non-zero
  at boot rather than risk real mail.
- If a staging box ever sends an email while `ATLAS_API_REGION` has drifted from
  `staging`, the wiring layer logs a warn (keys only — no recipient/body) so the
  drift is visible; fix it by setting `ATLAS_API_REGION=staging` on the service.

> **cc / bcc / replyTo are not yet redirected** — the current `EmailMessage` has
> only `to`. Adding any new recipient field means extending the clamp too
> ([#2984](https://github.com/AtlasDevHQ/atlas/issues/2984)).

## Deploy trigger model

| Branch / ref         | Target                          | Trigger                                   |
| -------------------- | ------------------------------- | ----------------------------------------- |
| `main`               | staging (api / app / www)       | every merge, automatically                |
| `v*.*.*` tag → `prod` | prod (api / api-eu / api-apac / web / www) | `/release` fast-forwards `prod` to the tag SHA |
| `docs`               | docs.useatlas.dev               | direct from `main`                        |

The `prod` branch is a Railway-tracking artifact advanced only by `/release`
(`git push origin <tag-sha>^{}:prod --force-with-lease`). No PRs target `prod`.

## Operational rules

- **New integrations start on staging.** When adding a chat platform, action
  target, or datasource, create the staging app/credentials first and soak there.
  Never OAuth-register a new platform straight against prod.
- **Staging mirrors prod config, not prod data.** Don't assume staging shares a
  database or secrets with prod; provision its own.
- **A red staging run blocks the tag.** `/ci` runs before a release tag is cut, so
  a staging regression should be caught and fixed on `main` before `/release`.

## Smoke check

After a `main` merge deploys to staging:

1. Load `app.staging.useatlas.dev` — confirm the amber banner is present.
2. `curl https://api.staging.useatlas.dev/api/health` — confirm `200` and
   `"region":"staging"` in the body.
3. Sign in and run a query end-to-end against the staging datasource.
4. Trigger an email (e.g. a password reset) and confirm it lands in the
   `STAGING_MAIL_SINK` inbox, **never** the real recipient — the outbound clamp
   is working.
