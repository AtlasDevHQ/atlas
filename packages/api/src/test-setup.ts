/**
 * Global test preload — strips ATLAS_*, BETTER_AUTH_*, DATABASE_URL, and
 * provider API keys (ANTHROPIC_API_KEY, etc.) before any test file loads,
 * preventing the developer's real .env from leaking into tests.
 *
 * Individual tests set the vars they need in beforeEach; this preload ensures a
 * clean baseline. Original values are restored in a top-level afterAll so the
 * process isn't permanently modified.
 */

import { afterAll } from "bun:test";

const prefixes = ["ATLAS_", "BETTER_AUTH_"];
const exactVars = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

// Snapshot current values so we can restore them after the entire suite
const snapshot: Record<string, string> = {};

for (const key of Object.keys(process.env)) {
  if (prefixes.some((p) => key.startsWith(p)) || exactVars.includes(key)) {
    snapshot[key] = process.env[key]!;
    delete process.env[key];
  }
}

afterAll(() => {
  // Restore snapshotted vars
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
});
