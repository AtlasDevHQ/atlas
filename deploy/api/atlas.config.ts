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

import { ManagedRuntime } from "effect";
import { defineConfig } from "./packages/api/src/lib/config";
// Relative import: atlas.config.ts lives at /app/ in the SaaS container,
// outside any workspace's node_modules resolution tree. The workspace
// symlink for @useatlas/chat is at /app/packages/api/node_modules/,
// which is not reachable via Node's upward node_modules walk from /app/.
// The `defineConfig` import above uses the same relative-path pattern
// for the same reason. Resolved at boot via bun's TS loader.
import { chatPlugin } from "./plugins/chat/src/index";
import { AtlasAiModelLive } from "./packages/api/src/lib/effect/ai";
import { getEnterpriseRuntime } from "./packages/api/src/lib/effect/enterprise-layer";
import { createSlackWorkspaceIdResolver } from "./packages/api/src/lib/proactive/workspace-id-resolver";
import { createProactiveEnabledGate } from "./packages/api/src/lib/proactive/enabled-gate";
import {
  getChannelProactiveConfigs,
  getWorkspaceProactiveConfig,
} from "./packages/api/src/lib/proactive/workspace-config-loader";
import { createProactiveClassifier } from "./packages/api/src/lib/proactive/classifier-adapter";
import { createProactiveAnswerAdapter } from "./packages/api/src/lib/proactive/answer-adapter";
import { recordMeterEvent } from "./packages/api/src/lib/proactive/answer-meter";
import {
  handlePluginPauseRequest,
  isPaused,
} from "./packages/api/src/lib/proactive/pause-registry";
import { getWorkspaceQuotaStatus } from "./packages/api/src/lib/proactive/quota";
import { getAllowlist } from "./packages/api/src/lib/proactive/public-dataset";

