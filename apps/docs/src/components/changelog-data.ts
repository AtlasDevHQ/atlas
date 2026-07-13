export interface Release {
  version: string;
  title: string;
  date?: string;
  summary: string;
  highlights?: string[];
  githubMilestone?: number;
}

/**
 * Changelog release data — single source of truth for the changelog page.
 *
 * Two tracks, each ordered newest-first:
 *  - `releases`           — the public git-tag train (`v0.0.1`, `v0.0.2`, …). Mirrors GitHub
 *                           Releases; one entry per tag cut via `/release`.
 *  - `developmentHistory` — internal milestone numbers (`1.6.0` … `0.1`) that predate public
 *                           versioning. Kept as a pre-launch development record, not public semver.
 *
 * See ADR-0008 for the versioning model. New tags are appended to `releases` at /release time.
 */
export const releases: Release[] = [
  {
    version: "v0.0.51",
    title: "Workspace Model Picker Hotfix",
    date: "2026-07-13",
    summary:
      "Workspace admins can change their workspace's default AI model again. The billing page's model picker was writing a platform-level setting — every workspace admin got a permissions error, and the setting wasn't per-workspace in the first place. The picker now saves a true per-workspace model choice (running on Atlas platform credits through the gateway), the same configuration the agent already honors first, and the billing page reports exactly the model your workspace actually runs — including when you bring your own provider key.",
    highlights: [
      "Default AI model is a per-workspace choice again — picking a model affects only your workspace and takes effect without a redeploy (#4646)",
      "The billing page's reported model now mirrors the agent's real resolution order, so it can never advertise a model your workspace won't run",
      "BYOT workspaces: the picker is read-only while a custom provider is configured, so it can never overwrite your provider credentials",
    ],
  },
  {
    version: "v0.0.50",
    title: "Learned-Patterns Elevation",
    date: "2026-07-13",
    summary:
      "Atlas quietly learns from every successful query — now that learning visibly pays off. Approving a learned pattern makes it injectable immediately, regardless of its confidence score, which stays the machine's untouched evidence meter. Pattern identity is enforced by the database, so a repeated query increments one row instead of minting duplicates that inflate each other's weight, and seen-once noise stays out of the review queue. Every injection is attributed, so an approved pattern's row shows its real usage. Auto-promotion becomes a per-workspace, off-by-default dial instead of an invisible platform switch. And the review cockpit stops lying: sorting and filtering work, failed reviews surface where you're looking, reviewers have names, connection groups are visible, and the pending queue announces itself with a badge.",
    highlights: [
      "Approval is an eligibility bypass, not a confidence write — a rare-but-correct pattern becomes injectable the moment you approve it, while confidence stays the honest record of what was actually observed (#4571)",
      "Database-enforced pattern identity — a repeat observation increments one row instead of minting duplicates; seen-once patterns stay below the review queue (#4572, #4581)",
      "Every injection is attributed — an approved pattern's row shows real 30-day usage, so the payoff is observable instead of asserted (#4573)",
      "Per-workspace auto-promotion knob — an opt-in, off-by-default settings dial replaces the invisible platform env switch (#4582)",
      "The cockpit stops lying — working sort/filter, failures surfaced inside the review sheet where you act, named reviewers, visible connection groups, and a pending-queue badge (#4573–#4580)",
    ],
  },
  {
    version: "v0.0.49",
    title: "Knowledge Base Connector Picker",
    date: "2026-07-12",
    summary:
      "Every Knowledge Base import source is now reachable from the product. The \"New collection\" picker became a searchable, data-driven grid over the full connector catalog — so the nine connectors that were wired server-side but had no way in (Confluence Cloud and Data Center, GitBook, Zendesk Guide, Salesforce Knowledge, Intercom, Front, Help Scout, and Freshdesk) join Upload, Endpoint, and Notion. Each source collects exactly the credentials it needs, rendered from its own catalog definition, and a connector added later shows up automatically with no picker change.",
    highlights: [
      "All 12 Knowledge Base import sources are selectable from New collection — the 9 previously-unreachable connectors gain a UI entry point (#4619)",
      "A searchable connector grid replaces the fixed 3-tab strip; each connector renders its own credential form from the catalog definition and installs through the shared form-install path",
      "Data-driven by construction — a future connector added to the built-in catalog surfaces automatically, so this gap can't silently recur",
      "Existing Upload / Endpoint / Notion flows unchanged",
    ],
  },
  {
    version: "v0.0.48",
    title: "Semantic-Improve Elevation",
    date: "2026-07-11",
    summary:
      "The AI Semantic Layer Improvement console becomes a briefed, steerable, trustworthy loop — one Amendment identity from proposal to applied. Every proposed change, whether from a chat with the expert agent or the background scheduler, lands in one pending queue with a live diff you review and approve in place; approving applies the change and records it in version history in the same step, so a proposal can never read approved without actually landing. Rejections are now permanent, with a Reconsider path to bring one back. You can steer the agent by anchoring to a connection group, an entity, or a specific physical column from the new coverage view, and a SaaS-first per-workspace scheduler can propose improvements on its own cadence.",
    highlights: [
      "One pending queue with live-diff review and claim-then-apply — approving applies the change and snapshots it in the same step; a bounced apply returns to pending with the reason (#4504, #4506, #4511)",
      "Permanent rejection memory with a Reconsider path — reject once and the agent won't re-propose it until you explicitly bring it back (#4507, #4512)",
      "Anchors + a column-level coverage view — launch a scoped improvement conversation from a connection group, an entity, or a physical column (#4519, #4521)",
      "Briefing assembly + dialect specialists — the agent opens each turn with real health inputs and engine-specific guidance (#4514, #4515)",
      "Group-scoped glossary amendments — proposed glossary terms are written to the right group's glossary, no silent no-op (#4518)",
      "SaaS-first autonomous improvement — an opt-in, per-workspace scheduler that fills the pending queue on its own cadence, with a proactive notification when it does (#4516, #4520)",
      "Expert is a first-class mode with a workspace step cap; amendments folded out of Learned Patterns so the decide seam is the only writer of \"approved\" (#4508, #4569)",
    ],
  },
  {
    version: "v0.0.47",
    title: "Notebook Surface Retired",
    date: "2026-07-10",
    summary:
      "The notebook surface is retired. Its job — an agent-built, curated, shareable analysis artifact — now belongs to dashboards, which reached a sounder draft-first, publish-gated model in the recent dashboards work. Existing notebook conversations are converted to ordinary web chats with their full message history preserved; conversations that were forked from a notebook become standalone chats, and no messages are deleted. This is the first step of a two-step removal: this release stops all reads and writes of notebook state, and the underlying column is dropped in the next release.",
    highlights: [
      "The notebook surface — cells, fork/branch, convert-to-notebook, and the \"Share as Report\" viewer — is removed end-to-end (#4589)",
      "Existing notebook conversations migrate to web chat with full message history preserved; forked notebooks become standalone chats; no rows are deleted (migration 0169)",
      "Dashboards own the curated, agent-built, shareable-artifact job going forward, on the draft-first, publish-gated model (ADR-0029/0034)",
      "Two-phase drop: this release stops every read and write of notebook state; the underlying column is dropped in the next release (#4588)",
    ],
  },
  {
    version: "v0.0.46",
    title: "KB Support Center Connectors",
    date: "2026-07-10",
    summary:
      "The support-center connector tier is complete. Front, Intercom Articles, Help Scout Docs, and Freshdesk Solutions join the earlier Zendesk Guide and Salesforce Knowledge connectors, so your help-center articles can feed the Knowledge Base directly. All six run on one shared HTML-to-markdown converter — each connector is a thin vendor client, and every one syncs with the same review-gated draft flow, caps, and uninstall behavior.",
    highlights: [
      "Front Knowledge Base connector — Bearer-token install, multiple knowledge bases and locales (#4400)",
      "Intercom Articles connector — access-token install, multi-locale articles (#4399)",
      "Help Scout Docs connector — Docs API key, multi-site, incremental sync on an updatedAt watermark (#4398)",
      "Freshdesk Solutions connector — API-key install, category tree-walk enumeration (#4401)",
      "One shared support HTML-to-markdown converter under the whole tier, so vendor quirks can't fork the pipeline",
      "Connector guides for Front and Freshdesk complete the docs set — every shipped connector now has a setup guide",
    ],
  },
  {
    version: "v0.0.45",
    title: "OKF Importers + KB Connectors",
    date: "2026-07-10",
    summary:
      "The Knowledge Base now syncs from where your docs already live. A source-neutral importer core turns Fumadocs, Mintlify, MkDocs, and Docusaurus sites into knowledge bundles, and the first server-side sync connectors keep collections current from Notion, Confluence Cloud, Confluence Data Center, and GitBook — incremental sync with reconciliation, landing as review-gated drafts. Zendesk Guide and Salesforce Knowledge connectors shipped early in the same train. A hardening pass over the semantic-layer improvement surface routes amendment test queries through the full user query pipeline and scopes amendments correctly per workspace.",
    highlights: [
      "Server-side Knowledge Base sync connectors: Notion, Confluence Cloud, Confluence Data Center/Server, and GitBook — token installs, incremental sync + reconciliation, review-gated ingest (#4378, #4377, #4394, #4393)",
      "Connector spine: document-level ingest, catalog dispatch, and a reconciliation engine shared by every connector (#4376)",
      "Incomplete-crawl guard — a depth-capped or partial enumeration can no longer archive live documents behind a green sync (#4389)",
      "Source-neutral OKF importers: @atlas/okf-bundle core with Fumadocs, Mintlify, MkDocs, and Docusaurus adapters (#4373, #4391, #4392)",
      "Zendesk Guide and Salesforce Knowledge connectors shipped early, with the shared support HTML-to-markdown converter (#4396, #4397)",
      "Semantic-improve hardening: amendment test queries run through the full user query pipeline (row-level security, masking, limits, audit), and amendments are scoped per workspace (#4485, #4487)",
      "Docs link rot now fails CI — internal links and anchors are checked on every build (#4480)",
      "Setup guides for every shipped connector, plus an agent-auth guide covering OAuth 2.1 vs Agent Auth",
    ],
  },
  {
    version: "v0.0.44",
    title: "Search scale & safety hardening",
    date: "2026-07-05",
    summary:
      "A maintenance release. Knowledge-base full-text search now runs on a stored, indexed column, so it stays fast as your knowledge base grows. The suggestion-parsing path was rewritten to run in linear time, removing a pathological slowdown on adversarial input. Under the hood, the executeSQL validation-and-orchestration path and the plugin-install path were each consolidated onto a single shared core.",
    highlights: [
      "Knowledge-base search is backed by a stored generated tsvector column with a GIN index, for steady search latency as your knowledge base scales (#4363)",
      "Suggestion parsing rewritten to run in linear time, closing a polynomial-backtracking slowdown on crafted input (#4364)",
      "executeSQL parses each query once and runs through one pure planner; singleton installs converge on the shared persist-form-install path (#4357, #4360, #4358)",
    ],
  },
  {
    version: "v0.0.43",
    title: "The Analyst Voice",
    date: "2026-07-04",
    summary:
      "The chat turn is redesigned around the answer. While Atlas works, a live activity feed streams each step from the moment you hit send; when the answer arrives it takes the lead, with the working detail collapsed into an expandable receipt and at most one chart or table promoted to sit alongside it. You can now choose the voice answers are written in — Plain English, Analyst (the new web default), or Executive — per conversation or as a workspace default. Dashboards get the same trust treatment: every edit lands in a private draft that publishing promotes, shared dashboards are data-only snapshots, and each tile reports its own status.",
    highlights: [
      "Answer-first turns — the finished turn leads with the answer; working steps collapse into an expandable receipt that honestly marks failed steps (#4298)",
      "Live working phase — an activity feed streams each step from the moment of send, so the first turn has no dead air (#4300)",
      "Answer styles — Plain English, Analyst, and Executive voices, selectable per conversation with a workspace-default setting; Analyst is the new web default (#4299, #4302, #4303)",
      "Chat interaction pass — stop an in-flight turn, copy an answer, multiline composer (Enter sends, Shift+Enter for a newline), and failures surfaced in a persistent banner instead of a vanishing one-liner (#4294–#4297)",
      "Notebook cells render finished turns through the same answer-first model as chat (#4301)",
      "Dashboards: draft-first editing — every edit lands in your private draft, publishing promotes it, and a new dashboard stays private to its creator until first publish (#4315, #4320)",
      "Shared dashboards are data-only snapshots with a frozen parameter summary, org-scoped shares, and fail-closed share configuration (#4316, #4317)",
      "Per-tile status makes each tile the unit of trust, and the dashboard editor converges with chat — the canvas renders as an artifact with receipt rendering and conversation continuity (#4321, #4322)",
    ],
  },
  {
    version: "v0.0.42",
    title: "Docs Portal Segmentation + Truthfulness Pass",
    date: "2026-07-03",
    summary:
      "The documentation site is now segmented by audience. The hosted SaaS docs live at the site root with URLs unchanged, self-hosted operators get a dedicated /self-hosted section, and the API reference stays at /api-reference. Concept pages that apply to both audiences are written once and single-sourced into each tree, so they can't drift apart. An audience taxonomy drives the split at build time: a hosted reader is structurally prevented from being shown self-hosted-only instructions, and the same rule holds across the rendered pages, the machine-readable llms.txt and .mdx twins, search, and each page's table of contents. A full truthfulness audit over the segmented portal corrected stale and mixed-audience content. This release also carries a set of behavior-preserving internal refactors that had already soaked on staging.",
    highlights: [
      "Docs split into three audience sections — SaaS at the site root, a new /self-hosted, and the API reference — with shared concept pages single-sourced into both human trees (#4259, #4265)",
      "Build-time audience taxonomy: a hosted reader can't receive self-hosted-only content, enforced across the rendered HTML, the .mdx/llms.txt twins, search, and the table of contents (#4260, #4266)",
      "308 redirects and canonical tags for every moved page, so existing deep links keep working (#4267)",
      "Section-faceted search across all three documentation sources (#4262)",
      "Truthfulness audit over the segmented portal — stale and mixed-audience pages corrected (#4274, #4290)",
      "Behavior-preserving internal refactors soaked on staging: architecture deepenings, knowledge-sync interval hot-reload, and type-strength follow-ups (#4284, #4293, #4306)",
    ],
  },
  {
    version: "v0.0.41",
    title: "Architecture Deepening II",
    date: "2026-07-03",
    summary:
      "The second architecture-deepening wave — twenty-two changes that unify logic previously hand-maintained in two or more places, so a fix or a security invariant now lives in exactly one seam. The highest-value consolidations are on security boundaries: the SQL execution pipeline is now a single core effect (validation, approval gate, RLS injection, auto-LIMIT, and statement timeout in one governed path), the marketplace install route flows through the same persistence spine as every other install (closing latent stale-cache and encryption-keyset gaps), and explore and Python share one sandbox backend-selection module (fixing a case where Python ignored the configured sandbox priority while nsjail stays hard-fail). It also carries user-facing fixes — a dirty-state save gate on the email-provider admin form and a marketplace catalog write fix — plus new agent-discovery surfaces: a machine-readable region directory and apex-hosted auth metadata. No behavior changes to the querying path beyond the fixes noted.",
    highlights: [
      "One core SQL execution pipeline — validation, approval gate, RLS injection, auto-LIMIT, and statement timeout unified behind a single effect (#4185, #4244)",
      "Marketplace /install now flows through the shared Form-install persistence spine, closing latent stale-plugin-cache and encryption-keyset gaps (#4186, #4232)",
      "One sandbox backend-selection module shared by explore and Python — Python now honors the configured sandbox priority and nsjail stays hard-fail (#4187)",
      "Shared OAuth install seams (verify, reconnect, token refresh) and one delivery-transport seam behind email/Slack/webhook (#4188, #4198)",
      "Plugin-SDK primitives — measuredHealthCheck across 18 plugins and a createDatasourcePlugin factory absorbing six plugins' assembly boilerplate (#4191, #4192)",
      "Shared chat render primitives across the web app and the embeddable React component (#4193)",
      "Email-provider admin form gains a dirty-state save gate via useConfigForm (#4204)",
      "New agent-discovery surfaces: a machine-readable region directory and apex-hosted auth metadata (#4253, #4256)",
    ],
  },
  {
    version: "v0.0.40",
    title: "Knowledge Base Pillar",
    date: "2026-07-02",
    summary:
      "Atlas gains its fourth pillar: a hosted Knowledge Base. Workspaces can now upload Open Knowledge Format (OKF) collections — runbooks, definitions, domain docs — review them in a new admin surface, and publish them so the agent reads them alongside the semantic layer when answering questions. Knowledge is served natively to the agent through the explore tool and a new searchKnowledge tool with full-text search and link-graph expansion, and collections can stay fresh via scheduled bundle sync. The release also carries the first wave of the ongoing architecture-deepening work, including marketplace install-path fixes and sandbox hardening.",
    highlights: [
      "Knowledge Base pillar — hosted per-workspace OKF collections with a document + link schema (ADR-0028, #4212)",
      "Ingest + publish lifecycle: bundle upload, upsert-by-path, archive-on-uninstall (#4213)",
      "OKF-native serving through the explore tool, with provenance and a prompt table of contents (#4220)",
      "/admin/knowledge — manage collections, upload bundles, review and publish (#4219)",
      "searchKnowledge tool — frontmatter filters, Postgres full-text search, and 1-hop link-graph expansion (#4221)",
      "Scheduled bundle sync — pull a bundle endpoint on a schedule with ingest-computed diffs (#4225)",
      "Marketplace install-path fixes and sandbox explore hardening from the Architecture Deepening II wave (#4224, #4231, #4233)",
    ],
  },
  {
    version: "v0.0.39",
    title: "Architecture Deepening Rollup",
    date: "2026-07-02",
    summary:
      "An internal-architecture release with no user-facing behavior changes. Trial and billing gate decisions now flow through one authoritative trial-state module, background scheduler jobs register through a single seam that applies gating, intervals, and tracing uniformly, and the plugin marketplace catalog structurally enforces that only operator-curated plugins can be listed. These consolidations reduce drift risk in the billing, scheduling, and marketplace paths ahead of upcoming feature work.",
    highlights: [
      "One authoritative trial-state module — tier, claimed, metered, expired, and days-remaining computed in a single place (#4127)",
      "Agent-query billing gates folded into a named checkAgentQueryGates seam, so gate ordering is enforced by code rather than comments (#4128)",
      "Scheduler fibers register through a registerPeriodicFiber seam — deploy-mode gating, intervals, tracing spans, and forking handled once (#4130)",
      "Marketplace plugin-catalog write path structurally enforces operator-curated-only listings (#4174)",
      "Agent system-prompt construction refactored to an extensible options form (#3819)",
    ],
  },
  {
    version: "v0.0.38",
    title: "MCP/CLI Onboarding Fixes",
    date: "2026-07-01",
    summary:
      "Finishes the trial onboarding journey over the MCP server and CLI, closing the last gaps a cold-browser verification pass surfaced on production. A new trial can now open the claim page directly instead of being bounced to the login screen and looping, and signing the CLI in through the browser device-approval flow works start to finish — the approval link opens a real page and the pending code gets claimed. The MCP server's hosted transport is also named correctly now (Streamable HTTP), removing a misleading label. All three fixes were verified on staging before release.",
    highlights: [
      "The /claim page is now publicly reachable so MCP and CLI trials can claim their account instead of bouncing to /login (#4164)",
      "atlas login browser device-approval works end-to-end — the approval link renders and the pending code is claimed (#4167)",
      "MCP hosted transport renamed from the misleading \"SSE\" to Streamable HTTP, matching what the server actually speaks (#4169)",
    ],
  },
  {
    version: "v0.0.37",
    title: "Turnstile Signup Fix",
    date: "2026-07-01",
    summary:
      "Fixes a bot-protection misplacement that made trial onboarding over the MCP server and CLI impossible on production. The Cloudflare Turnstile challenge was guarding the headless trial-provisioning endpoint — a door no onboarding surface could open, because there was nowhere to solve the challenge and mint a token. Turnstile now lives on the web signup form where a person can actually complete it, so MCP and CLI onboarding go through cleanly while signup stays protected against automated abuse.",
    highlights: [
      "Turnstile moved off the headless start_trial endpoint onto the web signup form, unblocking prod MCP and CLI onboarding (#4159)",
      "The web build now receives the Turnstile site key so the challenge renders in the client (#4162)",
      "Web content-security-policy frame-src updated to allow the Turnstile iframe (#4163)",
    ],
  },
  {
    version: "v0.0.36",
    title: "CLI & MCP Hardening",
    date: "2026-07-01",
    summary:
      "Hardens the CLI and MCP trial-to-action path end-to-end, closing the gaps an end-to-end verification pass surfaced. A brand-new trial account can now claim itself on the web with a passkey (no password required), set up the CLI, and ask natural-language questions of its own workspace datasource — over both the CLI and the MCP server. The high-level MCP query tool lets an agent ask a question in plain language and get an answer from Atlas's semantic agent, without writing SQL. Datasources created over the CLI or MCP can be published so they go live on chat, and a workspace admin can turn off raw SQL over those surfaces to keep members on the governed natural-language path.",
    highlights: [
      "MCP: new high-level query tool — ask a natural-language question and Atlas's semantic agent answers, no SQL required (#4094)",
      "atlas query now routes correctly against a workspace datasource over the CLI (#4124)",
      "Passkey-at-claim web flow: claim a trial account with a passkey and no password, then sign in cleanly (#4125, #4135)",
      "CLI/MCP datasource publish — promote drafts created over the CLI or MCP so they're live on chat (#4126)",
      "Workspace-admin off-switch to disable raw SQL over the CLI and MCP, restricting members to the natural-language query path (#4095)",
      "Clearer trial signup errors — a duplicate signup returns an actionable message instead of a 500 (#4136)",
      "Rate limiter reworked behind a swappable store, fixing per-pod windows on the unauthenticated trial surface (#4129)",
    ],
  },
  {
    version: "v0.0.35",
    title: "CLI: REST-backed Command Suite & API Keys",
    date: "2026-06-29",
    summary:
      "The atlas CLI graduates into a first-class, scriptable client for automation and CI. A new workspace-scoped API key gives headless tools a credential that's safe to drop into a pipeline — it reaches the data plane (running queries, metrics, and the semantic layer) but is denied on console-admin actions like billing, settings, and key minting. On top of it, a suite of commands talks to Atlas over the same REST API the app uses: run ad-hoc SQL, run a saved metric, explore the semantic layer, switch between workspaces, and create or profile a datasource — with database secrets captured from stdin or an environment variable, never from the command line. Every command runs through the same SQL-validation pipeline and audit trail as the rest of Atlas.",
    highlights: [
      "Workspace-scoped API keys for unattended/CI use — data-plane only, denied on console-admin like billing and key minting (#4046)",
      "atlas sql — run a read-only SQL query over REST, with --json / --csv output (#4047)",
      "atlas metric run and atlas explore — run a saved metric or browse the semantic layer from the shell (#4048, #4049)",
      "atlas switch / --workspace — select among multiple workspaces per command (#4050)",
      "atlas datasource create and profile — add a datasource with stdin/env secret capture, then profile it (streaming, cancellable) into draft entities (#4051, #4052)",
      "Sign-in hardening banked from the v0.0.34 verification pass — /dashboards and stale-region-cookie fixes (#4089, #4090) plus plus-addressed signup rejection (#4098)",
    ],
  },
  {
    version: "v0.0.34",
    title: "Auth Session-Cookie Fix",
    date: "2026-06-28",
    summary:
      "Fixes a sign-in issue where some browsers were bounced back to the login screen about 30 seconds after a successful login. The cause was a stale, domain-wide session cookie left over from an earlier configuration that quietly shadowed the new per-host cookie. Atlas now clears that leftover cookie automatically on the next request — clean browsers are unaffected, and it restores the regional session isolation introduced in v0.0.31. This release also completes the removal of an unused per-user Stripe field from the database; organization-level billing is unchanged.",
    highlights: [
      "Logins stay durable past the ~30s session-cache window — no more surprise bounce to /login from a stale parent-domain cookie (#4086)",
      "The legacy domain-wide session cookie is evicted automatically and only when present; a no-op for browsers that never had it",
      "Removed the unused per-user Stripe customer column from the database (organization-scoped billing unaffected) (#4013)",
    ],
  },
  {
    version: "v0.0.33",
    title: "Billing & Feature-Ladder Truthfulness",
    date: "2026-06-28",
    summary:
      "Every paid tier now delivers exactly what the pricing page advertises, enforced in code. A single source of truth maps each capability to the plan that unlocks it, so a Starter or Pro workspace can't reach a Business-only feature, and the pricing comparison is generated from what the product actually enforces. Pricing moves to the Structure B model — $39/$69/$149 per seat with a $20/seat at-cost usage credit — and usage past the credit is metered at provider cost (with a runaway-spend ceiling) instead of a hard 110% cutoff. Integration claims were corrected to match what's live, and premium-only code now lives under the commercial license.",
    highlights: [
      "Per-tier feature entitlements enforced at the API layer, not just hidden in the UI — the pricing comparison renders from the same source of truth (#3984)",
      "Structure B pricing: $39/$69/$149 per seat + a $20/seat at-cost usage credit; overage metered at provider cost with a runaway-spend ceiling, replacing the 110% hard cap",
      "Proactive monitoring included on every paid plan (hosted Atlas Cloud only)",
      "Integration claims corrected to verified prod-live status — Google Chat marked coming soon (#3995)",
      "Canonical plugin count locked at 24 behind a CI parity gate (#4066)",
    ],
  },
  {
    version: "v0.0.32",
    title: "Signup & Residency Hardening",
    date: "2026-06-27",
    summary:
      "Follow-up fixes from end-to-end verification of the v0.0.31 regional residency work. Signing up with an email that already exists no longer dead-ends on the verification-code screen — a code is now always sent. And signup stops creating an unused, per-account Stripe customer that the organization-scoped billing model never used (and that didn't exist consistently across regions); billing continues to use the single organization-level customer created at checkout.",
    highlights: [
      "Existing-email signup now always sends the verification code, instead of silently showing the code screen with no email (#4010)",
      "Signup no longer mints an unused user-level Stripe customer; org-scoped billing uses the organization customer created at first checkout (#4012)",
      "Verify-account teardown now also removes the user-level Stripe customer it would previously have orphaned (#4011)",
    ],
  },
  {
    version: "v0.0.31",
    title: "Regional Residency Routing",
    date: "2026-06-26",
    summary:
      "Data residency now isolates the entire workspace — identity included. When you choose Europe or Asia Pacific at signup, your account and your data are created in and served from that region, and the US endpoint genuinely rejects a non-US workspace — no cross-region leakage. This closes a gap where EU/APAC selections were quietly served from the US. It is built on the principle that each region is its own independent stack (ADR-0024, \"the process is the region\"): host-only per-region sessions, region chosen before the first account write, and a returning-user login that routes you to your region without any global store of who lives where.",
    highlights: [
      "EU/APAC signups are provisioned in and served from the selected region; api.useatlas.dev returns 401 for a non-US workspace — no cross-region data leakage (#3967)",
      "Host-only per-region session cookies + cross-origin CORS — a regional session never transits another region's infrastructure (#3970)",
      "Signup chooses your region before the first identity write, so your account lands in-region from the start (#3972)",
      "Returning-user login resolves your region via a stateless fan-out front-door with a cookie fast-path — no global email→region store (#3973)",
    ],
  },
  {
    version: "v0.0.30",
    title: "Landing Blog Refresh",
    date: "2026-06-26",
    summary:
      "A content release. The useatlas.dev blog gets a cleaner redesign and three new posts — a road-to-launch update, a revised founder note, and \"Out of the runtime,\" which lays out why Atlas runs as a real service outside the chat runtime rather than as an ephemeral in-chat tool. No product code changed in this tag; the accompanying work is documentation, including ADR-0024, which records that data residency isolates the entire workspace, identity included.",
    highlights: [
      "Redesigned blog on useatlas.dev with three new posts (#3976, #3978, #3979)",
      "New post: \"Out of the runtime\" — why Atlas runs as a service outside the chat runtime (#3979)",
      "ADR-0024 — data residency isolates the whole workspace, identity included (#3975)",
    ],
  },
  {
    version: "v0.0.29",
    title: "Demo Activation Hardening",
    date: "2026-06-25",
    summary:
      "A follow-up patch to v0.0.28 that makes the hosted demo's first answer actually work in production. The previous demo first-answer fix didn't take in prod — its query whitelist keyed on a literal placeholder connection rather than the real conversation's connection — so a fresh demo could still dead-end on its very first question; it now keys on the real connection and answers immediately. The onboarding email sequence also becomes demo-aware: a demo-only signup is no longer sent a 'your database is connected' message it never earned, and that activation milestone no longer fires prematurely.",
    highlights: [
      "Demo first-answer works in prod — the default query whitelist now keys on the real conversation's connection id instead of a literal placeholder, fixing the dead-end that v0.0.28's fix missed in production (#3961)",
      "Demo-aware onboarding drip — demo-only signups are no longer sent a 'your database is connected' first-query email, and the first-query activation milestone no longer fires eagerly (#3962)",
    ],
  },
  {
    version: "v0.0.28",
    title: "Demo Activation Fixes & Residency Hardening",
    date: "2026-06-25",
    summary:
      "A follow-up patch to v0.0.27's cold-start work, closing two demo activation gaps and tightening data-residency region selection. The hosted demo's very first question no longer dead-ends — the default query whitelist is now unioned across every org bucket, so a fresh demo can answer immediately. Demo-only signups are also no longer sent the 'connect your database' onboarding nudge, which doesn't apply to them. On the hosted service, the data-residency region picker no longer offers the internal 'staging' region as a selectable choice, and region selectability is enforced at assignment time.",
    highlights: [
      "Demo first-answer dead-end fixed — the default query whitelist is unioned across all org buckets, so a fresh hosted demo can answer its first question immediately (#3947)",
      "Demo-only signups no longer nudged to connect a database — the 'connect your database' onboarding email is suppressed for demo-only accounts it doesn't apply to (#3953)",
      "Data-residency hardening — the non-production 'staging' region is no longer a selectable prod residency option, and region selectability is enforced on assignment (#3948)",
    ],
  },
  {
    version: "v0.0.27",
    title: "Cold-Start Activation",
    date: "2026-06-25",
    summary:
      "A focused pass on the first five minutes — getting a new user from landing to their first answer without hitting a dead end. The hosted demo onboarding flow gets a cluster of fixes: a composer that no longer strands you on an empty semantic layer, recovery from a stale or expired session instead of a trap, clearer retry guidance when datasource region resolution fails, and a warmer empty state with a loading skeleton and starter prompts derived from the dataset you just connected. The demo itself becomes cheaper and more observable to run, with a configurable model (defaulting to Haiku on the gateway) and a per-turn latency tracking page. A new public /security page rounds it out, making Atlas's read-only, SELECT-only SQL-safety story legible to anyone evaluating it.",
    highlights: [
      "Cold-start activation polish — first-answer instrumentation and funnel fixes across the demo onboarding path (#3925)",
      "Demo composer dead-end fixed — the demo semantic layer now seeds as published, so a fresh demo can ask a question immediately (#3932)",
      "Session resilience — the onboarding flow recovers from a stale or expired session-cookie instead of trapping the user (#3933)",
      "Region-step clarity — retry guidance plus a regions-error alert when datasource region resolution fails (#3945)",
      "Warmer empty state — a loading skeleton and starter prompts derived from your connected dataset instead of a blank box (#3938, #3935)",
      "Demo observability — a per-turn latency tracking page and a configurable demo model defaulting to Haiku on the gateway (#3931)",
      "Public /security page — the read-only, SELECT-only SQL-safety story made legible for anyone evaluating Atlas (#3923)",
    ],
  },
  {
    version: "v0.0.26",
    title: "Cream + Forest Brand",
    date: "2026-06-24",
    summary:
      "Atlas adopts a new brand — warm cream and deep forest green, light-first — across every surface: the landing site, the documentation, and the product (app, admin, and demo). The look steps away from the saturated dark dev-tool default toward something calmer and more legible for dense data work, with deep forest as the primary accent and a bright teal spark reserved for highlights on dark and green surfaces. Two fixes ride along: the plan-tier reconciliation safety net now runs correctly, and a deployment with no default analytics datasource no longer fails its health check.",
    highlights: [
      "Brand redesign (ADR-0023) — cream + forest light mode across the landing site, docs, and the product app/admin/demo, driven from one shared brand.css token source",
      "Billing reconciliation fix — the plan-tier reconcile sweep no longer errored on a non-existent subscription column, so plan-tier drift is healed from the Stripe source of truth as intended (#3922)",
      "Health robustness — a deployment with no default analytics datasource now reports 'degraded' (HTTP 200) instead of failing its health probe; the default registers only when configured (#3921)",
    ],
  },
  {
    version: "v0.0.25",
    title: "Cross-Source Composition",
    date: "2026-06-23",
    summary:
      "The final piece of cross-group reach: the agent now composes a single answer across multiple datasources in one turn instead of stopping at one source. When a question spans sources, Atlas correlates the separate result sets, tells you which datasource each part came from, and never silently falls back to a single source when it can't reach the others — so a partial answer is reported as partial, not dressed up as complete. This closes the cross-group reach program begun with the v0.0.22 foundation and the v0.0.24 reach picker.",
    highlights: [
      "Cross-source composition — the agent correlates result sets across connection groups within a single turn (#3909)",
      "Provenance reporting — answers state which datasource each part of the result came from",
      "No silent fallback — if a source can't be reached, the answer is reported as partial rather than quietly narrowed to one source",
    ],
  },
  {
    version: "v0.0.24",
    title: "Cross-Group Reach Picker",
    date: "2026-06-23",
    summary:
      "The user-facing completion of cross-group reach, on top of the v0.0.22 foundation. A conversation now carries an explicit reach: 'All sources', where the agent decides which of your connected datasources to consult, or 'Focus' on a single connection group — a hard, exclusive 'only look here'. The scope picker exposes that choice directly, each conversation remembers its own reach and restores it when reopened, and a brand-new chat defaults to All sources so asking across datasources is the path of least resistance. A clean-break migration maps any existing conversation that was pinned to one group onto Focus → that group, so nothing silently broadens what an older conversation can see.",
    highlights: [
      "Group-reach scope picker — choose 'All sources' (the agent routes across every connected datasource) or 'Focus' on one connection group, hard and exclusive (#3895)",
      "Per-conversation reach persistence — each conversation remembers its own reach and restores it on open; brand-new chats default to All sources",
      "Clean-break migration — existing group-pinned conversations map to Focus → that group, preserving their prior behavior",
    ],
  },
  {
    version: "v0.0.23",
    title: "Multi-Tenant Health Isolation",
    date: "2026-06-23",
    summary:
      "A reliability fix for multi-tenant deployments: one workspace's misconfigured datasource can no longer affect the shared region's health. Previously, any registered datasource being unreachable — including a tenant's own connection-group database — flipped the region's /api/health endpoint to an error state and a 503, which could pull the entire region out of the load balancer for every tenant. Now only the region's own primary datasource (and, on the hosted service, the internal database) gates that load-balancer health signal. A non-primary source being unhealthy or degraded stays fully visible in the per-connection health view and the admin Connections page, but no longer changes the platform's top-level status.",
    highlights: [
      "A tenant's unhealthy datasource connection no longer degrades or 503s the shared region's health endpoint (#3907)",
      "Only the region's own primary datasource (+ the hosted internal database) gates the load-balancer health probe",
      "Non-primary datasource health remains visible per-connection in Admin → Connections and the operator health breakdown",
    ],
  },
  {
    version: "v0.0.22",
    title: "Cross-Group Reach Foundation",
    date: "2026-06-23",
    summary:
      "The foundation for cross-group reach — the agent answering questions across all of your connected datasources, not just one connection group at a time. Two pieces land this cycle: executeSQL can now target a specific connection group per query, bounded by a reach limit so a single turn can compose across sources without runaway fan-out; and a Source catalog gives each connection group an auto-generated, refinable description so the agent knows which sources to route a question to. The release also carries a security and correctness batch — the web app moves to a nonce-based Content-Security-Policy that drops unsafe-inline and unsafe-eval, the tables API is scoped to each connection's own table whitelist, the global action-credential health check no longer reports a false 'degraded' on the hosted service, and per-workspace bring-your-own email now resolves through a single shared sender seam.",
    highlights: [
      "Cross-group reach foundation — executeSQL can target a specific connection group per query, reach-bounded so a turn composes across sources without runaway fan-out (#3893)",
      "Source catalog — each connection group gets an auto-generated, refinable description so the agent routes questions to the right datasource (#3894)",
      "Nonce-based Content-Security-Policy for the web app — drops unsafe-inline and unsafe-eval (#3903)",
      "GET /api/v1/tables is scoped to each connection's own table whitelist (#3904)",
      "Action-credential health check is deploy-mode gated — no more false 'degraded' status on the hosted service (#3906)",
      "Unified email sender seam — per-workspace bring-your-own email resolves consistently (#3890)",
    ],
  },
  {
    version: "v0.0.21",
    title: "Real-World Testing Fixes",
    date: "2026-06-22",
    summary:
      "A hardening pass driven by a customer-fidelity soak of the full datasource onboarding flow against a production-mirror environment. The most important fix restores the self-serve trial funnel: the onboarding MCP endpoint was returning 401 to anonymous callers, so a cold AI client could never start a trial — it now responds correctly on both the canonical Streamable-HTTP path and the legacy SSE alias. Elasticsearch and OpenSearch gain the fixes they needed to actually go live (identity content-encoding so OpenSearch stops timing out, a progressive-auth install form, and showWhen-aware validation), and the broader plugin-datasource onboarding path is made whole — non-Postgres/MySQL connections now appear in the admin connections list and health checks, register per workspace, hot-register on publish, and resolve correctly through the chat connection picker. Dev-mode chat also stops claiming 'no connection configured' when published connections already exist.",
    highlights: [
      "Self-serve trial restored — the onboarding MCP endpoint no longer 401s anonymous start_trial callers; both the canonical path and the SSE back-compat alias return 200 (#3886)",
      "Elasticsearch/OpenSearch go live — identity content-encoding fixes OpenSearch query timeouts, plus a progressive-auth install form and showWhen-aware config validation (#3878, #3841, #3842, #3848)",
      "Plugin datasources are first-class in admin — non-Postgres/MySQL connections surface in the connections list and health checks, backed by per-workspace connection pools (#3849, #3853, #3866)",
      "Hot-register on publish — newly published datasources become queryable immediately, with group-of-one environment scoping for standalone connections (#3856, #3855)",
      "Multiple datasources per plugin catalog entry, plus a transient cold-connect retry on the first query (#3858, #3867)",
      "Dev-mode chat gates its empty state on visible connections, not draft count — no more false 'no connection configured' (#3883)",
      "Add-Connection Test button enables as soon as the connection URL is filled (#3846)",
    ],
  },
  {
    version: "v0.0.20",
    title: "Long-Running Turn Bundle",
    date: "2026-06-20",
    summary:
      "Atlas can now survive the long, multi-step turns that real analysis sometimes needs. Three capabilities land together, each off by default and each degrading cleanly to today's behavior when no internal database is configured. Durable sessions checkpoint an agent turn step by step, so a crashed or interrupted run resumes where it left off — and a turn that hits an approval gate now parks instead of failing, then auto-resumes once approved, across the web chat, MCP, and chat-platform surfaces. Context compaction keeps long turns inside the model's context window by summarizing older history on the fly, with per-model window sizing and a cheaper summary model. Durable working memory lets an agent keep per-session state across steps, with deterministic prompt threading, an admin and in-conversation read/reset affordance, subagent isolation, and safety bounds — size caps, a secrets prohibition, and tenant-scoped writes. The release also bundles a hosted agent-onboarding discovery file so a cold AI client can find its way in.",
    highlights: [
      "Durable sessions — agent turns checkpoint per step and resume after a crash or interruption instead of starting over (#3742)",
      "Approval-park + auto-resume — a turn that hits an approval gate parks and resumes once approved, across web chat, MCP, and chat plugins (#3748, #3749, #3750)",
      "Context compaction — long turns stay within the context window by summarizing older history, with per-model window sizing and a cheaper summary model (#3751)",
      "Durable working memory — per-session agent state with deterministic prompt threading, a read/reset affordance, subagent isolation, and size/secret/tenant safety bounds (#3752)",
      "Agent onboarding discovery — a hosted /auth.md tells a cold AI client how to sign up and connect, drift-guarded against the .well-known docs and surfaced from the docs site and landing page (#3824)",
      "All three durability workstreams are off by default and degrade to today's behavior with no internal database",
    ],
  },
  {
    version: "v0.0.19",
    title: "Self-serve MCP Trial Signup",
    date: "2026-06-19",
    summary:
      "Atlas can now hand out a trial of itself straight from an AI client. A new front-door start_trial MCP tool provisions a metered trial workspace on the spot and returns a connect URL; the user claims it on the web behind a one-time-passcode step, which flips the workspace from metered to full and starts the trial clock. Because the front door is open to anonymous callers, it ships with the controls a public signup needs: business-email-only signup that rejects disposable and free-mail domains, metering that withholds answers until the trial is claimed, an automatic reaper that expires trials never claimed past their grace window, and abuse protection via Cloudflare Turnstile plus per-IP and per-email rate limiting. Every signup also flows into the CRM as a tagged MCP_SIGNUP lead. A post-launch hardening wave added a Turnstile boot guard, trial-gate metrics, marketing and legal copy reconciliation, and a single source of truth for the lead-event schema.",
    highlights: [
      "start_trial MCP tool — provision a metered trial workspace from any AI client and get a connect URL back (#3649)",
      "Claim-gated metering — answers are withheld until the trial is claimed on the web via a one-time passcode, which flips metered → full and starts the clock (#3651)",
      "Business-email-only signup — disposable and free-mail domains are hard-denied across both web and MCP (#3650)",
      "Abuse controls — Cloudflare Turnstile plus per-IP and per-email rate limiting on the open signup door (#3654)",
      "Unclaimed-grace reaper — trials never claimed past their grace window are automatically expired (#3652)",
      "MCP_SIGNUP CRM lead source — self-serve signups flow into the CRM tagged by origin (#3653)",
    ],
  },
  {
    version: "v0.0.18",
    title: "Production Hardening II",
    date: "2026-06-18",
    summary:
      "A reliability pass that drains the remaining deferred findings from the post-v0.0.16 production-readiness audit, focused on the operations that have to survive failure cleanly. Uninstalling a plugin now fully tears down everything it owned — scheduled tasks, external webhooks, and dedicated credentials — instead of orphaning them, and canceling a workspace's Stripe subscription is made durable through a cancel-and-reconcile outbox, so a deleted or purged workspace can never strand a live, billable subscription. The profiler and Stripe webhook paths gain OpenTelemetry spans for production observability, and a set of operational guardrails verify region-scheduler intent, MCP boot coherence, and production config floors at startup. The release also bakes the database expand-contract discipline into CI: a guard now rejects any new migration that does a single-phase column rename or drop, ahead of the public launch.",
    highlights: [
      "Complete plugin-uninstall teardown — catalog, marketplace, and datasource uninstall paths now clean up scheduled tasks, external webhooks, and dedicated credentials (#3681)",
      "Durable Stripe teardown — a cancel outbox plus a reconciliation sweep guarantee a deleted/purged workspace's subscription is actually canceled, never left live (#3679)",
      "Production observability — OpenTelemetry spans added to the profiler seam and Stripe webhook processing (#3684)",
      "Operational verifications — EU/APAC scheduler-disabled intent, an MCP-spine boot-coherence guard, and production config-floor warnings (#3687)",
      "Expand-contract migration guard — CI rejects any new single-phase column rename or drop, enforcing the two-phase discipline ahead of the public launch (#3686)",
      "First-boot race fixed — plugin initialization no longer races ahead of internal-DB migrations on a fresh boot (#3741, #3743)",
    ],
  },
  {
    version: "v0.0.17",
    title: "Performance-aware Atlas",
    date: "2026-06-17",
    summary:
      "Atlas now treats query performance as a first-class signal in the two subsystems that drive the agent. The semantic layer learns the shape of your data — it harvests index metadata and column cardinality during profiling and feeds composite-aware index hints to the agent, so generated SQL is more likely to be sargable and fast. Learned patterns gain a performance memory too: every saved pattern carries a rolling query-latency average, scoring is weighted toward the patterns that actually run fast, and a nightly job auto-promotes the winners and decays stale ones. Pattern retrieval now understands multi-turn context and pulls in your favorites and approved suggestions. Alongside the agent work, a SaaS-first configuration pass moves operator config out of environment variables into a runtime settings registry — Stripe price IDs, integration credentials, and tuning knobs are now editable from the Admin console without a redeploy, with environment variables reserved for secrets and boot-time inputs.",
    highlights: [
      "Index-aware semantic layer — the profiler harvests index metadata (Postgres + MySQL) and surfaces composite-aware index hints to the agent (#3634)",
      "Column cardinality — unique/null counts flow through the semantic index so the agent knows each column's selectivity (#3630)",
      "Performance-weighted learned patterns — each pattern carries a rolling latency average; scoring favors fast patterns, with a nightly auto-promote/decay job (#3635, #3636)",
      "Smarter pattern retrieval — multi-turn question context plus user favorites and approved suggestions feed the agent's organizational-knowledge context (#3632, #3633)",
      "Sargable-SQL guidance — the agent prompt teaches sargable predicates and fixes a MySQL date-function anti-pattern (#3629)",
      "SaaS-first config — Stripe price IDs, operator integration credentials, and tuning knobs move from env vars to a runtime, Admin-editable settings registry; no redeploy to change config (#3703, #3704, #3705)",
    ],
  },
  {
    version: "v0.0.16",
    title: "In-Product Datasource Onboarding (Profiler Seam)",
    date: "2026-06-15",
    summary:
      "Onboarding a datasource no longer means a trip to the terminal — and it no longer stops at Postgres and MySQL. Every datasource type Atlas can connect to can now be profiled and turned into a queryable semantic layer in-product, through the install wizard, the CLI, and the MCP server alike. Underneath, a single registry-resolved profiler seam replaces the old per-database special-casing: the connection is resolved once and its credentials are carried as one value, so the wizard, atlas init/diff, and MCP all share the exact same profiling path. The rule is now simply: if it can connect, it can profile. Snowflake, DuckDB, Salesforce, Elasticsearch/OpenSearch, BigQuery, and ClickHouse all move onto the shared plugin profiler contract, and profiling an unfamiliar datasource over MCP works the same as a native one.",
    highlights: [
      "Profiler seam — a registry-resolved profiler spine with an SDK contract, so every datasource type onboards through one shared path instead of a pg/mysql gate (#3620, #3621, ADR-0017)",
      "Universal profiling — profiling now rides connection resolution: if Atlas can connect to a datasource, it can profile it (#3667)",
      "Six datasources on the shared contract — Snowflake, DuckDB, Salesforce (SOQL), Elasticsearch/OpenSearch, BigQuery, and ClickHouse profilers all converge onto the plugin profiler seam (#3622–#3626)",
      "Profile over MCP — plugin-managed datasources can be profiled directly from an MCP client, including BigQuery and Salesforce (#3552, #3664, #3663)",
      "One profiler home — the CLI's parallel profiler directory is deleted; wizard, CLI, and MCP share a single profiling engine (#3627)",
      "Deepened credential seam — the decrypted-credentials path carries one value type instead of parallel url + config fields, and the triplicated wizard prologue is extracted (#3658, #3659, #3657)",
      "Hardened review pass — non-fatal profiler failures de-silenced, per-table errors scrubbed of sensitive detail, and a full .15→.16 diff audit (#3676, #3661)",
    ],
  },
  {
    version: "v0.0.15",
    title: "MCP V2: Prime-Time MCP Server",
    date: "2026-06-14",
    summary:
      "Atlas's MCP server graduates from a read-only data analyst into a complete, production-grade surface that AI assistants can safely act through. The protocol layer is brought up to the latest MCP spec — tool annotations, structured results, in-progress and cancellation signals, pagination, live resource subscriptions, and argument completions — so MCP clients get a richer, more responsive experience. A real security spine now sits underneath every call: roles are resolved against the live database, writes require an explicit mcp:write scope, sensitive actions route through an approval gate, and each workspace gets its own MCP action policy with an admin dashboard and audit attribution. Governance can only be tightened through MCP, never loosened. The headline capability is datasource management over MCP: an assistant can now provision, profile, test, list, archive, and delete datasources end-to-end, with credentials collected only through masked elicitation forms so secrets never pass through the model.",
    highlights: [
      "Protocol uplift to MCP spec 2025-11-25 — tool annotations, structured output, elicitation, progress/cancellation, cursor pagination, resource subscriptions, and argument completions (#3497–#3503)",
      "Security spine — live-DB role resolution, an explicit mcp:write scope for mutations, and an origin=mcp approval gate on sensitive actions (#3504, #3505, #3508)",
      "Per-workspace MCP action policy — a customer-admin kill-switch dashboard governing which MCP actions are allowed, with audit-trail attribution (#3509, #3510)",
      "Datasource management over MCP — provision, profile, test, list, archive, and delete datasources directly from an MCP client (#3545, #3553)",
      "Masked-credential elicitation — datasource secrets are gathered through masked forms and never flow through the model (#3499)",
      "Raise-only governance — MCP can tighten permissions but never lower them below the workspace's configured floor (ADR-0016)",
      "Hardened foundation — a 21-finding correctness & security audit plus an architecture pass unifying the gate composer, session store, and dispatch seam (#3606, #3607)",
    ],
  },
  {
    version: "v0.0.14",
    title: "Billing Hardening & Enforcement Perimeter",
    date: "2026-06-13",
    summary:
      "This release makes billing reliable and honest now that real payments flow through the v0.0.13 checkout. A failed payment is no longer a one-way door — it triggers a recovery sequence with dunning emails and a graduated grace period instead of an abrupt lockout, and past-due or canceled subscriptions stay visible with one-click access to the billing portal to fix them. Token budgets and seat counts now line up exactly across the usage page, the billing page, and live enforcement, and your billing window tracks your actual Stripe subscription cycle rather than the calendar month. Behind the scenes, every way of reaching the agent — chat-platform webhooks, scheduled tasks, the MCP server, admin tools — now honors your plan limits and workspace status through one shared enforcement seam, and deleting, suspending, or purging a workspace correctly tears down its Stripe subscription so deleted orgs are never invoiced again.",
    highlights: [
      "Payment-failure recovery — a failed charge starts a dunning email sequence and a graduated grace period instead of an immediate hard lockout (#3424)",
      "Past-due visibility — past_due and canceled subscriptions are surfaced in the UI with direct billing-portal access, exactly when you need to act (#3429)",
      "Accurate usage accounting — token budgets and seat counts are now consistent across the usage page, billing page, and enforcement, anchored to your Stripe billing period (#3430, #3431)",
      "Honest plan limits — overage copy now describes the real hard cap rather than advertising metered overage that wasn't implemented (#3422)",
      "Closed enforcement perimeter — chat webhooks, scheduled tasks, MCP executeSQL, and admin tools all respect plan limits and suspension through one shared seam (#3419, #3420, #3437)",
      "Stripe teardown on workspace lifecycle — delete, suspend, and GDPR-purge now cancel or pause the Stripe subscription, so removed workspaces stop being billed (#3425)",
      "Durable webhook processing — per-subscription serialization, boot-order safety, and one-trial-per-user guards harden the Stripe sync against races and abuse (#3426, #3445)",
    ],
  },
  {
    version: "v0.0.13",
    title: "Billing Checkout & Elasticsearch Datasource",
    date: "2026-06-12",
    summary:
      "Trials can now become paid plans without leaving the product. The admin billing page gained a self-serve plan picker and Stripe checkout, subscriptions are correctly scoped to your organization, and the billing portal works for managing payment methods and invoices. Behind the scenes, Stripe webhook processing is now durable — every event lands in an idempotency ledger with out-of-order protection, and a periodic reconciliation sweep heals any drift between Stripe and your workspace's plan. Elasticsearch and OpenSearch also arrive as first-class datasources, installable from the marketplace with four auth modes and both SQL and Query DSL surfaces.",
    highlights: [
      "Self-serve checkout — pick a plan and pay from Admin → Billing; the trial-to-paid dead end is closed (#3418)",
      "Org-scoped subscriptions — billing attaches to your organization, not the individual admin who clicked, so teams aren't stranded when an admin leaves (#3416)",
      "Billing portal fixed — manage payment methods, invoices, and cancellation via Stripe's portal (#3417)",
      "Churned organizations land on a locked tier instead of silently reverting to unlimited free usage (#3421)",
      "Durable webhook sync — Stripe events are recorded in an idempotency ledger with out-of-order protection, and a reconciliation sweep self-heals plan drift (#3423)",
      "Elasticsearch/OpenSearch datasource — marketplace-installable, API key / Basic / Cloud ID / AWS SigV4 auth, SQL + Query DSL query surfaces, semantic-layer whitelist enforcement (#3259)",
      "Uniform plugin-datasource onboarding — ClickHouse, Snowflake, and BigQuery are now form-installable on SaaS via one repeatable install pipeline (#3295, #3300)",
      "Bring-your-own-compute sandboxes — E2B and Daytona runtimes ship in the SaaS image and cover both the explore and Python tools (#3409, #3413)",
    ],
  },
  {
    version: "v0.0.12",
    title: "Semantic Layer Onboarding",
    date: "2026-06-06",
    summary:
      "Adding a database now produces a usable semantic layer without a trip to the terminal. A single guided flow — reachable from the onboarding wizard, an inline prompt right after you add a connection, and a \"Generate\" button on any database that has no entities yet — profiles your schema into a complete, queryable baseline instantly and for free, then lets you optionally enrich each table with AI-written descriptions, query patterns, and business context behind an explicit cost confirmation. Semantic layers are now organized by connection group, both on disk and in a grouped tree in the admin console, so workspaces with several databases stay legible at a glance.",
    highlights: [
      "Two-phase generation — an instant, free, no-AI mechanical baseline you can query immediately, plus optional per-table AI enrichment (descriptions, use cases, query patterns) that never runs by accident and always shows the cost first (#3236)",
      "Generate from anywhere — the onboarding wizard, an inline prompt after adding a connection, and a per-group \"Generate semantic layer\" empty state all launch the same flow, replacing the old \"run atlas init\" terminal step (#3237)",
      "Organized by connection group — each database's semantic layer lives in its own directory (semantic/groups/<group>/) and renders as a collapsible group in the admin console, so multi-database workspaces stay legible (#3232, #3235)",
      "One generation engine — the CLI (atlas init) and the web wizard now share the same profiler and enrichment logic, so they produce identical output (#3233)",
    ],
  },
  {
    version: "v0.0.11",
    title: "Connections Console Redesign",
    date: "2026-06-05",
    summary:
      "The /admin/connections page is rebuilt for workspaces that connect more than a handful of datasources. Every connected database and REST API is now a dense, one-line row that expands in place to its details and Test / Edit / Delete actions, instead of an always-open card — so a long list stays scannable. Connections are organized into three labelled sections — Databases, REST APIs, and Apps & CRM — each showing how many are connected and how many are live, and a single \"Add connection\" picker replaces the old always-listed provider rows, gathering database tiles, a custom REST option, and curated APIs in one place. Frontend-only; no change to how connections are stored or queried.",
    highlights: [
      "Collapsible rows — each connection collapses to a one-line summary (identity, type, health, latency) and expands in place to its detail sheet and Test / Edit / Delete actions, replacing the always-open cards (#3230)",
      "Grouped sections — connections are split into Databases, REST APIs, and Apps & CRM, each with a \"N connected · M live\" count that matches the row states",
      "Single Add picker — one \"Add connection\" entry point offering database tiles, a custom REST (OpenAPI) option, and curated APIs, replacing the always-listed unused-provider rows that padded the page",
    ],
  },
  {
    version: "v0.0.10",
    title: "Dashboard Primitives & Polish",
    date: "2026-06-05",
    summary:
      "This release builds the dashboard surface out from a saved-query gallery toward a full BI tool. KPI cards gain period-over-period deltas, value formatting, and inline sparklines; charts and KPIs can carry goal lines and thresholds; and time-series cards support event annotations to mark releases, incidents, or campaigns on the timeline. Dashboards also become explorable and shareable: click a data point to drill down by setting a dashboard parameter, filter every card from one with cross-filtering chips, export any single card to CSV, and export a whole dashboard to PDF or image. Together these turn static dashboards into interactive, presentation-ready views.",
    highlights: [
      "KPI polish — period-over-period deltas, value formatting, and inline sparklines on KPI cards (#3207)",
      "Goal lines & thresholds — reference lines and threshold bands on chart and KPI cards (#3208)",
      "Event annotations — mark releases, incidents, or campaigns directly on time-series cards (#3209)",
      "Click-to-drilldown & cross-filtering — click a data point to set a dashboard parameter and refetch, or filter every card from one with chips and clear-all (#3212, #3213)",
      "Per-card CSV export — download the underlying data of any single card (#3210)",
      "Whole-dashboard PDF / image export — export an entire dashboard for sharing or reporting (#3211)",
    ],
  },
  {
    version: "v0.0.9",
    title: "Production Hardening",
    date: "2026-06-04",
    summary:
      "A production-hardening release focused on security, reliability, and operability ahead of launch. The headline change is internal: Atlas removes a legacy admin-authorization path and now treats workspace membership as the single source of truth for who is an admin, with the last-admin protections made atomic so an organization can never accidentally lock itself out of admin access. The four form-based chat platforms — Telegram, Microsoft Teams, Google Chat, and WhatsApp — graduate from stubbed to functional, workspace-scoped installs. The rest of the release is the output of a production-readiness audit: request tracing and metrics now export to a collector in production, the hosted service fails fast with a clear health signal when a model-provider key is missing or misconfigured instead of silently failing later, and a batch of resilience fixes harden the explore sandbox fallback, orphaned scheduled tasks, plugin health checks, and provider error reporting. Documentation and the marketing site were swept for accuracy.",
    highlights: [
      "Single-sourced admin roles — workspace membership is now the sole source of truth for tenant admins, removing a legacy raw-role authorization path; last-admin guards are atomic so an org can't lock itself out of admin access (#3159, #2890)",
      "Chat platforms go live — Telegram, Microsoft Teams, Google Chat, and WhatsApp graduate to functional, workspace-scoped installs, and a residual uncapped Discord install path was retired (#2994)",
      "Fail-fast provider validation — the hosted service now validates model-provider configuration at boot and surfaces a clear health signal when a key is missing or misconfigured, instead of accepting chats that fail later (#3178)",
      "Production observability — request traces and metrics now export to a collector in production, with consistent span naming across the API and the standalone MCP server (#3175, #3199)",
      "Resilience hardening — explore-sandbox backend fallback, orphaned scheduled-task guarding, plugin health checks, and clearer provider-vs-datasource error classification (#3177, #3180, #3179, #3186)",
      "Docs & site accuracy — environment-variable and error-code references, the security/compliance statement, and site navigation were swept for accuracy (#3193, #3173, #3205)",
    ],
  },
  {
    version: "v0.0.8",
    title: "Dashboard Parameters & Text Blocks",
    date: "2026-06-03",
    summary:
      "Dashboards gain two building blocks. Date-range and filter parameters let a dashboard's viewers narrow every tile to a time window or a shared filter value without touching the underlying queries, and new text / section-block cards let authors add headings, notes, and narrative between charts to structure a dashboard into readable sections. Alongside the dashboard work, this release hardens internals: the CRM lead-capture pipeline moves to an event-driven flusher with edge-triggered delivery, retry timers, and a periodic backstop; the isolated explore sandbox adopts the cleaner v2 runtime ergonomics with no change to its isolation guarantees; and several incomplete legacy chat install paths are disabled until their flows are production-ready.",
    highlights: [
      "Dashboard parameters — date-range and filter parameters scope every tile on a dashboard to a chosen time window or filter value, with no query edits (#3136)",
      "Text & section-block cards — add headings, notes, and narrative blocks between charts to organize a dashboard into readable sections (#3138)",
      "Event-driven CRM lead capture — the lead-capture outbox now flushes on an edge-triggered kick with retry timers and a periodic backstop, replacing fixed-interval polling (#3134)",
      "Sandbox runtime ergonomics — the isolated explore sandbox adopts the @vercel/sandbox v2 API (resource-scoped cleanup + filesystem API) with no change to its deny-all network policy or tool isolation (#3135)",
      "Chat install hardening — incomplete legacy install routes for Telegram, Microsoft Teams, Google Chat, and WhatsApp are disabled until their flows are production-ready (#2994)",
    ],
  },
  {
    version: "v0.0.7",
    title: "Dependency Refresh",
    date: "2026-06-03",
    summary:
      "A maintenance release that brings Atlas's dependencies up to date across the monorepo — no user-facing feature or behavior changes. A within-major sweep keeps every package current on its latest patch and minor release, and several libraries move up a full major version: the sandbox runtime that isolates the explore tool, the Stripe billing SDK, and a handful of UI and utility libraries. Upstream majors that needed more soak time were deliberately held back. Staying current keeps Atlas on supported, security-patched releases and reduces upgrade debt heading toward launch.",
    highlights: [
      "Within-major sweep — every dependency moved up to its latest patch and minor across the workspace (#3123)",
      "Sandbox runtime v2 — the isolated explore sandbox runtime upgraded a major version with no change to its deny-all network policy or tool isolation (#3125)",
      "Stripe SDK v22 — the billing SDK moved up a major version with the API version pinned explicitly, so the billing and webhook schema stays fixed regardless of the SDK's default (#3129)",
      "Library majors — just-bash 3, react-day-picker 10, and diff 9, plus safe shadcn/@duckdb/esbuild bumps (#3128, #3130, #3131, #3133)",
      "Held for soak — the fumadocs-mdx and syncpack majors were deferred for additional soak time (#3132)",
    ],
  },
  {
    version: "v0.0.6",
    title: "Webhook Delivery & Multi-Tenant Hardening",
    date: "2026-06-02",
    summary:
      "A reliability and multi-tenant correctness rollup. Atlas's three outbound webhook senders — the sub-processor change feed, SLA breach alerts, and the webhook-action plugin — now share one delivery engine (HMAC signing, bounded retry with backoff, and a per-attempt timeout) with no change to any existing payload or header. The most visible effect: SLA webhook alerts are now signed and retried, where before they were sent unsigned and dropped on a single network blip. Multi-tenant connection routing is hardened so workspaces that share a datasource install always resolve their own database, SQL dialect, and audit host on every path, and editing or removing a datasource now takes effect immediately instead of waiting out a cache TTL. The usage page surfaces the prompt-cache read/write split from last release's accounting, alongside reliability fixes across backups, the scheduler, chat install limits, and admin auth.",
    highlights: [
      "Signed, retried SLA alerts — SLA webhook alerts are now HMAC-signed (timestamped) and retried with backoff instead of sent unsigned and dropped on a single network failure; a documented verify recipe lets receivers confirm an alert genuinely came from Atlas (#2016)",
      "Unified outbound webhook delivery — the sub-processor change feed, SLA alerts, and the webhook-action plugin share one delivery engine (signing + bounded retry + per-attempt timeout) via @useatlas/webhook-publisher, with every existing wire format unchanged (#2016)",
      "Multi-tenant connection isolation — workspaces sharing a datasource install now resolve their own database, SQL dialect, and audit host on every path, not just pooled deploys, fixing wrong-tenant routing and mixed-dialect query rejections (#2783, #3109)",
      "Immediate datasource config updates — editing or uninstalling a datasource tears down its connection pool right away instead of waiting for a cache TTL to expire (#3109)",
      "Usage-page cache visibility — the usage page now shows the prompt-cache read/write split and billed-vs-effective token counts from the accounting added in v0.0.5 (#3106)",
      "Reliability — accurate backup verify/restore error reporting (#2989), per-tick scheduler traces (#2987), dormant-workspace BYOT catalog-refresh gating (#2377), chat installs capped before the Slack OAuth redirect (#3108), and an admin OAuth-consent fix (#3122)",
    ],
  },
  {
    version: "v0.0.5",
    title: "Gateway Caching & Billing Accuracy",
    date: "2026-06-02",
    summary:
      "This release tightens how Atlas runs and reports its model usage. Prompts routed through the AI Gateway to Anthropic are now cached, so repeated context and long system prompts are billed at the lower cache-read rate instead of full price on every turn, and Atlas now records the cache-read vs. cache-write token split for each request. Billing and usage reporting are also more honest: the usage page shows the model a workspace is actually running rather than a stale default, and hosted (SaaS) workspaces now resolve their default model through the AI Gateway, so the model picker and the real default can no longer disagree.",
    highlights: [
      "AI Gateway prompt caching — prompts sent through the gateway to Anthropic now reuse cached context instead of paying the full token price on every turn",
      "Cache token accounting — Atlas now records the cache-read and cache-write token split for each request, the groundwork for showing caching savings on the usage page",
      "Accurate model reporting — usage and billing surface the model a workspace is actually running, not a stale picker default",
      "SaaS defaults to the AI Gateway — hosted workspaces resolve their default model through the gateway, keeping the picker and the effective default in sync",
      "Reliability — fixed a connection-pool recovery fiber that could leak when a database pool resets",
    ],
  },
  {
    version: "v0.0.4",
    title: "Conversation Scope",
    date: "2026-06-02",
    summary:
      "Each conversation now carries its own data scope, and it sticks. Atlas unifies the chat scope picker across two axes — which SQL connections a question routes to (a connection group plus an Auto / Pin / All-environments mode) and which REST/OpenAPI datasources are in play (exclude individual sources, or focus a conversation on REST only and suspend SQL entirely). Scope is per-conversation and authoritative: a workspace-level sticky preference seeds new chats, but each conversation remembers its own routing and is restored exactly when you reopen it — fixing the long-standing reset-on-reload where a fresh page load silently fell back to the default. The active conversation now lives in the URL, so a reload or a shared link reopens the same chat. The in-app workspace chat and the embeddable widget are now the same component, so scope behaves identically everywhere Atlas chat appears.",
    highlights: [
      "Per-conversation scope that persists — each chat remembers its connection group, routing mode (Auto / Pin / All), and REST datasource selection; reopening a conversation restores exactly the scope it was last used with",
      "Sticky workspace preference seeds new chats — your last-used scope becomes the default for new conversations, but never overwrites a conversation's own saved scope",
      "REST scope — exclude specific REST/OpenAPI datasources from a conversation, or set a REST-only focus that suspends SQL entirely for that chat",
      "Active conversation in the URL — a reload or shared link reopens the same conversation; the composer locks while a conversation loads so a message can't be sent against the wrong scope",
      "Unified chat surface — the in-app workspace chat now renders the same component as the embeddable widget, so Conversation scope behaves identically in-app and embedded",
      "Reset-on-reload fixed — a fresh page load no longer drops your scope back to the default",
    ],
  },
  {
    version: "v0.0.3",
    title: "Spec Lifecycle",
    date: "2026-05-31",
    summary:
      "OpenAPI datasources now keep themselves current. Once you connect a REST service, Atlas tracks its spec over time: a configurable per-install refresh interval re-discovers operations on a schedule, a structured drift diff shows exactly what changed since the last sync, and a breaking-change signal flags when an operation your queries depend on is removed or altered. Specs are fetched once and cached across workspaces — the shared cache reuses the parsed spec and operation graph but never the credential — so re-discovery stays cheap even as installs multiply. This release also repositions the marketing site and docs around Atlas as a semantic layer for any query layer: SQL warehouses or REST/OpenAPI services, answered through one model.",
    highlights: [
      "Scheduled spec re-discovery — set a per-install refresh interval and Atlas re-reads the OpenAPI spec on its own; a 'Rediscover schema' control triggers it on demand",
      "Structured drift diff — every re-discovery produces a readable changeset (operations added, removed, changed) instead of a silent overwrite",
      "Breaking-change drift signal — when re-discovery removes or alters an operation, Atlas raises a breaking-change alert and records a `connection.spec_drift_breaking` audit entry",
      "Shared cross-workspace spec cache — a spec is downloaded once and reused across workspaces; the cache shares the parsed spec and graph, never the credential",
      "Query-layer repositioning — the homepage and docs now present Atlas as a semantic layer for any query layer (SQL or REST/OpenAPI), led by an answer-first hero",
    ],
  },
  {
    version: "v0.0.2",
    title: "REST Datasources",
    date: "2026-05-31",
    summary:
      "Atlas datasources are no longer SQL-only. A new generic OpenAPI primitive lets you connect any REST service that publishes an OpenAPI 3.x spec as a first-class, read-side datasource the agent can query in chat — right alongside your Postgres, MySQL, and warehouse connections. Install from Admin → Connections by pointing Atlas at a spec URL and supplying credentials (API key or OAuth2); Atlas discovers the available operations and the agent calls them through a new `executeRestOperation` tool, with pagination handled for you. Reads are the safe default — write operations are strictly opt-in, per endpoint, behind a confirm-before-write step — and an SSRF egress guard keeps every request scoped to the service you configured. Twenty, Stripe, GitHub, and Notion ship as ready-made connectors built on the same primitive.",
    highlights: [
      "Connect any OpenAPI/REST service as a datasource — point Atlas at an OpenAPI 3.x spec, add credentials, and the agent can query it in chat next to your SQL connections; install, rediscover, and toggle the operation representation from Admin → Connections",
      "Ready-made connectors for Twenty, Stripe, GitHub, and Notion — thin wrappers over the generic primitive, each handling its own auth and vendor quirks (Stripe `expand[]`, Notion's required `Notion-Version` header, GitHub OAuth2)",
      "Automatic pagination — cursor, offset, page, and link-header strategies are handled for you, with page-level caching so large result sets don't re-fetch",
      "Read-safe by default, writes opt-in — every operation is validated before it runs; write endpoints require an explicit per-endpoint allowlist plus a confirm-before-write prompt before anything mutates",
      "Credentials encrypted at rest + SSRF egress guard — API keys and OAuth tokens are stored encrypted, and requests are scoped to the configured base URL so a spec can't redirect Atlas at internal services",
      "API-key and OAuth2 install paths — connect via a short credentials form or a full OAuth2 authorization flow, depending on the service",
    ],
  },
  {
    version: "v0.0.1",
    title: "Release Process Bootstrap",
    date: "2026-05-29",
    summary:
      "The first tagged release of Atlas — and the start of versioned, tag-gated production deploys. From here, prod advances only when an annotated git tag is cut, rather than auto-deploying on every merge: `main` continuously ships to staging, and a release tag promotes that exact commit to production. The headline deliverable is the customer-facing Stability Contract, which spells out what's stable to build on today (the REST API surface, the MCP tool surface, the plugin SDK, the semantic-layer wire format) and what may still change before v1.0.0. Docs + release tooling only — no runtime feature ships under this tag; it's the foundation the rest of the v0.0.x train is cut from.",
    highlights: [
      "Tag-gated production deploys — prod advances only on an annotated `v*.*.*` tag via the `/release` flow; `main` continuously deploys to staging, so production is always a deliberately tagged commit",
      "Stability Contract published — explicit stability commitments for the REST API, MCP tool surface, plugin SDK, and semantic-layer wire format, at Reference → Stability",
      "Versioning policy (ADR-0008) — the `v0.0.x` series is the pre-launch development train; `v0.1.0` is reserved to mark the public launch (target July 2026)",
    ],
  },
];

