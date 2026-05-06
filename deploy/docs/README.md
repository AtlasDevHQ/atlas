# `deploy/docs` — Railway docs service

Production deploy config for `docs.useatlas.dev` (Railway service `docs`,
project `satisfied-creation`).

## `GITHUB_TOKEN` (required for SaaS, optional for self-hosted)

Powers the **Last updated on …** line at the bottom of every docs page via
Fumadocs' `getGithubLastEdit` (called from
`apps/docs/src/app/(docs)/[[...slug]]/page.tsx`). Without it, the build hits
unauthenticated GitHub API, rate-limits after ~60 pages, and the silent
catch in `getLastUpdate` swallows every error — timestamps disappear from
the production site with no operator signal. That's the failure mode #2103
captures.

### How it's wired

1. **Railway service variable** named `GITHUB_TOKEN` on the `docs` service.
2. **Build-arg propagation** — Railway only forwards service variables to
   Docker builds when the Dockerfile declares them as `ARG`. `Dockerfile`
   does this in the builder stage:
   ```dockerfile
   ARG GITHUB_TOKEN
   ENV GITHUB_TOKEN=$GITHUB_TOKEN
   ```
3. **Canary** — after `next build` completes, `scripts/check-docs-canary.sh`
   asserts a few representative prerendered pages contain a "Last updated on"
   line. Fails the build with an actionable error if not. Skipped when
   `GITHUB_TOKEN` is unset (self-hosted).

### Token format

Fine-grained PAT scoped to one repo:

- Resource owner: `AtlasDevHQ`
- Repository access: `atlas` only
- Repository permissions: **Contents: Read-only**
- Expiration: 1 year (set a calendar reminder before expiry — the canary
  will fail the deploy when the token stops working, but a calendar nudge
  beats finding out via a red CI build)

Generate at <https://github.com/settings/personal-access-tokens>.

### Rotation

1. Generate a new fine-grained PAT with the scope above.
2. Update the `GITHUB_TOKEN` variable on the Railway docs service.
3. Trigger a redeploy (`railway redeploy --service docs --yes`, or push any
   change under `apps/docs/**`).
4. Verify: `curl -s https://docs.useatlas.dev/guides/mcp | grep -c "Last updated on"`
   — should be ≥1.

### Self-hosted

The token is **not required** for self-hosted operators. The build will
print a "skipping last-updated canary" notice and the deployed docs site
will simply not show "Last updated on" lines. Everything else works.

## Other env vars

None. The docs site is statically built — no runtime DB, no API calls.
