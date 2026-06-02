/**
 * Boot-time shim: print `true` or `false` for whether the deployed container
 * should seed the demo dataset, resolved through the env-profile
 * (`ATLAS_SEED_DEMO` override → deploy-env profile default). `scripts/start.sh`
 * can't evaluate the TypeScript env-profile directly, so it shells out here and
 * reads stdout. See `packages/api/src/lib/env-profile.ts :: resolveSeedDemo`.
 *
 * COPYed into both the deploy/api and examples/docker images alongside
 * seed-demo.ts. Imports only the dependency-free env-profile module — no DB, no
 * network — so it resolves quickly and can't fail on connectivity.
 *
 * start.sh treats empty/garbage stdout as "resolver unavailable" and falls back
 * to the legacy raw `[ "$ATLAS_SEED_DEMO" = "true" ]` check, so a failure here
 * never silently disables demo seeding for the Railway "Atlas Demo" template.
 */
import { resolveSeedDemo } from "@atlas/api/lib/env-profile";

process.stdout.write(resolveSeedDemo() ? "true" : "false");
