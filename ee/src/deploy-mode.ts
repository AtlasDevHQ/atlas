/**
 * Deploy mode detection for Atlas Enterprise.
 *
 * Resolves `ATLAS_DEPLOY_MODE` (env var or settings) to a binary
 * `"saas" | "self-hosted"` value. The `"saas"` mode requires enterprise
 * to be enabled — without it, deploy mode always resolves to `"self-hosted"`.
 *
 * Slice 10/11 of #2017 (#2572) moved the resolver to core
 * (`@atlas/api/lib/effect/deploy-mode`) so `lib/config.ts:applyDeployMode`
 * could stop dynamic-importing from `@atlas/ee`. This file is now a thin
 * re-export — same behavior, no behavior change for either SaaS or
 * self-hosted.
 */

import { resolveDeployMode } from "@atlas/api/lib/effect/deploy-mode";

export { resolveDeployMode };