/**
 * Pre-public-versioning development history. These are internal milestone numbers, not public
 * semver — they predate the git-tag train (ADR-0008) and are kept as a record of what shipped
 * during development. The public version train is `releases` above.
 */
export const developmentHistory: Release[] = [
  {
    version: "1.6.0",
    title: "CRM & lead capture",
    date: "2026-05-26",
    summary:
      "Every meaningful lead event — demo signup, Better Auth signup, Stripe trial-to-paid conversion, talk-to-sales submission — now lands in Twenty CRM at crm.useatlas.dev automatically, tagged by source. The `mailto:sales@useatlas.dev` CTAs on `/pricing`, `/sla`, `/dpa`, and `/terms` are replaced with a real in-page form (Cloudflare Turnstile-protected) that creates a Twenty Person + Note with qualifying context. Under the hood, a durable `crm_outbox` table absorbs Twenty downtime — every dispatch is enqueue-then-flush via a Scheduler-backed background flusher with exponential backoff, plus an operator UI at `/platform/crm-outbox` for inspection / retry / mark-dead. The integration ships as a general-purpose `@useatlas/twenty` plugin (AGPL) plus a SaaS wiring layer in `ee/src/saas-crm/` gated behind the `SaasCrm` Context.Tag — self-hosted Atlas gets the plugin (admin UI install or `atlas.config.ts`) but never the SaaS dispatch path, with a closeout `scripts/check-twenty-resolver-imports.sh` gate locking the seam. Numbers: 11 issues + PRD #2726, slice 6 (Twenty-as-datasource) deferred to 1.7.0 because Twenty Cloud doesn't expose Postgres.",
    highlights: [
      "Demo / signup / sales-form / conversion → Twenty Person — four event sources stamp `atlasFirstSource` (sticky) + `atlasLastSource` (overwritten) custom fields. Better Auth `databaseHooks.user.create.after` (#2731) enqueues `signup` leads; Stripe `customer.subscription.created` (#2737) enqueues `conversion` leads for the already-stamped Person",
      "Talk-to-sales dialog replaces mailto — shared `<TalkToSalesDialog>` (#2730 / #2733) on `/pricing` Business tier, `/sla`, `/dpa`, `/terms` with a page-specific `topic` field. `POST /api/v1/contact` enqueues a Person + Note via the outbox; Cloudflare Turnstile siteverify fail-closed; `<noscript>` mailto fallback preserved",
      "Durable `crm_outbox` + Scheduler-backed flusher (#2729) — replaces fire-and-forget capture with classify/backoff/dead-letter semantics; depth gauges + `oldest-pending-age` warned per flusher tick (#2734); operator UI at `/platform/crm-outbox` (#2735) for `retry` / `mark-dead` with both mutations audit-logged (`ADMIN_ACTIONS.crm_outbox.{retry, markDead}`)",
      "`@useatlas/twenty` plugin (#2727 / PR #2785) — AGPL, self-hostable via Admin → Integrations → Twenty or `atlas.config.ts:plugins`. Admin UI at `/admin/integrations/twenty` (#2732) writes `workspace_plugins.config` with F-41 selective-field encryption on `apiKey`. Actions: `upsertPerson`, `createNote`, `createOpportunity`",
      "`atlas ops backfill-crm-leads` (#2736) — one-shot CLI enqueues every existing `demo_leads` row into `crm_outbox` so historical signups also dispatch to Twenty. Idempotent via the per-source idempotency key; `--dry-run` / `--batch-size` / `--source` flags",
      "Credential resolver split (#2850 closeout) — `ee/saas-crm/` reads the `TWENTY_API_KEY` env for Atlas's own pipeline; `plugins/twenty/` reads per-workspace `workspace_plugins.config` only. `scripts/check-twenty-resolver-imports.sh` gate keeps `resolveOperatorCredentials` reachable only from `ee/src/saas-crm/`. Two leak directions structurally impossible — a customer install with missing apiKey can't fall through to Atlas's operator key, and a future change in `ee/src/saas-crm/` can't accidentally read a customer's `twenty_integrations` row",
      "`SaasCrm` Context.Tag with `available: boolean` — load-bearing for the `/api/v1/contact` 404-vs-200 branch and the `/platform/crm-outbox` nav-link gate (`saasOnly`). Noop default returns success-after-enqueue without dispatching, so self-hosted Atlas runs without Twenty credentials and the SaaS-only pages 404 cleanly",
      "Slice 6 deferred to 1.7.0 — Twenty Cloud doesn't expose Postgres, so the lightweight \"plug it in as an Atlas connection\" path isn't available. Generic REST / non-SQL datasources (Twenty, Stripe, OpenSearch) is now the seed for 1.7.0 ([milestone #54](https://github.com/AtlasDevHQ/atlas/milestone/54))",
    ],
    githubMilestone: 52,
  },
  {
    version: "1.5.3",
    title: "Multi-platform install models",
    date: "2026-05-26",
    summary:
      "Self-serve integrations broaden from Slack + Salesforce + Jira to **eight chat platforms** plus Linear. Workspace admins can now connect Telegram, Discord, Linear, GitHub, Teams MultiTenant, WhatsApp, and Google Chat from `/admin/integrations` — each shipped as a `plugin_catalog` row covering the three install model shapes (OAuth, Form/StaticBot, Service-account) without an `atlas.config.ts` edit. Under the hood, `workspace_plugins` graduates to the **universal install record** for both Datasource and Chat/Action integrations, and the legacy `connections` table is dropped in a one-shot migration (slice 6) — Datasource credentials now live in `workspace_plugins.config` JSONB via selective-field encryption, same pattern as every other plugin secret. `/admin/integrations` legacy chrome is killed in favour of a Chat / Actions section split; Salesforce moves under `/admin/connections` (it's a Datasource, not an Integration). Catalog state gains a `coming_soon` flag with an `atlas.config.ts` operator override so SaaS and self-hosted can present different cards. An Email `sendEmail` agent-loop tool wires the existing `@useatlas/email-digest` action into the agent via LazyPluginLoader. The 1.5.2 chat-plugin × Atlas extension-contract audit picks up its 4th instance closeout (#2680 reaction-back hotfix) with brand-typed `ChannelId` / `ThreadId` / `WorkspaceId`. Numbers: 32 issues + PRD #2738, 17-slice plan (Phase A foundation → E closeout) plus an operator-surface docs sweep (10 docs gaps closed).",
    highlights: [
      "Eight chat platforms self-serve installable — Slack, Teams, Discord, Telegram, Linear, GitHub, WhatsApp, Google Chat. Each ships as a `plugin_catalog` row that workspace admins connect from `/admin/integrations` without an `atlas.config.ts` edit; SaaS gets per-region App Registrations, self-hosted operators register the App once",
      "Three install model shapes formalised — OAuth (Slack/Salesforce/Jira/Linear/GitHub-App), Form/StaticBot (Telegram/Discord/WhatsApp/Linear-apikey/Webhook/Obsidian/Email), Service-account (Google Chat + GitHub PAT, manifest-paste for Teams). See [ADR-0006](/docs/adr/0006-three-pillar-integration-taxonomy) for the taxonomy, [ADR-0007](/docs/adr/0007-unified-install-pipeline) for the unified install pipeline",
      "`workspace_plugins` becomes the universal install record — one table for Datasource + Chat + Action installs replaces the legacy split (`connections` for Datasource, `workspace_plugins` for everything else). Slice 6 (#2744) is the cutover: `ConnectionRegistry` pivots to read `workspace_plugins`, migration 0096 drops the `connections` table, the `__demo__` Postgres row becomes an `auto_install` catalog entry, and the admin Connections route reuses the integration install renderer",
      "Datasource credentials migrate to selective-field encryption — Postgres / MySQL / Snowflake / ClickHouse URLs and credentials live in `workspace_plugins.config` JSONB, encrypted per-field per the catalog row's `config_schema` `secret: true` flag. Same `encryptSecretFields` / `decryptSecretFields` helpers as every other plugin secret. `encryptUrl` / `decryptUrl` deprecated re-exports retired per the original #2285 schedule",
      "Salesforce moves to `/admin/connections` (#2745) — it's a Datasource via the OAuth render path, not an Integration. Removes the catalog stub from `/admin/integrations`",
      "`/admin/integrations` dedup (#2746) — legacy chrome retired in favour of a Chat / Actions section split; each section renders only the catalog rows for its pillar. `coming_soon` state (#2747) ships behind an `atlas.config.ts:catalog` operator override so SaaS and self-hosted can present different availability",
      "Email `sendEmail` agent tool (#2698) — the `@useatlas/email-digest` action plugin gets a `sendEmail({ to, subject, body })` agent-loop wrapper via LazyPluginLoader; the agent can now follow up by email when a query result deserves a heads-up",
      "Brand-typed identity at the chat-plugin boundary — `WorkspaceId` / `AtlasUserId` / `ExternalUserId` (1.5.0 follow-up #2641) joined by `ChannelId` / `ThreadId` (#2680) make encoding mismatches compile-uncheckable; the 4th #2677-pattern hotfix (`pending.record(channelId)` vs `pending.peek(threadId)`) closes that error class for good. The Atlas-extension contract audit doc + read-side fail-loud warns from 1.5.2 remain the load-bearing guard going forward",
      "Operator-surface docs sweep (10 gaps) — environment-variables.mdx now lists OAuth TTLs + region URLs + Vercel sandbox vars + MCP session timeout (#2767); config.mdx gains a Catalog section for `plugin_catalog` seeding (#2768); CLI reference adds the operator subcommands (`proactive enable/disable`, `seed`, `ops wipe` — #2766); error-codes.mdx gains an Effect-tagged catalog (#2774); architecture/entitlements.mdx documents the 1.5.2 PLAN_RANK bundle (#2772); architecture/enterprise.mdx documents the 1.5.1 `check-ee-imports.sh` + `ee-stub-build` operator surface (#2770); `useMcpConnect` (#2775), `@useatlas/obsidian-reader` + `@useatlas/webhook-action` (#2773), and the deleted `@useatlas/slack` redirect (#2771) all land in their respective pages",
      "Pre-customer posture, clean breaks — no migration shim for the legacy datasource-install path; the `connections` table is dropped in one go. Test mocks migrate to `encryptSecretFields` rather than `encryptUrl` stubs",
    ],
    githubMilestone: 51,
  },
  {
    version: "1.5.2",
    title: "Self-serve integrations",
    date: "2026-05-23",
    summary:
      "Atlas integrations no longer require an `atlas.config.ts` edit per customer. A new `/admin/integrations` page lets workspace admins install Slack, Salesforce, Jira, Email, Webhook, and Obsidian themselves — operators register the App once per platform, customers click Connect, OAuth (or a short form) handles the rest. Six platforms shipped via two re-usable patterns: lazy-loaded OAuth handlers under `/api/v1/integrations/<platform>/{install,callback}` for Slack/Salesforce/Jira, and a form-based install path for static-credential platforms (Email/Webhook/Obsidian). Per-tenant credentials live in two stores by concern (ADR-0003 + ADR-0005): install metadata in `workspace_plugins`, secrets in a new `integration_credentials` table encrypted with `ATLAS_ENCRYPTION_KEYS`. Disconnect is a single button with dual-store teardown. A new `WorkspaceInstallGate` short-circuits proactive listener events for workspaces that don't have a Connection — every chat event consults the gate before classifier work runs. Slack proactive answers also got a UX pass: threaded replies, conversational tone (not SQL-developer-mode), and disclosure buttons for the asker to see the underlying SQL on demand. Numbers: 33 issues + parent PRD #2649, 7 OAuth slices + 7-step closeout sweep, 1.5.1's `core → ee` inversion held throughout.",
    highlights: [
      "Self-serve `/admin/integrations` page — workspace admins see catalog cards for every Platform the operator registered (per-region SaaS App Registrations) and click **Connect** to start OAuth; the catalog is seeded from `atlas.config.ts:catalog` at boot, so adding a new Platform is a one-time operator task per region rather than a per-customer config edit",
      "Slack OAuth lifted to `/api/v1/integrations/slack/{install,callback}` (#2653) — `SlackOAuthInstallHandler` writes the install record (`workspace_plugins`) and the credential (`chat_cache:slack:installation:<teamId>`) atomically per [ADR-0003](/docs/adr/0003-two-store-chat-install-metadata-credentials); legacy `/api/v1/slack/{commands,events,interactions}` routes retired in #2683 in favour of the chat-plugin's single webhook",
      "Salesforce as first lazy integration (#2658) + `integration_credentials` table — per-platform OAuth handler + `LazyPluginLoader` instantiates the plugin on first use per workspace, process-cached thereafter; secrets land in the new `integration_credentials` table (one row per (workspace × catalog_id × credential_type)) encrypted by `ATLAS_ENCRYPTION_KEYS`, eliminating the JSONB-blob credential pattern. See [ADR-0005](/docs/adr/0005-integration-credentials-table)",
      "Jira as second lazy integration (#2659) — ~54% fewer files than Salesforce; proved the lazy-OAuth pattern abstracts and ships in days, not weeks. Same `OAuthPlatformInstallHandler` + `OAuthPlatformTokenRefresher` shape — adding a 3rd platform now costs ~5 files",
      "Form-based install for static-credential platforms (#2660 / #2661) — Email/Webhook/Obsidian don't need OAuth; admins paste a target URL / SMTP creds / vault path into a typed form and the install record lands directly. Same catalog seam as OAuth, different handler kind (`form` vs `oauth`)",
      "Disconnect flow (#2656) — `DELETE /api/v1/integrations/:platform` + an admin button on every connected card; dual-store teardown deletes credentials FIRST then the install record (ordering per ADR-0003 so a half-failed disconnect can't leave an orphan token in `chat_cache`)",
      "`WorkspaceInstallGate` (#2655) — every proactive listener event consults `workspace_plugins` for an enabled row before classifier work runs; no install record = no Connection = silent skip (no classify, no meter, no rate-limit hit). Closes the multi-tenant proactive bypass that #2607 left open",
      "Entitlement bundle (#2713, arch-win #70) — unified `PLAN_RANK` rank ordering across the wire + `is_operator_workspace` flag for the Atlas dogfood org's runtime bypass + 4-layer gating (catalog → wire → backend → renderer) + throttled gate-deny logging. Admin UI no longer lets you configure features your plan-tier can't actually use (#2701 closed the silent-deny gap)",
      "Slack proactive UX polish (#2704 / #2705 / #2709) — answers now post as threaded replies off the asker's message instead of bare-channel posts; tone shifted from SQL-developer-mode to conversational; disclosure buttons reveal the underlying SQL + result table on demand",
      "Chat-plugin × Atlas extension contract audit (#2677 / #2725) — new `docs/architecture/chat-plugin-atlas-contract.md` enumerates every Atlas extension field at the `@useatlas/chat` / `@chat-adapter/*` boundary with legacy-writer → new-writer → read-sites → fail-loud transitions, closing the 3-of-3 pattern that produced #2628 / #2630 / #2676. CLAUDE.md gains a `Plugin migrations` checklist locking future PRs to update the contract doc",
      "Pre-customer posture, clean breaks allowed — no migration shim for the legacy `slack.ts` routes; the chat-plugin owns the surface end-to-end. `@useatlas/types@0.1.6` hoists catalog literal unions so SDK + react consumers share the wire vocabulary",
    ],
    githubMilestone: 50,
  },
  {
    version: "1.5.0",
    title: "Proactive Chat",
    date: "2026-05-17",
    summary:
      "Atlas now answers questions in your chat platform without being summoned. A new `/ee`-gated paid tier turns Atlas into a passive listener on Slack channels admins opt in to: it watches for data-shaped messages, reacts with a single emoji when it thinks it can help, and only generates an answer when the asker taps the reaction. No mention, no slash command, no thread interruption — until the user opts in. A three-layer kill switch (per-channel pause via `@atlas pause`, admin workspace toggle, per-user DM `unsubscribe`) plus a monthly quota cap give workspaces the controls they need to ship this in production. Slack-first; the same pipeline is ready for Teams/Discord/etc. once the early adopters hit the <5% misfire / ≥70% acceptance bar. Numbers: 10 issues across detection, controls, audit + meter, sensitivity, public-dataset HITL, feedback, and a one-time install consent flow.",
    highlights: [
      "Reaction-first tracer — Atlas listens in opt-in Slack channels, classifies messages as data questions with a sensitivity-tunable confidence threshold, and reacts with a single emoji; the asker taps the reaction to pull an answer (no DM spam, no thread takeover until consent)",
      "Three-layer kill switch — channel members can `@atlas pause` for 24h, workspace admins can disable proactive mode globally, individual users can DM `unsubscribe` to opt out across the workspace; all three short-circuit before classification",
      "Admin opt-in surface — Settings → Slack → Proactive Mode lets admins enable per workspace, choose a sensitivity preset (low / medium / high), and pick channels from a checkbox list; nothing leaks until admin flips it on",
      "Meter + audit instrumentation — every reaction, expansion, and answer lands in `query_audit` with a `proactive` actor kind; new metering surface tracks monthly quota usage per workspace with a hard cap to prevent runaway costs",
      "Public-dataset HITL — when a non-linked Slack user asks a question against a workspace's public datasets, Atlas surfaces an answer for admin review before posting; design partners can ramp public-Q&A confidence before flipping the switch",
      "Inline feedback buttons + `/atlas feedback` — every proactive answer ships with 👍 / 👎 buttons plus a slash command for free-form text; feedback rows feed the future sensitivity-tuning loop",
      "Sensitivity preset rationale — each preset (low / medium / high) ships with a documented confidence threshold, expected misfire rate, and a workspace-visible reasoning trail so admins can pick the bias that fits their culture",
      "Activation announcement + install consent — when proactive mode is first enabled, Atlas posts a one-time disclosure to the admin-configured announcement channel and gates the install flow on the admin acknowledging the data-handling policy; idempotent on re-enable",
      "Monthly quota cap — workspace-level monthly question cap (default tuned per tier) hard-stops proactive answers when exceeded, with admin alerts at 80% / 95% / 100%; quota resets on the billing anchor",
      "`/ee`-gated, Slack-first — feature lives in `ee/` under the commercial license; self-hosted workspaces ship without it. Teams, Discord, and Google Chat adapters are wired but feature-flagged off until the misfire / acceptance bar holds in production",
    ],
    githubMilestone: 43,
  },
  {
    version: "1.4.6",
    title: "Chat as dashboard editor",
    date: "2026-05-17",
    summary:
      "Dashboards now have a chat-bound editor. Open the chat drawer on a dashboard and Atlas knows which cards you can see — `executeSQL`, `createCard`, `updateCardSql`, and `removeCard` route through the bound dashboard automatically. Every admin mutation flows into your **personal draft** of the dashboard rather than the published copy your teammates see, so you can iterate on a card definition without spooking the org. Publish promotes the draft via an atomic three-way merge against a persisted baseline — overlapping teammate changes surface as a one-click rebase banner, non-overlapping changes merge cleanly. A new `screenshotDashboard` vision tool lets the agent literally see what the user sees so it can answer 'why is this card flat?' from pixels. Numbers: PRD + 8 implementation slices, all landed in one day with three migrations carrying matching `pgTable` mirrors.",
    highlights: [
      "Chat-bound dashboard editor — open the chat drawer on any dashboard page; the agent picks up a `boundDashboardId` context so `executeSQL` / `createCard` / `updateCardSql` / `removeCard` target the dashboard automatically; conversations persist `bound_dashboard_id` for hand-offs from the root chat",
      "Per-user drafts foundation — every admin mutation writes to the caller's draft in `dashboard_user_drafts`, never directly to the published copy; `dashboard-versioning` deep module owns transactional `publishDraft` with a persisted `baseline jsonb` for exact three-way merge and a stale-baseline `409` guard for concurrent writes",
      "Publish UI + diff modal — dashboard header gains a draft badge with pending-change count; **Publish** opens `PublishDiffModal` with a card-by-card diff renderer before committing; a baseline-changed banner offers a one-click rebase when a teammate publishes underneath you",
      "Stage tracker for destructive ops — `removeCard` and `updateCardSql` return a `stage_required` envelope rather than applying immediately; the UI overlays ghosts on affected cards; pure idempotent `pending → applied` / `pending → discarded` transitions in the new `stage-tracker` deep module",
      "`screenshotDashboard` vision tool — long-lived Chromium pool, per-(user, dashboard) cache, mutation-invalidated; warm p50 1.2–1.5s, 33/33 OK in the spike; agent uses pixels to answer 'why is this card flat?' instead of guessing from SQL alone",
      "History tab — dashboard chat drawer ships a History tab listing prior chat sessions tied to this dashboard (workspace-wide); each session opens as a read-only transcript so teammates can pick up an investigation mid-flight",
      "`createDashboard` reframe — renamed from `proposeDashboard`; persists a real row in the user's draft; root chat hands off to the bound drawer via `?openChat=true` so creation-to-edit is one continuous conversation",
      "`ATLAS_DASHBOARD_DRAFTS_ENABLED` flag flipped to default-ON — the per-user draft path is now the default for all installs; setting the env var to the literal string `false` falls back to the pre-1.4.6 direct-write model with the chat-bound editor degrading to a read-only viewer",
      "Migrations 0073 / 0079 / 0083 — `conversations.bound_dashboard_id`, `dashboard_user_drafts`, `dashboard_stage_changes`; each carries a matching `pgTable` mirror in `schema.ts` and real-Postgres coverage via `migrate-pg.test.ts`",
    ],
    githubMilestone: 46,
  },
  {
    version: "1.4.4",
    title: "Multi-environment semantic layer",
    date: "2026-05-17",
    summary:
      "The biggest schema shift since 1.0. Workspaces can now group multiple connections into a single **environment** (e.g. `us-int`, `eu`, `us-prod` all running the same schema) and have every piece of authored content — semantic entities, PII classifications, dashboards, scheduled tasks, approval rules — live at the group level instead of the connection level. The agent picks up group-aware chat routing automatically; the admin UI gains a merge-into-group wizard, a Phase 4 archive cascade for retiring a group cleanly, and a `Group by [Type | Environment]` toggle on `/admin/connections`. A drift-on-tree treatment on `/admin/semantic` retires the separate `/admin/schema-diff` page. `@useatlas/types` graduates to 0.1.x as the legacy `connection_id` columns are dropped from the wire. Numbers: PRD + 10 implementation slices + 17-finding closeout audit + a 2026-05-16 dogfood follow-on covering admin IA reshape (PRD #2458 + 5 slices), SaaS plan + trial onboarding (PRD #2464 + 4 slices), and three rounds of browser-driven verification fixes — 64 issues total.",
    highlights: [
      "Connection groups foundation — `connection_groups` table + admin CRUD UI (`/admin/connections → Environments`) lets workspaces collapse N connections sharing the same schema into one named environment with a primary member; primary is the auto-pick for single-environment queries and drives view-time resolution for dashboard cards",
      "Group-scoped content end-to-end — semantic entities (#2340), PII classifications (#2341), dashboard cards (#2342), scheduled tasks (#2343), and approval rules (#2344) all carry `connection_group_id` and resolve at run-time; getEntity / deleteEntity / dashboard refresh / scheduler tick all respect the group boundary",
      "Group-aware chat routing + per-turn env override (#2345) — the agent picks an environment for each turn based on conversation context; users can override per-message via a picker in the chat header; the override propagates into `executeSQL` as `connectionGroupId`",
      "Admin merge-into-group wizard + Phase 4 archive cascade — convert N existing connections to a new environment in one flow; archiving a group cascades to its members, content, and scheduled tasks atomically; UX warns up-front for cards / tasks that would orphan",
      "`/admin/semantic` drift drawer + tree (PRD #2458) — drift badges on the file tree highlight entities whose live DB schema diverges from the YAML; the drawer surfaces a column-level diff plus inline reconcile actions; `/admin/schema-diff` retired (pre-customer, no migration needed)",
      "`/admin/connections` Group-by toggle — switch the connection list between **Group by Type** (Postgres / Snowflake / ClickHouse) and **Group by Environment** (us-int / eu / us-prod) so admins can scan either axis",
      "SaaS trial onboarding (PRD #2464) — every SaaS signup gets a 14-day trial assigned at workspace creation, one-time backfill for existing free workspaces, trial countdown banner on `/admin/billing`, and `user-configured` copy retired from `/admin/model-config` so the trial path doesn't show a stale prompt",
      "Application-layer FK gate on `connection_group_id` (#2424) — conversations + dashboards now reject cross-org group references with a typed error before the write hits Postgres, closing the foothold the closeout audit found in #2407",
      "Legacy `connection_id` dropped (#2346 + #2347 + migration 0069) — wire types, route handlers, and admin UI all migrate to `connectionGroupId` exclusively; `@useatlas/types` major-bumped to 0.1.x to signal the breaking change",
      "Closeout audit (#2407) shipped 17 fixes — `g_*` synthetic name leaks, env-delete tombstones, single-connection picker visibility, dashboard card-create single-group bypass, scheduler tenant boundary crosses, `me-connection-groups` empty-org silence, and a long bug-pass tail",
      "Verification-pass batches (2026-05-16) — first wave (8 parallel agents) closed chat empty-state DB overlay, ConnectionRegistry boot-hydrate, SaaS demo-conn leak, Add Connection env field + 429 surfacing, admin MFA gate consistency, post-signup landing race, stale-bundle cache headers; second wave finished the `/admin` Overview platform/org split and `/admin/connections` live-count parity; third wave (PM browser-driven) closed useAdminFetch empty-path CORS, entity-count drift across admin surfaces, missing chat env picker, agent `default`-leak on SaaS, orphan empty env group, and the Cloudflare CSP beacon",
      "Architecture-wins #58–#60 — `withGroupScope` helper deep module extraction (#2338) became the standard for any new group-scoped query; `stripGroupPrefix` shared util consolidated 6 duplicated implementations",
    ],
    githubMilestone: 45,
  },
  {
    version: "1.4.5",
    title: "Cross-environment querying",
    date: "2026-05-17",
    summary:
      "Workspaces with more than one **environment** (e.g. `us-int`, `eu`, `us-prod` connection groups sharing the same schema, from 1.4.4) can now ask one question and get an answer across all of them. The agent picks a routing scope per question — `Auto` for environment-specific queries, `Pin` for stable single-source results, `All envs` to fan out and merge under an `environment` discriminator column. Partial failure is first-class: a fan-out that succeeds on 2 of 3 environments returns the merged rows and surfaces the third as a degraded warning rather than blowing up the whole turn. The full audit trail rolls up per-environment child queries to a parent row via `query_audit.parent_audit_id`. Numbers: PRD + 5 slices, all landed same day, with two new deep modules (`environment-routing`, `multi-env-result-merger`) and `@llm`-tagged e2e coverage.",
    highlights: [
      "Three routing modes — `Auto` (agent picks per question), `Pin` (every call targets the pinned environment), `All envs` (every call fans out and merges); picker lives in the chat header; default is `Auto`",
      "`executeSQL` `scope` param — agent fills `auto` / `pin` / `all` based on conversation `routing_mode` + per-turn semantics; `environment-routing` deep module owns the dispatch decision; `multi-env-result-merger` owns the fan-out + row merge with an injected `environment` discriminator",
      "Agent system prompt teaches scope decisions — heuristics documented in-prompt so the agent knows to pin for dashboard-card SQL but fan out for 'compare X across environments' questions; eval canonical questions cover both halves",
      "Conversation-level `routing_mode` — persisted on `conversations.routing_mode` so a user pinning to `eu` mid-investigation stays pinned across page reloads; three-state shadcn picker UI with descriptive helper text",
      "Partial-failure as a first-class result — `envContributions` on `ExecuteSqlResult` carries per-environment row counts + errors; a 2-of-3 success returns the merged rows and surfaces the third's error as a degraded warning instead of failing the turn",
      "Audit-log parent rollup — `query_audit.parent_audit_id` links per-environment child queries to a parent row so admin audit views see a single logical query plus its physical fan-out children",
      "OTel `atlas.routing_mode` attribute — every agent step tagged for cross-environment analytics in the observability stack",
      "Browser e2e coverage — `@llm`-tagged happy-path + partial-failure specs in `e2e/browser/` that skip cleanly when no overlay / LLM key is present; runnable in CI on tagged releases",
    ],
    githubMilestone: 47,
  },
  {
    version: "1.4.3",
    title: "Agent-first polish + BYOT review tail",
    date: "2026-05-12",
    summary:
      "Round-out release for 1.4.2 — closes the post-#2174 BYOT direct-provider review tail and ships the SDK multi-workspace MCP shape. Tighter typing across the BYOT credential boundary (a discriminated `WorkspaceCredentials` union with a parameterized `ByotAdapter<Cred>` so Bedrock joins the same dispatch table as Anthropic and OpenAI). Branded encryption return types (`URLSecret` vs `OpaqueSecret`) make the URL-passthrough vs prefix-only picking guide a compile-time fact. A scheduler-graduated daily catalog refresh replaces the cron-shaped helper, with an admin manual-run endpoint visible from the Scheduler Tasks page. `@useatlas/sdk@0.0.14` exposes the plural `workspace_ids` claim so embedded onboarding flows can render a workspace picker. Docs catch up too: Bedrock IAM + region guide and the direct-provider model picker reference. Numbers: 12 issues across BYOT typing, encryption hygiene, scheduler graduation, SDK multi-workspace surface, and the auth-client cast-collapse arc.",
    highlights: [
      "Scheduler-driven BYOT catalog refresh — daily cron walks every encrypted credential, surfaces success/failure counts in `/admin/scheduler/tasks`, and exposes admin-only `POST /api/v1/admin/scheduler/tasks/byot-catalog-refresh/run` for manual triggers; runbook at `platform-ops/byot-catalog-refresh`",
      "`WorkspaceCredentials` discriminated union + `ByotAdapter<Cred>` parameterized dispatch — Bedrock joins the same typed adapter table as Anthropic and OpenAI; folds the S25 + S26 BYOT review threads into one PR",
      "Branded `encryptSecret` return types — `URLSecret` and `OpaqueSecret` brands enforce the picking guide at compile time. (The deprecated `encryptUrl` / `decryptUrl` re-exports forecast for retirement at 1.5.0 actually retired in 1.5.3 / #2819 once the `connections` table drop landed.)",
      "`@useatlas/sdk@0.0.14` multi-workspace MCP shape — `completeConnect` surfaces the plural `workspace_ids` claim, `buildConfig` opts into a multi-workspace env-hint block, `useMcpConnect` exposes a `workspaces` array for picker UX",
      "AWS Bedrock BYOT IAM + region guide — minimum IAM policy snippet, model availability per region, and the key rotation flow at `integrations/llm-providers/bedrock`",
      "Direct-provider BYOT model picker docs — Anthropic + OpenAI + Bedrock searchable picker over the live provider catalog with the L1 + Postgres L2 cache story at `guides/model-routing`",
      "`useSession()` widened for `session.fields` extras — closes the #2262 `authClient`-cast-collapse arc; four callsites lose their local `as { activeOrganizationId?; activeOrganizationName? }` narrows",
    ],
    githubMilestone: 44,
  },
  {
    version: "1.4.2",
    title: "End-user shakeout",
    date: "2026-05-12",
    summary:
      "Polish pass from dogfooding Atlas as an end-user. Chat-first front door for non-admins (root `/` lands on the agent, not the admin console), per-user default-landing preference for admins who live in `/admin`. Platform-admin chrome lifted to top-level `/platform/*` so URL prefix mirrors role scope. BYOT now supports direct Anthropic / OpenAI / Bedrock keys with provider-side model discovery and a Postgres L2 catalog cache. New `/settings/profile` self-serve page covers name + password + MFA + sessions. Dev mode gets a LaunchDarkly-style pending-changes pill so draft work is visible. Numbers: 42 issues across admin chrome, BYOT, profile, multi-tenant correctness, platform-admin polish, and a long bug pass.",
    highlights: [
      "Chat-first front door — root `/` lands non-admins on the agent; admins pick a per-user default landing (chat / notebook / dashboards / admin) in Settings → Profile",
      "Unified left rail across `/`, `/notebook`, `/dashboards` — shadcn Sidebar shell parity with `/admin` so every surface picks up the same nav primitives",
      "BYOT direct-provider discovery — Anthropic + OpenAI + Bedrock keys now get a searchable model picker over the live provider catalog (`/v1/models` + `ListFoundationModels`), backed by a per-orgId L1 + Postgres L2 cache and graceful unknown-model handling",
      "Vercel AI Gateway model catalog picker — searchable picker with provider/capability filters surfaces the full gateway catalog instead of free-form model input",
      "Platform admin nav lift — `/admin/platform/*` + `/admin/organizations` + `/admin/abuse` promoted to top-level `/platform/*` so the URL prefix mirrors role scope; `/admin/users` split into workspace + `/platform/users`",
      "`/settings/profile` — name + password + MFA + sessions in one self-serve page (B2B-safe; org-owned email stays read-only); reached from the avatar menu in both chat and admin chrome",
      "Persistent admin top bar — workspace breadcrumb + avatar menu carries across every admin page",
      "Dev-mode discoverability — LaunchDarkly-style PendingChangesPill counts staged drafts across content tables; admin mutations always write drafts so Publish stays the canonical promote-to-live step",
      "`__demo__` collapsed to one global row — onboarding INSERTs at `org_id='__global__'` with ON CONFLICT DO NOTHING; per-org archived tombstone shadows the global without mutating shared state",
      "Shared primitives extracted — `<MfaPanel>` shared between `/admin/account-security` and `/settings/profile`, `AdminBreadcrumb` discriminated union, canonical shadcn DatePicker / DateRangePicker across every admin date selector",
      "Boot + CI hardening — Boot Smoke path-gated to scaffold-relevant changes (doc-only PRs skip the 4-min job), `ci` lint/type/test/syncpack/template-drift fan out as parallel jobs, real-Postgres migration smoke catches SQL planning errors that mock-pool tests miss, full Dockerfile + SaaS env boot smoke with `/api/health` probe",
    ],
    githubMilestone: 42,
  },
  {
    version: "1.4.1",
    title: "MCP: Bringing It All Together",
    date: "2026-05-09",
    summary:
      "Round-out release for 1.4.0 — closes the genuine gaps from the agent-first launch. Per-user MCP onboarding lives in Settings → AI Agents (no CLI required). Per-OAuth-client rate limits, surface-scoped approval rules, and cross-workspace agent identity round out the governance surface for hard-charging or multi-workspace agents. Hosted MCP performance is now measured (not guessed) — reproducible k6 scripts and a CI runner mean future regressions get caught. The MCP plugin SDK lets first-party plugins ship custom tools that agents see alongside the typed semantic-layer tools, and the @useatlas/sdk MCP onboarding helper makes embedded \"connect your agent\" flows a 5-line addition. Numbers: 34 issues, 5 themes plus a 9-item closeout sweep.",
    highlights: [
      "Settings → AI Agents — per-user MCP connect + manage flow with a 3-step wizard, refresh-token state surfacing, audit-log filter for `actorKind=mcp`/`clientId`/`tool`, and a live MCP usage chip; non-CLI users can install + manage MCP without touching atlas.config.ts",
      "`mcp.useatlas.dev` — first-class brand hostname for MCP traffic, advertised in OAuth audiences and protected-resource metadata; CLI default points here; cross-region `421 Misdirected Request` body returns the brand URL",
      "Per-OAuth-client rate limiting — sliding-window limiter scoped to `(workspaceId, clientId)` with per-tool weighting (`executeSQL`/`explore` 5×); admin overrides via dedicated table; structured 429 envelope + `mcp.rate_limited` audit",
      "Surface-scoped approval rules — approval rules can target `chat`, `mcp`, `scheduler`, `slack`, `teams`, `webhook`, or `any`; admin UI gains a surface dropdown; an unstamped route only matches `'any'` rules so the gate stays active even on transports that haven't been wired in",
      "Cross-workspace agent identity — one OAuth flow + one client config serves multi-workspace users; per-request scoping via `X-Atlas-Workspace`; live DB membership lookup so workspace-leave revokes MCP access immediately rather than waiting for token refresh",
      "Measured hosted MCP performance — `apps/docs/content/shared/architecture/mcp-performance.mdx` documents cold-start, concurrent-session ladder, realistic-mix latencies, bottleneck order, and tuning recipes; `eval/load-tests/mcp/` k6 scripts reproduce the numbers against any deployment; `.github/workflows/load-test-mcp.yml` runs them on demand and writes a markdown summary to the workflow run",
      "MCP-path eval harness — every canonical question dispatched through the real `createHostedMcpRouter()` over real OAuth 2.1 + JWT (no auth mock), graded by both deterministic and LLM modes; `description-rubric.test.ts` keeps tool descriptions on a fixed rubric so agents see consistent guidance",
      "Plugin SDK MCP-tools extension point — `AtlasPlugin.mcpTools()` lets plugins ship their own tools that the host registers as `<plugin-id>.<name>`; the same description rubric applies; reference implementation in `plugins/yaml-context/`; foundation for future context-provider plugins",
      "`@useatlas/sdk/mcp` programmatic onboarding — `atlas.mcp.beginConnect` / `completeConnect` / `buildConfig` / `listAgents` / `revokeAgent` for embedding \"connect your agent\" in your own product; `useMcpConnect` hook in `@useatlas/react` wraps the popup-or-redirect lifecycle",
      "Canonical eval prompts surfaced via `prompts/list` — 20 NovaMart questions exposed as `canonical-{slug}` MCP prompts, gated by `ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS` (`auto` / `always` / `never`); Settings → AI Agents preview block shares the listing pipeline with the wire so visible-prompt sets stay in lockstep",
    ],
    githubMilestone: 41,
  },
  {
    version: "1.4.0",
    title: "MCP & Agent-First DX",
    date: "2026-05-05",
    summary:
      "The agent-first install and discovery surface is closed end-to-end. Any MCP client can install Atlas in one command and connect to the hosted endpoint over standards-compliant OAuth 2.1 (Dynamic Client Registration + PKCE), or pair the bundled NovaMart fixture with a local install for zero-config self-hosted use. Typed semantic-layer tools (listEntities, describeEntity, searchGlossary, runMetric) and a structured error envelope let agents recover from ambiguity, validation failures, or rate limits without blind retries. Atlas is now listed on the official MCP Registry — agents discovering software through the registry find it the same way they find Postgres or GitHub.",
    highlights: [
      "One-command MCP install — `bunx @useatlas/mcp init --local` (zero-config local with bundled NovaMart fixture) or `--hosted --write` (browser-based OAuth 2.1 loopback against Atlas SaaS, same shape as `gh auth login`)",
      "Hosted MCP endpoint per-region (us/eu/apac) — Dynamic Client Registration, PKCE, JWT access tokens, RFC 9728 protected-resource metadata, `421 Misdirected Request` enforced for cross-region requests so the residency promise holds for MCP traffic",
      "Admin Settings → OAuth Clients — list registered clients with last-use + outstanding-token counts, revoke a client and every token it issued in one click",
      "Typed semantic-layer MCP tools — `listEntities`, `describeEntity`, `searchGlossary`, `runMetric` so agents can call the YAML format programmatically instead of scraping it",
      "Structured `AtlasMcpToolError` envelope with closed code catalog (`validation_failed`, `ambiguous_term`, `rls_denied`, `query_timeout`, `unknown_entity`, `unknown_metric`, `rate_limited`, `internal_error`) — each tool's MCP description ends with an explicit `Error contract:` line so agents discover recovery paths from the tool itself",
      "OTel coverage for MCP — activation + tool-call distribution + latency counters land in the existing observability stack",
      "Listed on `registry.modelcontextprotocol.io` as `io.github.AtlasDevHQ/atlas`, auto-published via OIDC on every `mcp-v*` tag",
      "Eval harness with 20 canonical questions under `eval/canonical-questions/` — deterministic semantic-layer reads + LLM mode for the full agent loop, CI-gated on release tags",
      "NovaMart canonical demo seed — three seeds collapsed to one e-commerce dataset; landing, docs, scaffolder, and eval harness all share the same example questions",
    ],
    githubMilestone: 40,
  },
  {
    version: "1.1 – 1.2",
    title: "Post-launch refinement",
    date: "2026-04-17",
    summary:
      "Three milestones shaping how users meet the product and how teams govern what their workspace shows. Notebooks bridge exploratory chat and persistent dashboards, developer mode lets admins stage changes before rolling them out, and the hardcoded starter-prompts grid becomes an adaptive surface composed from per-user favorites, admin-moderated popular queries, and demo-industry fallback.",
    highlights: [
      "Notebooks — convert chat to persistent notebook, fork cells with \"What if?\", dashboard bridge, report route, execution metadata",
      "Developer / published mode — stage draft changes across connections, semantic entities, prompt collections, and starter prompts; atomic publish; pending-changes banner",
      "Adaptive starter prompts — pin your own questions, admin-moderated popular queries, demo-industry fallback; replaces hardcoded grid",
      "Available everywhere — chat empty state, notebook new-cell empty state, @useatlas/react widget, @useatlas/sdk getStarterPrompts()",
      "Onboarding demo identity — new workspaces start on a __demo__ connection, switch to developer mode to connect real data without exposing partial state",
    ],
  },
  {
    version: "1.0.0",
    title: "SaaS Launch",
    date: "2026-04-03",
    summary:
      "Public launch of hosted Atlas at app.useatlas.dev. Pricing, SLA commitments, legal pages, migration tooling for self-hosted to SaaS, hosted user documentation, and status page with incident management.",
    highlights: [
      "3-region deployment (US, EU, APAC) with misrouting detection",
      "SLA page with uptime guarantees, latency targets, and support tiers",
      "Migration tooling — atlas export/import for self-hosted to SaaS",
      "OpenStatus integration for incident management",
    ],
    githubMilestone: 24,
  },
  {
    version: "0.9",
    title: "SaaS Platform",
    summary:
      "Everything needed to run Atlas as a hosted product. Self-serve signup, Stripe billing, SSO/SCIM, PII detection, Chat SDK with 8 platform adapters, plugin marketplace, semantic layer web editor, OAuth connect flows, and 3-region deployment.",
    highlights: [
      "Self-serve signup with guided semantic layer wizard",
      "Enterprise auth — SSO (SAML/OIDC), SCIM, custom roles, IP allowlists, approval workflows",
      "Chat SDK — Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp",
      "Plugin marketplace — browse, install, configure per workspace",
      "Semantic layer web editor with autocomplete and version history",
      "Data residency — 3 regions (US, EU, APAC) with cross-region migration",
      "Effect.ts architecture — typed errors, composable Layers, @effect/ai agent loop",
    ],
  },
  {
    version: "0.8",
    title: "Intelligence & Learning",
    summary:
      "Dynamic learning layer that gets smarter over time. Agent proposes learned patterns from successful queries, admin reviews and approves. Notebook-style interface with fork/branch, drag-and-drop reorder, markdown cells, and export. Curated prompt library and query suggestions.",
  },
  {
    version: "0.6–0.7",
    title: "Enterprise & Scale",
    summary:
      "Governance primitives and multi-tenant architecture. Row-level security with multi-column policies, session management, audit logging with CSV export, Microsoft Teams and webhook integrations. Multi-tenancy via Better Auth org plugin with tenant-scoped pooling, caching, and semantic layers.",
    highlights: [
      "Row-level security — multi-column, array claims, OR-logic policies",
      "Multi-tenancy — org-scoped connections, pools, cache, semantic layers",
      "Query result caching with configurable TTL and admin flush",
      "Streaming Python execution with sandboxed chart rendering",
    ],
  },
  {
    version: "0.3–0.5",
    title: "Core Product",
    summary:
      "Admin console with connection management, query analytics, and observability. Chat UI with theming, follow-ups, Excel export, and mobile support. Embeddable widget, TypeScript SDK with streaming, conversation sharing, and BigQuery plugin.",
    highlights: [
      "Admin console — connections, users, plugins, analytics, health checks",
      "Chat experience — dark/light mode, saved queries, schema explorer, charts",
      "Embeddable widget — @useatlas/react, script tag loader, SDK streaming",
      "119 docs pages audited for agent and human consumption",
    ],
  },
  {
    version: "0.1–0.2",
    title: "Foundation",
    summary:
      "Open-source release with plugin ecosystem. Docs site, CLI tooling, 18 official plugins on npm, Plugin SDK with scaffolding and testing utilities. Datasource plugins for PostgreSQL, MySQL, BigQuery, ClickHouse, Snowflake, DuckDB, and Salesforce.",
  },
];
