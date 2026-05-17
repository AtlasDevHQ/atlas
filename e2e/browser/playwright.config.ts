import { defineConfig, devices } from "@playwright/test";
import path from "path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const STORAGE_STATE = path.join(__dirname, "storage-state.json");

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Limit workers — LLM-tagged tests can overwhelm the API with concurrent requests
  workers: process.env.CI ? 1 : 3,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    // Setup: login and save storage state
    {
      name: "setup",
      testMatch: /global-setup\.ts/,
    },
    // Local tests (require dev server on :3000/:3001). Multi-env content-
    // routing specs (`multi-env-tracer` + the five group-scoped specs added
    // for #2441) are excluded — they each do their own MFA-aware sign-in
    // and run via the `multi-env` project below. The route-mock UI
    // integration spec (`multi-env-admin.integration.spec.ts`) DOES belong
    // here — it relies on the chromium project's storage state.
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE,
      },
      dependencies: ["setup"],
      testIgnore: [
        /production\.spec\.ts/,
        /multi-env-tracer\.spec\.ts/,
        /multi-env-dashboards\.spec\.ts/,
        /multi-env-semantic-ambiguity\.spec\.ts/,
        /multi-env-pii-bleed\.spec\.ts/,
        /multi-env-approvals\.spec\.ts/,
        /multi-env-scheduled-runonce\.spec\.ts/,
      ],
    },
    // Setup for the multi-env project — one-time MFA-aware sign-in that
    // persists cookies to `multi-env-storage.json`. Avoids burning Better
    // Auth's sign-in + 2FA verify rate limits per spec.
    {
      name: "multi-env-setup",
      testMatch: /multi-env-setup\.ts/,
    },
    // Multi-env content-routing specs — real API + real Postgres. Each spec
    // loads the shared storage state from `multi-env-setup` so total
    // sign-ins per `playwright test` invocation = 1. Specs that touch
    // internal-DB rows (PII, approvals) additionally connect to
    // `DATABASE_URL` directly via `pg.Client`. The original tracer spec
    // (`multi-env-tracer.spec.ts`) keeps its own in-test sign-in flow
    // because it deliberately validates the auth contract end-to-end.
    {
      name: "multi-env",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /multi-env-(tracer|dashboards|semantic-ambiguity|pii-bleed|approvals|scheduled-runonce)\.spec\.ts/,
      dependencies: ["multi-env-setup"],
      workers: 1,
    },
    // Production smoke tests (no auth, uses absolute URLs from env vars)
    {
      name: "production",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /production\.spec\.ts/,
    },
  ],
});
