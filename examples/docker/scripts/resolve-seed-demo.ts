/**
 * Boot-time shim: print `true` or `false` for whether the deployed container
 * should seed the demo dataset, resolved through the env-profile
 * (`ATLAS_SEED_DEMO` override → deploy-env profile default). `scripts/start.sh`
 * can't evaluate the TypeScript env-profile directly, so it shells out here and
 * reads stdout. See `packages/api/src/lib/env-profile.ts :: resolveSeedDemo`.
 *
 * IMPORTANT — the import is RELATIVE, not `@atlas/api/lib/env-profile`. This
 * file is COPYed into the deploy/api and examples/docker images at
 * `/app/scripts/` and only ever runs from there (via `bun /app/scripts/...`).
 * From outside the `@atlas/api` package there is no `node_modules/@atlas/api`
 * to resolve (bun's package self-reference only works for files *inside* the
 * package, and COPY doesn't reliably preserve workspace symlinks across Docker
 * drivers — see the symlink-rebuild notes in the Dockerfiles). The relative
 * path `../packages/api/...` resolves by filesystem against this file's runtime
 * location `/app/scripts/` → `/app/packages/api/src/lib/env-profile.ts`, which
 * is always COPYed. env-profile.ts is dependency-free, so the relative import
 * pulls in nothing else. The repo path (examples/docker/scripts/) is excluded
 * from tsconfig, so the path is never type-checked against the repo layout; the
 * Dockerfiles assert it resolves at build time.
 *
 * start.sh treats any output other than exactly `true`/`false` as "resolver
 * unavailable" and falls back to the legacy raw `[ "$ATLAS_SEED_DEMO" = "true" ]`
 * check, so a failure here never silently disables demo seeding for the Railway
 * "Atlas Demo" template.
 */
import { resolveSeedDemo } from "../packages/api/src/lib/env-profile";

process.stdout.write(resolveSeedDemo() ? "true" : "false");
