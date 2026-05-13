/**
 * Atlas SaaS configuration — app.useatlas.dev
 *
 * This config is used by all 3 regional API services (us, eu, apac).
 * Secrets and per-service values stay in Railway env vars; this file
 * defines the application-level configuration that's the same everywhere.
 *
 * Region-specific database URLs are read from env vars so the same Docker
 * image works for all regions:
 *   - ATLAS_REGION_US_DB_URL (defaults to DATABASE_URL)
 *   - ATLAS_REGION_EU_DB_URL
 *   - ATLAS_REGION_APAC_DB_URL
 */

import { defineConfig } from "./packages/api/src/lib/config";

export default defineConfig({
  // ── Datasource ──────────────────────────────────────────────────
  // The default analytics datasource — env var fallback handles this,
  // but being explicit here for documentation.
  datasources: {
    default: {
      url: process.env.ATLAS_DATASOURCE_URL!,
    },
  },

  // ── Tools ───────────────────────────────────────────────────────
  tools: ["explore", "executeSQL"],

  // ── Auth ────────────────────────────────────────────────────────
  auth: "managed",

  // ── Deploy Mode ─────────────────────────────────────────────────
  deployMode: "saas",

  // ── Enterprise ──────────────────────────────────────────────────
  enterprise: {
    enabled: true,
  },

  // ── Sandbox ─────────────────────────────────────────────────────
  // SaaS sandbox priority: Vercel Sandbox (Firecracker microVM, per-request
  // isolation) is the primary backend; sidecar is the fallback if the
  // Vercel API is unreachable. Off-Vercel auth requires VERCEL_TEAM_ID,
  // VERCEL_PROJECT_ID, and VERCEL_TOKEN env vars on the Railway service.
  // No just-bash fallback in SaaS — config-priority chains throw if all
  // listed backends fail, which is the correct behavior for multi-tenant.
  sandbox: {
    priority: ["vercel-sandbox", "sidecar"],
  },

  // ── Connection Pool ─────────────────────────────────────────────
  pool: {
    perOrg: {
      enabled: true,
      maxConnections: 5,
      idleTimeoutMs: 30_000,
      maxOrgs: 50,
    },
  },

  // ── Scheduler ───────────────────────────────────────────────────
  scheduler: {
    backend: "bun",
    maxConcurrentTasks: 5,
    taskTimeout: 60_000,
    tickIntervalSeconds: 60,
  },

  // ── Cache ───────────────────────────────────────────────────────
  cache: {
    enabled: true,
    ttl: 300_000, // 5 minutes
    maxSize: 1000,
  },

  // ── Data Residency ──────────────────────────────────────────────
  residency: {
    defaultRegion: "us",
    strictRouting: false,
    regions: {
      "us": {
        label: "United States",
        databaseUrl: process.env.ATLAS_REGION_US_DB_URL ?? process.env.DATABASE_URL!,
        apiUrl: "https://api.useatlas.dev",
      },
      "eu": {
        label: "Europe",
        databaseUrl: process.env.ATLAS_REGION_EU_DB_URL!,
        apiUrl: "https://api-eu.useatlas.dev",
      },
      "apac": {
        label: "Asia Pacific",
        databaseUrl: process.env.ATLAS_REGION_APAC_DB_URL!,
        apiUrl: "https://api-apac.useatlas.dev",
      },
    },
  },
});
