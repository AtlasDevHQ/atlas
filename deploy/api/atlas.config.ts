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
import { chatPlugin } from "@useatlas/chat";

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

  // ── Plugins ─────────────────────────────────────────────────────
  // Slice 1 of #2607 — structural wiring only. Loads @useatlas/chat
  // with a PgStateAdapter so chat_* tables are created on boot. The
  // plugin's webhook routes mount at /api/plugins/chat-interaction/*
  // alongside the existing /api/v1/slack/* routes; both surfaces
  // coexist after this slice. NO `proactive:` block is supplied here —
  // bridge.ts only registers the proactive listener when
  // `config.proactive` is truthy. Slice 2 (#2607) will add it.
  //
  // SaaS is multi-tenant: real Slack bot tokens live in the internal
  // DB (slack_integrations / slack_workspaces) keyed by team_id, and
  // packages/api/src/api/routes/slack.ts continues to handle every
  // production webhook today. The static `botToken` below is required
  // by Zod (min(1)) but is never used for outbound calls in SaaS —
  // executeQuery throws a clear stub error to prevent accidental
  // routing through this plugin until slice 3 migrates handlers.
  plugins: [
    chatPlugin({
      adapters: {
        slack: {
          botToken: process.env.SLACK_BOT_TOKEN ?? "saas-multi-tenant-unused",
          signingSecret:
            process.env.SLACK_SIGNING_SECRET ?? "saas-multi-tenant-unused",
          ...(process.env.SLACK_CLIENT_ID
            ? { clientId: process.env.SLACK_CLIENT_ID }
            : {}),
          ...(process.env.SLACK_CLIENT_SECRET
            ? { clientSecret: process.env.SLACK_CLIENT_SECRET }
            : {}),
        },
      },
      state: { backend: "pg" },
      executeQuery: async () => {
        // Stub: until slice 3 retires slack.ts's app_mention handler, this
        // plugin's bridge is mounted but unused — Slack still routes to
        // /api/v1/slack/events. Returning a clear stub error prevents
        // accidental routing during slice 1/2.
        throw new Error(
          "Chat plugin executeQuery not yet wired — slice 3 will migrate handlers from slack.ts",
        );
      },
    }),
  ],

  // ── Auth ────────────────────────────────────────────────────────
  auth: "managed",

  // ── Deploy Mode ─────────────────────────────────────────────────
  deployMode: "saas",

  // ── Enterprise ──────────────────────────────────────────────────
  enterprise: {
    enabled: true,
  },

  // ── Sandbox ─────────────────────────────────────────────────────
  // SaaS uses Vercel Sandbox exclusively — per-request Firecracker microVM
  // isolation with networkPolicy: "deny-all". Off-Vercel auth requires
  // VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and VERCEL_TOKEN env vars on each
  // Railway api service. No fallback: a Vercel outage will hard-fail the
  // explore tool with a clear error rather than degrading to a less-isolated
  // backend that can't enforce multi-tenant boundaries.
  sandbox: {
    priority: ["vercel-sandbox"],
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
