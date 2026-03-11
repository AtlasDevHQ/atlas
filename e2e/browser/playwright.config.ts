import { defineConfig, devices } from "@playwright/test";
import path from "path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const STORAGE_STATE = path.join(__dirname, "storage-state.json");

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Limit workers to avoid overwhelming the LLM API with concurrent chat requests
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
    // Local tests (require dev server on :3000/:3001)
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE,
      },
      dependencies: ["setup"],
      testIgnore: /production\.spec\.ts/,
    },
    // Production smoke tests (no auth, different base URL)
    {
      name: "production",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /production\.spec\.ts/,
    },
  ],
});
