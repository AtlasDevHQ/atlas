# CLAUDE.md

**Atlas** — deploy-anywhere text-to-SQL data analyst agent. Hono + Next.js + TypeScript + Effect.ts + Vercel AI SDK + bun.

Subsystem guidance lives in `.claude/rules/`, which loads automatically when you read a matching file. This file holds only what's true regardless of what you're touching.

## ⚠️ Always

These hold everywhere. The rest of this file is orientation, not rules.

### Error handling
- **Never silently swallow errors** — every `catch` must log (`log.warn`/`console.debug`) or re-throw. Empty `catch {}` forbidden. If intentional: `// intentionally ignored: <reason>`
  - **The marker means SILENCE, not "something was discarded".** It is the exemption for a catch that emits no signal at all — `res.text().catch(() => "")` reading the body of an already-failed response. A catch that logs does **not** take the marker, even when it deliberately drops the error object (e.g. because the message would echo a secret); explain that in a plain comment instead. Both readings were live in-repo until 2026-08-02 — `zoom/connector.ts` marked a catch that logs, while `zoom/api.ts` and `outlook/api.ts` explicitly declined to on the same shape — and a marker that means two things is worth nothing on the one that matters
- **Type-narrow caught errors** — always `err instanceof Error ? err.message : String(err)`. Never access `.message` unguarded
- **Request IDs on all 500s** — every 500 response includes `requestId` for log correlation
- **No generic error messages** — replace "Something went wrong" with actionable, context-specific messages + retry guidance
- **Prefer errors over silent fallbacks** — `catch { return false }` on a security check is a bug. Return 500, not a false negative

### Types and style
- **No explicit `any`** — proper types, or `unknown` with narrowing. `any` only where unavoidable (third-party) with `oxlint-disable` + justification
- **Minimize non-null assertions** — only `!` when provably non-null. Prefer `?.` or explicit null checks
- **bun only** — package manager and runtime. Never npm, yarn, or node
- **TypeScript strict mode** — path aliases: `@atlas/api/*` cross-package, `@/*` → `./src/*` within web only
- **No async waterfalls** — `Promise.all([a(), b()])` for independent awaits
- **`lib/` must not import from `api/routes/`** — the data/helper layer (`src/lib/**`) stays above the Hono route layer (`src/api/**`). Inverted imports pull auth/logger/middleware into every `lib/` consumer and break partial `mock.module()` mocks. Convention-only — no lint rule enforces it, so watch for it in review
- **Server external packages** — `pg`, `mysql2`, `@clickhouse/client`, `@duckdb/node-api`, `snowflake-sdk`, `jsforce`, `just-bash`, `nodemailer`, `pino`, `pino-pretty`, `stripe` must stay in `serverExternalPackages` in the `create-atlas` template
- **oxlint, not ESLint** — `.oxlintrc.json`. Type-aware linting is a separate CI-blocking gate (`bun run lint:type-aware`). The ~200 remaining `warn` rules are permanent non-targets — don't try to clear them (ADR-0031)

### Product invariants
- **SQL is SELECT-only, single-statement, whitelist-scoped** — validation blocks all DML/DDL, `;` chaining, and non-whitelisted tables. Unparseable queries are **rejected**, never skipped. Full pipeline: `.claude/rules/api-sql-security.md`
- **No secrets in responses** — never expose connection strings, API keys, or stack traces to the user or agent
- **Readonly DB connections** — PostgreSQL via validation; MySQL via read-only session variable; ClickHouse via `readonly: 1`

### Tests
- **`bun run test`, never bare `bun test`** — isolated per-file runner. Single file OK: `bun test path/to/file.test.ts`
- **Remote CI on the PR is the gate, not a local `/ci`** — push, open the PR as a **draft**, and let `ci.yml` run (~4 min, parallel) while you review. The local pre-flight is the cheap subset: `cd packages/api && bun run scripts/test-isolated.ts --affected`, plus `bun run lint`, `bun run type` and `bun run lint:type-aware`. **`lint:type-aware` is on that list because it is its own CI-blocking job and costs ~11s** — leaving it off is what let a single type-aware diagnostic red-flag two CI jobs on #5083 *after* the pre-flight came back clean. Run the full `scripts/ci-local.sh` (38 gates, ~25 min, serial, rewrites source in place for the mutation gate) only when remote CI is broken, when you reshaped something `mutation-tables` anchors on, or before tagging a release

### Merge discipline
Rationale + override rules: [docs/development/branch-protection.md](docs/development/branch-protection.md). These are workflow rules — no file-read triggers them, so they stay here:

