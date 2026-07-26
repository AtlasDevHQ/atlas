---
name: publish-package
description: Publish or bump an @useatlas/* npm package. Use when bumping a version in packages/types, schemas, sdk, react, plugin-sdk, or webhook-publisher, when pushing release tags, or when Deploy Validation scaffolds fail on npm install after a version change.
---

# Publishing `@useatlas/*` packages

For `0.0.x` semver, `^0.0.2` pins **exactly** to `0.0.2` — `^` buys you nothing below `0.1.0`. That is why ref bumps must be sequenced after the publish lands, or Deploy Validation scaffolds fail when `npm install` hits the registry for a version that isn't there yet.

## The three-step sequence

1. **Feature PR** — bump `version` in the package's own `package.json`, but **keep** dependency refs in `sdk` / `react` / templates at the old version.
2. **After merge** — tag the release (`git tag types-v0.0.4 && git push origin types-v0.0.4`) and wait for the publish workflow to finish.
3. **Then** push a follow-up bumping refs in `packages/sdk`, `packages/react`, `create-atlas/templates/*/package.json`.

## ⚠️ Never push more than 3 release tags in one `git push`

GitHub fires **no** `push` event for tags when more than 3 land in a single push, so `publish.yml` runs for none of them — the tags land on the remote and nothing publishes, silently. Push in groups of ≤3, or one at a time.

Caught 2026-06-15 backfilling 6 tags: published nothing.

## Guards that keep this honest

- `scripts/check-published-symbols.ts` — catches "added a new export and used it before publishing". Diffs braced **value** imports from `@useatlas/*` in scaffold-bound source against the pinned published version; type-only imports are skipped.
- `scripts/check-unpublished-versions.ts` (in the `drift` CI job) — fails when a publishable package's version is on `main` but not on npm and the current change didn't introduce the bump, i.e. a merged bump whose post-merge publish was forgotten. npm is the oracle; the bumping PR is exempt so it stays green.
- `publish.yml` publishes via `scripts/npm-publish-if-new.sh`, which skips when `name@version` is already on npm — so re-tagging an already-published version is a green no-op, not a 403.

## Scope

Published: `types`, `schemas`, `sdk`, `react`, `plugin-sdk`, `webhook-publisher`. Note `@useatlas/schemas` carries the public scope but is **internal-only and never publishes**. Everything under `@atlas/*` is internal, including `oauth-helper`.
