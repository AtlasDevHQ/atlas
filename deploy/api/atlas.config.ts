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
// Relative import: atlas.config.ts lives at /app/ in the SaaS container,
// outside any workspace's node_modules resolution tree. The workspace
// symlink for @useatlas/chat is at /app/packages/api/node_modules/,
// which is not reachable via Node's upward node_modules walk from /app/.
// The `defineConfig` import above uses the same relative-path pattern
// for the same reason. Resolved at boot via bun's TS loader.
import { chatPlugin } from "./plugins/chat/src/index";
import { getProactiveAiRuntime } from "./packages/api/src/lib/effect/ai";
import { getEnterpriseRuntime } from "./packages/api/src/lib/effect/enterprise-layer";
import { createSlackWorkspaceIdResolver } from "./packages/api/src/lib/proactive/workspace-id-resolver";
import { createSlackProactiveUserResolver } from "./packages/api/src/lib/proactive/user-resolver";
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
import { WorkspaceInstallGate } from "./packages/api/src/lib/integrations/install/workspace-install-gate";
// Slice 3 of #2607 — host-side `executeQuery` that resolves Slack
// `team_id` → `chat_cache:slack:installation` → `org_id` → `botActorUser`
// before invoking the agent loop (post-#2634 the install store
// consolidated onto `chat_cache`). Replaces the slice-1 stub. The
// factory returns a plain async function — no `effect` import
// surfaces here, so the relative-import constraint stays satisfied.
import { createChatPluginExecuteQuery } from "./packages/api/src/lib/chat-plugin/executeQuery";