- **NEVER merge a fork PR** — head repo ≠ `AtlasDevHQ/atlas` (`isCrossRepository: true`) is an external contributor's code. An agent must never merge one, not even fully green. Needs in-session human confirmation **and** a recorded security diff review; the `external-approved` label applied by hand **is** the sign-off. Surface provenance first: `gh pr view <PR> --json headRepositoryOwner,author,isCrossRepository,reviews`. See #3772
  - `fork-pr-gate` is a **required status check**, so red genuinely blocks the merge button. It was missing from the live config until 2026-07-26 — for that window the backstop was policy only, since a red *non-required* check blocks nothing. If you ever need to know whether it's still enforced, don't trust this line: `gh api repos/AtlasDevHQ/atlas/branches/main/protection --jq '.required_status_checks.contexts'`
- **`--admin` is for a broken gate, not a slow one** — merge only after `gh pr checks <PR> --watch` is green on the head SHA. "Tests are slow" doesn't qualify (#2206). **A check that *structurally cannot run* on a class of PR is a stop sign, not an override invitation** — CodeQL never runs on fork PRs and `fork-pr-gate` is red by design. Admin-merging past a missing-by-design gate is forbidden for agents (#3772)
- **Never target `prod` with a PR** — it's a Railway-tracking artifact, advanced only by the release flow in [release-process.md](docs/development/release-process.md)
- **Check `git rev-list --count origin/prod..origin/main` before any hotfix** — the documented hotfix flow assumes `main` ≈ prod + your fix. When an unreleased arc sits on `main` (a held minor tag), tagging from `main` ships it. Branch from the tag `prod` is on instead; `/release` refuses off-`main`, so the lane is manual and CI needs a `workflow_dispatch` to reach the hotfix SHA. Full lane: [release-process.md § When `main` is NOT a safe hotfix source](docs/development/release-process.md#when-main-is-not-a-safe-hotfix-source)
- **`milestone/**` is the one integration-branch exception** — but branch protection is `main`-only, so **nothing blocks a bad merge into a milestone branch**; green checks there are discipline, not enforcement. CodeQL is deferred to the milestone→`main` PR — deferred, not waived
- **Required reviews are intentionally off** — solo dev + parallel-claude workflow. Don't enable without rethinking the model

### Destructive commands
- **`ops wipe` TRUNCATEs every public table and takes no backup** — double-gated by `ATLAS_WIPE_OK=1` **and** `--confirm`. Wrap with `pg_dump` yourself
- **`ops teardown-verify-accounts` targets a region's internal DB, not the tenant DB** — no `DATABASE_URL` fallback by design; DRY RUN unless `ATLAS_TEARDOWN_OK=1` + `--confirm`
- Both live in the `atlas-operator` binary, split out of the published `atlas` CLI (ADR-0025 step 4, #4045). Details: the **`operator-commands`** skill

### Publishing
- **Never push more than 3 release tags in one `git push`** — GitHub fires NO `push` event for tags when >3 land in a single push, so `publish.yml` runs for none of them: the tags land on the remote and nothing publishes, silently. Groups of ≤3. (Caught 2026-06-15 backfilling 6 tags — published nothing)
- **Sequence ref bumps AFTER the publish lands** — for `0.0.x`, `^0.0.2` pins exactly to `0.0.2`, so bumping refs first makes Deploy Validation scaffolds fail on `npm install`. Full sequence: the **`publish-package`** skill
- **Never edit `create-atlas/templates/nextjs-standalone/src/`** — gitignored, regenerated by `prepare-templates.sh`; `scripts/check-template-drift.sh` gates it

## Rules index

`.claude/rules/*.md` load automatically when you **read** a matching file. That trigger is a read, so when you're **creating** a file in one of these areas — a new migration, a new tool, a new entity — open the rule first.

| Working on | Rule file |
|---|---|
| SQL validation, execution, whitelist | `api-sql-security.md` |
| Credentials, encryption, sandbox isolation | `api-security-general.md` |
| Migrations, Drizzle schema, connections | `api-database.md` |
| Effect services, Tags, Layers, `runHandler` | `api-effect.md` |
| Agent tools, the tool registry, the agent loop | `api-agent-tools.md` |
| Entity YAML, metrics, glossary | `semantic-layer.md` |
| Draft/published content tables | `content-mode.md` |
| `/ee`, deploy mode, settings registry | `enterprise-gating.md` |
| React, Tailwind, shadcn, nuqs, zustand, admin pages | `web-frontend.md` |
| Any `*.test.ts` | `testing.md` |
| Plugins, chat adapters, the `@useatlas/chat` boundary | `plugins-chat-contract.md` |

Where a rule names a `scripts/check-*.sh` guard, that guard is the enforcement — the rule exists so you don't waste a cycle discovering it in CI.

## Orientation

The product surface, each subsystem's design in its ADR: web chat + embeddable React widget + eight chat-platform adapters (Slack live); **dashboards** with draft-first, publish-gated editing ([ADR-0029](docs/adr/0029-dashboards-draft-first-editing.md)); the **Knowledge Base pillar** ([ADR-0028](docs/adr/0028-knowledge-base-fourth-pillar.md)); an OAuth 2.1 **MCP server** with self-serve `start_trial` ([ADR-0016](docs/adr/0016-mcp-v2-security-model.md), [ADR-0018](docs/adr/0018-self-serve-trial-over-mcp.md)); **durable agent sessions** ([ADR-0020](docs/adr/0020-durable-agent-sessions.md)); per-conversation **answer styles** (`lib/answer-styles.ts`); **cross-group reach** ([ADR-0022](docs/adr/0022-cross-group-reach-llm-composition.md)); and 3-region SaaS **residency** where the process is the region ([ADR-0024](docs/adr/0024-regional-identity-isolation.md)).

**The Company Atlas is what `brain_*` stores.** [ADR-0038](docs/adr/0038-the-atlas-is-the-product-the-brain-is-the-category.md) renamed the product noun from *Company Brain*; the **category claim** *"the data-grounded company brain"* is unchanged. The rename is **product copy only** — `brain_facts`/`brain_edges`, `lib/brain/**`, `/admin/brain`, `ATLAS_BRAIN_*` and the `searchBrain` tool name all keep the old noun deliberately, so expect both vocabularies in the tree. Rule of thumb: **if a customer reads it, it says Atlas; if only we read it, it still says brain.** Its destination — what "finished" looks like, the eight finish conditions, and the eight things it will not do — is [docs/prd/company-atlas.md](docs/prd/company-atlas.md).

**Two databases:** analytics datasources (the customer's data, read-only, via `ConnectionRegistry`) and the internal DB (`DATABASE_URL` — auth, audit, settings, content mode, knowledge, sessions; optional self-hosted, required for SaaS).

### Packages

`ls packages/ apps/ examples/ plugins/` is the authoritative inventory; each `package.json` says what it is. Only the facts you can't read off disk:

- **Published to npm** (`@useatlas/*`, independent semver): `types`, `sdk`, `react`, `plugin-sdk`, `webhook-publisher`. Everything under `@atlas/*` is internal — including `oauth-helper`, which looks publishable but deliberately isn't
- **`@useatlas/schemas` is the exception** — public scope, but internal-only; it never publishes to npm
- **`ee/`** is `@atlas/ee`: source-available under a commercial license, not AGPL
- **Import conventions** — `@atlas/api` uses its own name (`@atlas/api/lib/agent`); `@atlas/web` uses the `@/*` tsconfig alias; the frontend never imports from `@atlas/api`, it speaks HTTP

### `lib/` subsystem map (packages/api/src/lib/)

Beyond `effect/`, `db/`, `semantic/`, `tools/`: `billing/` (Stripe subscriptions, entitlements, overage metering) · `integrations/install/` (OAuth + form-install spine; `persistSingletonInstall` is the single workspace-install write path) · `knowledge/` (KB pillar; `ingest-bundle.ts` is the one ingest seam) · `dashboards*.ts` (draft-first dashboards) · `durable-session.ts` / `durable-state.ts` / `agent-compaction.ts` (ADR-0020) · `residency/` (region routing) · `content-mode/` (draft/published) · `settings.ts` (runtime settings registry) · `mcp/` (MCP spine + `auth.md` discovery) · `scheduler/` (periodic fibers via `registerPeriodicFiber`) · `learn/` (learned query patterns) · `proactive/` (proactive chat, enterprise-gated) · `group-reach/` + `source-catalog/` (cross-group reach, ADR-0022) · `answer-styles.ts` (voice registry) · `tools/backends/` (sandbox selection).

### Versioning

Three independent version trains that **never coordinate** — git tags, GitHub milestones, per-package npm semver. Rules and release flow: [ADR-0008](docs/adr/0008-versioning-and-release-tags.md) + [release-process.md](docs/development/release-process.md); milestone naming: [ADR-0009](docs/adr/0009-tag-organized-roadmap.md).

- The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is **not** the future git tag `v1.0.0` — say "internal milestone 1.0.0". `v1.0.0` is reserved for when REST + MCP + plugin SDK contracts freeze
- The docs changelog is a **per-tag feed**, not banked for `v0.1.0`. It is written as part of tagging — [release-process.md](docs/development/release-process.md)
- **New integration?** Create the staging app/credentials first — staging is the soak environment. Don't OAuth-register a new platform straight against prod

## Commands

Run `bun run` for the script list — `dev`, `build`, `lint`, `type`, `test*`, `db:*` do what their names say. The non-obvious ones:

```bash
# Fast local feedback loop — only tests whose source graph your branch touched:
cd packages/api && bun run scripts/test-isolated.ts --affected
cd packages/api && bun run scripts/test-isolated.ts --since HEAD~3     # last 3 commits
bun run atlas -- init    # Profile DB, generate semantic layer
bun run atlas -- diff    # Compare DB schema vs semantic layer
```

**Quick start:** `bun install` → `cp .env.example .env` → `bun run db:up` → `bun run atlas -- init` → `bun run dev`. Dev admin: **admin@useatlas.dev / atlas-dev**.

> **Local dev runs either deploy mode; `self-hosted` is the trivial default.** `.env` ships `ATLAS_DEPLOY_MODE=self-hosted` + `ATLAS_DEPLOY_ENV=development`. With `development` set, even an unset/`auto` deploy mode resolves to `self-hosted`. To dev against the SaaS code path set `ATLAS_DEPLOY_MODE=saas`: in `development` the SaaS fail-closed boot guards **relax to a no-op** (`relaxSaasGuardForDev`) so it boots without prod-only secrets — an **intentional local-dev footgun gated solely on `development`; never set `ATLAS_DEPLOY_ENV=development` on a customer-facing deploy.** Deploy vars belong in `.env`, not the `bun run dev` command line (the wrapper subshell drops them). Runbook: [docs/development/local-development.md](docs/development/local-development.md).

Env vars: see `.env.example`. Key ones — `ATLAS_PROVIDER`, `ATLAS_MODEL`, `ATLAS_DATASOURCE_URL`, `DATABASE_URL`, `ATLAS_AUTH_MODE`, `BETTER_AUTH_SECRET`.

## Agent skills

> Heading kept as `## Agent skills` deliberately: `/setup-matt-pocock-skills` finds and
> updates this block **by that exact heading**. Rename it and the next re-run appends a
> second copy instead of updating this one.

**The workflow layer was deleted on 2026-08-17** — 26 of 34 commands, all 5 review agents
and `docs/agents/`, ~6,250 lines. It was not wrong; it was satisfied nominally, three
escalations deep, while the defect moved up a level each time. What remains in
`.claude/commands/` is eight **operational** runbooks (`release`, `publish`, `deploy`,
`ci`, `verify-mcp-cli`, `verify-prod-signup`, `dev`, `deps-update`) — sequences against
external systems that fail loudly, which no finding implicated.
The replacement is one page: **[docs/agents/practices.md](docs/agents/practices.md)** — the
bar a practice must clear (a gate, or a measurement that can fail, or it is a note in
ROADMAP), and the one structural rule (the actor that builds a check may not be its only
judge). Read it before adding any process.

- **Engineering skills** come from the upstream plugin: `claude plugin install mattpocock-skills`
  (`/to-spec`, `/to-tickets`, `/triage`, `/grill-with-docs`, `/wayfinder`, `/tdd`, …).
  A fresh checkout carries none of them. `/setup-matt-pocock-skills` regenerates this repo's
  tracker, triage-label and domain-doc conventions from the maintained upstream — that is the
  path back, not a hand-written replacement, because a hand-written one rots unwatched
### Issue tracker

GitHub issues in `AtlasDevHQ/atlas` via `gh`, always with an explicit `-R AtlasDevHQ/atlas`.
Bodies follow the Atlas format (`## Key files / ## Acceptance criteria / ## Dependencies`),
which tooling parses. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical roles, each label string equal to its name — verified present in the repo.
They are one of **two** required axes; the other is kind+area. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

**Multi-context**: [`CONTEXT-MAP.md`](CONTEXT-MAP.md) names 18 bounded contexts and
`docs/adr/` holds 41 system-wide decisions. ⚠️ The layout is adopted but the split is not
done — the root `CONTEXT.md` still governs every context, and the map says so per row rather
than pointing at files that do not exist (#5302). See
[`docs/agents/domain.md`](docs/agents/domain.md).

### The record

`.claude/research/ROADMAP.md` is where measured findings live, and it survived the deletion
deliberately. The commands were a lossy copy of it.
