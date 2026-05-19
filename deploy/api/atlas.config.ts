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
import {
  AtlasAiModel,
  AtlasAiModelLive,
} from "./packages/api/src/lib/effect/ai";
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
  isPaused as isPausedHelper,
} from "./packages/api/src/lib/proactive/pause-registry";
import { getWorkspaceQuotaStatus } from "./packages/api/src/lib/proactive/quota";
import { getAllowlist } from "./packages/api/src/lib/proactive/public-dataset";

// ── Lazy ManagedRuntime for AtlasAiModel ────────────────────────────
//
// The classifier + answer adapters need a ManagedRuntime that provides
// AtlasAiModel (the configured Vercel AI SDK LanguageModel). The
// server's own runtime in `packages/api/src/api/server.ts` is built
// locally and isn't exported, so we materialise a small dedicated
// runtime here. Lazy construction defers the `AtlasAiModelLive`
// resolution (which reads ATLAS_PROVIDER / ATLAS_MODEL via the settings
// + providers modules) until first call — by then settings are
// populated and the env is stable. Process-lifetime cached: the layer's
// 5s TTL inside SaaS mode handles admin-driven model swaps without a
// restart, so we don't need to rebuild the runtime ourselves.
let _aiRuntime:
  | ManagedRuntime.ManagedRuntime<AtlasAiModel, never>
  | null = null;
function getProactiveAiRuntime(): ManagedRuntime.ManagedRuntime<
  AtlasAiModel,
  never
> {
  if (_aiRuntime === null) {
    _aiRuntime = ManagedRuntime.make(AtlasAiModelLive);
  }
  return _aiRuntime;
}

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
      // ── Proactive listener wiring (slice 2 of #2607) ──────────────
      // Wires every callback the proactive listener consumes to the
      // host helpers under `packages/api/src/lib/proactive/`. After this
      // block lands, flipping `workspace_proactive_config.enabled = true`
      // on a workspace + adding a `channel_proactive_config` row makes
      // Atlas emit 🤖 reactions in real time. The reaction-back / answer
      // flow runs through `executeQueryProactive`; with the user
      // resolver stubbed to "unlinked" today (multi-tenant gap — see
      // follow-up issue), unlinked askers refuse safely until the
      // resolver is upgraded to carry workspace context.
      //
      // All adapters resolve their runtimes lazily so the proactive
      // block can be declared at module load time without forcing the
      // AI provider / Effect EE layer to materialise during config
      // import. `getEnterpriseRuntime()` is module-cached; the
      // AtlasAiModel runtime is closed over `getProactiveAiRuntime()`
      // and built on first call.
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
        // Classifier wraps Atlas's primary configured LLM via the
        // module-level lazy AI runtime. `createProactiveClassifier`'s
        // `RIn` type parameter widens to allow this `ManagedRuntime<
        // AtlasAiModel, never>`.
        classify: createProactiveClassifier(getProactiveAiRuntime()),
        // Reaction-back answer flow. Unlinked askers (every asker today
        // because `userResolver` stubs `atlasUserId: undefined`) get
        // refused with the user-safe error since we omit the adapter's
        // `getPublicDataset` option — refusing is the safe default
        // until the multi-tenant user-resolver gap is closed.
        executeQueryProactive: createProactiveAnswerAdapter(
          getProactiveAiRuntime(),
        ),
        // TODO(#2624): The plugin's `ProactiveUserResolver` shape —
        // `(asker) => Promise<ResolvedAsker>` — doesn't carry team_id /
        // workspaceId. On SaaS the same Slack userId can exist across
        // multiple tenants and would resolve to different Atlas users.
        // Stub to always-unlinked for now (constrains the agent to
        // refuse on the unlinked path, which is the safe fallback).
        userResolver: async () => ({ atlasUserId: undefined }),
        linkUrl:
          process.env.ATLAS_PUBLIC_WEB_URL ?? "https://app.useatlas.dev",
        // Three-layer kill switch + per-user opt-out. The plugin's
        // `IsPausedFn` input shape (`{ workspaceId, channelId, userId? }`)
        // is a structural subset of the host helper's input — pass the
        // helper directly so admin-inspection options (`failOpenOnError`,
        // `now`) stay on the helper while the listener uses the
        // fail-CLOSED default.
        isPaused: isPausedHelper,
        onPauseRequest: handlePluginPauseRequest,
        // Per-event meter callback. `recordMeterEvent` swallows DB
        // failures internally (logs at error) so the Chat SDK event
        // loop never sees a rejection.
        onMeterEvent: recordMeterEvent,
        // Monthly cap reader. Plugin's `GetQuotaStatusFn` takes
        // `{ workspaceId }`; the host helper takes a bare `workspaceId`
        // (plus an optional `now` for tests), so adapt the shape here.
        getQuotaStatus: (input) => getWorkspaceQuotaStatus(input.workspaceId),
        // Public-dataset allowlist reader for the unlinked-asker
        // post-filter. Plugin's `GetPublicDatasetFn` takes
        // `{ workspaceId }`; the host helper takes a bare workspaceId
        // and returns the same `PublicDatasetEntry[]` shape.
        getPublicDataset: (input) => getAllowlist(input.workspaceId),
        // feedbackCollector intentionally omitted — adding it would
        // require a non-trivial host helper (write to meter +
        // optionally to evals dataset). Per slice 2 scope: defer
        // feedback wiring to a follow-up.
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