// Dedicated runtime for the proactive classifier + answer adapters.
// The server's own runtime in `packages/api/src/api/server.ts` isn't
// exported, so we build a small one here. `ManagedRuntime.make` is
// cheap — it defers `AtlasAiModelLive` resolution until the first
// `runPromise()`, by which point settings are populated. The layer's
// 5s settings TTL absorbs admin-driven model swaps without a restart.
const proactiveAiRuntime = ManagedRuntime.make(AtlasAiModelLive);

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
  // `config.proactive` is truthy. Slice 2 of #2607 will add it.
  //
  // SaaS is multi-tenant: real Slack bot tokens live in the internal
  // DB (slack_integrations / slack_workspaces) keyed by team_id, and
  // packages/api/src/api/routes/slack.ts continues to handle every
  // production webhook today. The static `botToken` below is required
  // by Zod (min(1)) but is never used for outbound calls in SaaS —
  // executeQuery throws a stub before any outbound call, and the
  // Slack app manifest only POSTs to /api/v1/slack/events, not to the
  // plugin's webhook route. Slice 3 of #2607 retires this stub.
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
      executeQuery: async (question, ctx) => {
        // Defensive stub for slice 1/2 — the chat plugin's bridge is
        // wired but unreachable from the Slack app manifest today (only
        // /api/v1/slack/events is registered). Slice 3 of #2607 retires
        // this stub by migrating the @mention/thread handlers off
        // slack.ts. If a request DOES reach this stub (e.g., manual
        // webhook re-registration during dogfood), the bridge logs the
        // throw via log.error and posts an error card to the user, so
        // the surfaced message must be user-safe — not a dev string.
        // Log the dev detail with structured context for operators.
        console.error(
          JSON.stringify({
            event: "chat-plugin.executeQuery.stub-hit",
            threadId: ctx.threadId,
            questionPreview: question.slice(0, 80),
            note:
              "Chat plugin reached pre-slice-3 stub. Check Slack app manifest — only /api/v1/slack/events should be registered.",
          }),
        );
        throw new Error(
          "This Slack integration is being upgraded. Please try again in a moment, or contact your Atlas admin if this persists.",
        );
      },
      // ── Proactive listener wiring (#2607) ─────────────────────────
      // Wires every callback the proactive listener consumes to host
      // helpers under `packages/api/src/lib/proactive/`. After this
      // block lands, flipping `workspace_proactive_config.enabled = true`
      // on a workspace + adding a `channel_proactive_config` row makes
      // Atlas emit 🤖 reactions in real time. The reaction-back / answer
      // flow runs through `executeQueryProactive`; the user-resolver
      // stub (multi-tenant gap — #2624) keeps every asker on the
      // unlinked path, where the adapter refuses safely.
      proactive: {
        platform: "slack",
        // Per-event resolution: maps Slack `team_id` →
        // `slack_installations.org_id`. Returns null on unknown tenants
        // (silent skip — no classify, no meter, no kill-switch read).
        resolveWorkspaceId: createSlackWorkspaceIdResolver(),
        // Two-tier gate: enterprise check (cached) + per-workspace
        // `workspace_proactive_config.enabled` (re-read every call).
        // `getEnterpriseRuntime()` provides ProactiveGate (and the rest
        // of EnterpriseSubsystem); the wider runtime is structurally
        // compatible with the narrower `ManagedRuntime<ProactiveGate>`
        // the factory requires.
        isEnabled: createProactiveEnabledGate(getEnterpriseRuntime()),
        // Per-event config fetchers (post-#2620 multi-tenant).
        getWorkspaceConfig: getWorkspaceProactiveConfig,
        getChannelConfigs: getChannelProactiveConfigs,
        // Classifier wraps Atlas's primary configured LLM via
        // `proactiveAiRuntime`. The factory's `RIn` type parameter
        // widens to accept the runtime's full service set.
        classify: createProactiveClassifier(proactiveAiRuntime),
        // Reaction-back answer flow. The adapter's optional
        // `getPublicDataset(asker)` callback — distinct from the
        // plugin-level `getPublicDataset` wired below — is intentionally
        // omitted: with the user resolver stubbed to unlinked, every
        // asker hits the adapter's "refuse unlinked" path before
        // touching the agent. The plugin-level `getPublicDataset` post-
        // filter on the listener side is wired (line ~199) and becomes
        // load-bearing once #2624 closes the user-resolver gap.
        executeQueryProactive: createProactiveAnswerAdapter(proactiveAiRuntime),
        // TODO(#2624): `ProactiveAsker` carries `{ platform, externalUserId, userName? }`
        // — no `team_id` / `workspaceId`. On SaaS the same Slack userId
        // can exist across multiple tenants and would resolve to
        // different Atlas users without workspace context. Stubbed to
        // always-unlinked; the unlinked path is the refuse-safe branch
        // (adapter refuses; plugin-level public-dataset post-filter
        // remains a defense-in-depth net for when #2624 lands).
        userResolver: async () => ({ atlasUserId: undefined }),
        linkUrl:
          process.env.ATLAS_PUBLIC_WEB_URL ?? "https://app.useatlas.dev",
        // Three-layer kill switch + per-user opt-out. Plugin's
        // `IsPausedFn` input shape is a structural subset of the host
        // helper's — pass the helper directly.
        isPaused,
        onPauseRequest: handlePluginPauseRequest,
        // Per-event meter callback. `recordMeterEvent` swallows DB
        // failures internally (logs at error) so the Chat SDK event
        // loop never sees a rejection.
        onMeterEvent: recordMeterEvent,
        // Monthly cap reader. Plugin's `GetQuotaStatusFn` takes
        // `{ workspaceId }`; the host helper takes a bare `workspaceId`
        // (plus an optional `now` for tests), so adapt the shape here.
        getQuotaStatus: (input) => getWorkspaceQuotaStatus(input.workspaceId),
        // Plugin-level public-dataset allowlist (post-filter on the
        // listener side, distinct from the adapter option omitted at
        // `executeQueryProactive` above). Defense-in-depth: once #2624
        // closes the user-resolver gap and linked askers reach the
        // agent, this post-filter still gates unlinked-asker results.
        getPublicDataset: (input) => getAllowlist(input.workspaceId),
        // feedbackCollector intentionally omitted — adding it would
        // require a non-trivial host helper (write to meter +
        // optionally to evals dataset). Deferred to a follow-up.
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