// Dedicated runtime for the proactive classifier + answer adapters.
// Built inside the workspace by `getProactiveAiRuntime()` so this file
// stays free of bare-package `effect` imports (which can't be resolved
// from /app/ in the SaaS container — the workspace's `effect` lives
// under packages/api/node_modules and isn't on the upward walk from
// /app/atlas.config.ts). Process-lifetime cached on the helper side.
const proactiveAiRuntime = getProactiveAiRuntime();

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

  // ── Plugin Catalog (1.5.2 slice 2 — #2650) ──────────────────────
  // Flat list with `type` + `install_model` as orthogonal fields per
  // PRD "Further Notes" + ADR-0002. Seeded into `plugin_catalog` at
  // boot by `CatalogSeeder`; ops can flip `enabled=false` in DB without
  // a deploy for emergency-disable (the seed preserves DB-side false).
  //
  // 1.5.2 ships the OAuth install path for Slack (chat). The other
  // chat Platforms ride along as `enabled: false` placeholders with
  // `install_model: 'static-bot'` — their install handler lands in
  // 1.5.3 alongside `StaticBotInstallHandler`. Integration plugins
  // (Salesforce, Jira, Email, Webhook, Obsidian) wire in slice 3
  // (#2651) via `LazyPluginLoader`; their entries land then.
  catalog: [
    {
      slug: "slack",
      type: "chat",
      install_model: "oauth",
      enabled: true,
      saas_eligible: true,
      min_plan: "starter",
    },
    // ── 1.5.3 placeholders — visible to ops, not customer-installable ─
    // Per CONTEXT.md, each of these has Platform-specific install
    // subtleties (Teams Azure-AD + manifest, Discord per-guild routing,
    // Telegram chat_id capture, WhatsApp Meta verification, gchat Google
    // Workspace Marketplace). They get `install_model: 'static-bot'`
    // per the install-handler spectrum.
    {
      slug: "teams",
      type: "chat",
      install_model: "static-bot",
      enabled: false,
      saas_eligible: true,
    },
    {
      slug: "discord",
      type: "chat",
      install_model: "static-bot",
      enabled: false,
      saas_eligible: true,
    },
    {
      slug: "gchat",
      type: "chat",
      install_model: "static-bot",
      enabled: false,
      saas_eligible: true,
    },
    {
      slug: "telegram",
      type: "chat",
      install_model: "static-bot",
      enabled: false,
      saas_eligible: true,
    },
    {
      slug: "whatsapp",
      type: "chat",
      install_model: "static-bot",
      enabled: false,
      saas_eligible: true,
    },
  ],

  // ── Plugins ─────────────────────────────────────────────────────
  // Slice 3 of #2607 — the chat plugin now owns the @mention + thread
  // event path end-to-end. The plugin's webhook routes at
  // /api/plugins/chat-interaction/* are reachable.
  //
  // TODO(#2612 / slice 4 — HITL dogfood): the Slack app manifest MUST
  // be flipped during slice 4 — change the Events API request URL from
  // /api/v1/slack/events to /api/plugins/chat-interaction/webhooks/slack.
  // The legacy /api/v1/slack/events route now ignores all event_callback
  // types (logs at warn), so until the flip happens @mentions and thread
  // replies are silently dropped.
  //
  // The legacy /api/v1/slack/{commands,interactions,install,callback}
  // routes in packages/api/src/api/routes/slack.ts stay put — they
  // handle slash commands, block actions, modals, and OAuth.
  //
  // Multi-tenant SaaS: real bot tokens live in `chat_cache` under the
  // `slack:installation:<teamId>` key prefix (#2634 consolidated the
  // legacy `slack_installations` Postgres table into this store).
  // Atlas's OAuth callback writes; `@chat-adapter/slack` reads — both
  // sides share `SLACK_ENCRYPTION_KEY` so bot tokens stay encrypted
  // at rest via AES-256-GCM. OMIT `botToken` so the adapter operates
  // in multi-workspace mode.
  plugins: [
    chatPlugin({
      // Catalog-driven adapter activation (#2650 slice 2). The chat
      // plugin's `AdapterRegistry` reads the chat-type subset of the
      // catalog above and per-Platform credentials from `process.env`
      // (`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`
      // / `SLACK_ENCRYPTION_KEY` / optional `SLACK_BOT_TOKEN`). The old
      // `adapters: { slack: {...} }` field is gone — there is no longer
      // a way to wire a chat adapter outside the catalog seam.
      catalog: [
        {
          slug: "slack",
          type: "chat",
          install_model: "oauth",
          enabled: true,
          saas_eligible: true,
        },
      ],
      state: { backend: "pg" },
      // Host-side executeQuery — preserves the F-55 actor binding,
      // approvalSurface stamp, conversation persistence, rate-limit
      // key shape, and :lock: pending-approval flow that slack.ts's
      // legacy app_mention / thread-followup branches used to own.
      executeQuery: createChatPluginExecuteQuery(),
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
        // `chat_cache.value.orgId` (post-#2634 consolidation, was
        // `slack_installations.org_id`). Returns null on unknown
        // tenants (silent skip — no classify, no meter, no
        // kill-switch read).
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
        // Answer-flow wiring (#2623 item 1). SaaS deploys both halves:
        //   - public-dataset path for unlinked askers (curated allowlist
        //     gates `executeSQL` + `explore` at the tool boundary; the
        //     plugin-level post-filter is the second gate)
        //   - linked-asker path via `createSlackProactiveUserResolver`
        //     (#2624 validates the workspaceId; today every asker resolves
        //     as `{ kind: "unlinked" }` because there's no Slack-user
        //     link table in core yet — the unlinked branch is the safe
        //     branch and routes through the public-dataset allowlist
        //     gate, which is now tenant-scoped)
        answerFlow: {
          mode: "both",
          // Adapter-side getPublicDataset (constrains the agent at tool
          // construction). Listener-side getPublicDataset is the same
          // helper, wired alongside as `answerFlow.getPublicDataset` a
          // few lines down — that's the post-filter that gates the
          // result after the agent runs.
          executeQueryProactive: createProactiveAnswerAdapter(
            proactiveAiRuntime,
            {
              getPublicDataset: (_asker, { workspaceId }) =>
                getAllowlist(workspaceId),
            },
          ),
          userResolver: createSlackProactiveUserResolver(),
          // Plugin-level public-dataset allowlist (post-filter on the
          // listener side, distinct from the adapter option above).
          // Defense-in-depth: once #2624 closes the user-resolver gap
          // and linked askers reach the agent, this post-filter still
          // gates unlinked-asker results.
          getPublicDataset: (input) => getAllowlist(input.workspaceId),
        },
        // Three-layer kill switch + per-user opt-out (#2295). Plugin's
        // `IsPausedFn` input shape is a structural subset of the host
        // helper's — pass the helper directly.
        killSwitch: {
          enabled: true,
          isPaused,
          onPauseRequest: handlePluginPauseRequest,
        },
        // Feedback wiring (#2298) — collector intentionally omitted in
        // SaaS today; adding it would require a non-trivial host helper
        // (write to meter + optionally to evals dataset). Deferred to a
        // follow-up.
        feedback: { enabled: false },
        linkUrl:
          process.env.ATLAS_PUBLIC_WEB_URL ?? "https://app.useatlas.dev",
        // Per-event meter callback. `recordMeterEvent` swallows DB
        // failures internally (logs at error) so the Chat SDK event
        // loop never sees a rejection.
        onMeterEvent: recordMeterEvent,
        // Monthly cap reader. Plugin's `GetQuotaStatusFn` takes
        // `{ workspaceId }`; the host helper takes a bare `workspaceId`
        // (plus an optional `now` for tests), so adapt the shape here.
        getQuotaStatus: (input) => getWorkspaceQuotaStatus(input.workspaceId),
        // WorkspaceInstallGate (#2655) — outermost workspace-scoped
        // check, runs before classify / meter / quota / kill-switch.
        // `slack` matches `plugin_catalog.slug` for the Slack catalog
        // row above; the gate accepts both the slug and the
        // `catalog:slack` id, so the catalog seed timing (seeder runs
        // post-migration) doesn't matter here.
        installGate: {
          enabled: true,
          gate: WorkspaceInstallGate.isWorkspaceInstallActive,
          catalogId: "slack",
        },
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
