import { test as setup, request as playwrightRequest } from "@playwright/test";
import path from "path";
import { API_URL, signInMultiEnvAdmin } from "./lib/multi-env-helpers";

/**
 * Setup project for the multi-env content-routing specs (#2441 follow-on).
 *
 * Each spec in the `multi-env` project would otherwise authenticate on its
 * own — six sign-ins + 18 TOTP attempts per `playwright test` invocation,
 * which busts Better Auth's per-identifier rate limit (10 sign-ins / 60s
 * AND 10 2FA verifies / 60s — surfaces as `429 Too many requests`). This
 * setup authenticates once, persists the cookie jar to a dedicated storage
 * state file, and every spec loads it via `test.use({ storageState })`.
 *
 * Why a project-scoped setup (not `globalSetup`):
 *   - `globalSetup` is a single function that runs before all projects and
 *     doesn't have access to Playwright fixtures the same way a setup spec
 *     does. The project-dep setup pattern is what the chromium project
 *     already uses for its own admin sign-in.
 *   - Keeping setup as a spec keeps its skip / error reporting consistent
 *     with the rest of the suite (you see the auth failure in the same
 *     reporter, not as a swallowed `globalSetup` exception).
 */

const STORAGE_STATE = path.join(__dirname, "multi-env-storage.json");

export { STORAGE_STATE };

setup("authenticate multi-env admin", async () => {
  const request = await playwrightRequest.newContext({ baseURL: API_URL });
  try {
    await signInMultiEnvAdmin(request);
    await request.storageState({ path: STORAGE_STATE });
  } finally {
    await request.dispose();
  }
});
