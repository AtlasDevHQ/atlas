# `@atlas/ee` symlink stub

Minimal `@atlas/ee` package used by the `ee-stub-build` CI job to prove
that the AGPL core (`packages/api`) has zero structural coupling to
the commercial-licensed `ee/` directory.

The job rsyncs this directory's contents over `ee/`, runs `bun install`
to refresh the workspace symlinks, then runs `bun run type` against
the core. If anything in `packages/api/src/` imports from `@atlas/ee`
beyond the one allowed boot-time composition file
(`lib/effect/enterprise-layer.ts`, which only needs `EELayer`), the
type-check fails — locking in the inversion landed across slices
#2563 through #2585 of milestone 1.5.1.

Not used at runtime. Not published. Not consumed by any production
deploy. Updated when (and only when) `ee/src/layers.ts`'s exported
surface changes — keep the export shape in lockstep with the real
aggregator.
