# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Atlas uses internal milestones (v0.1–v1.0+) to track architectural progress.
Public semver releases will start fresh when the API stabilizes — see
[CLAUDE.md](./CLAUDE.md#versioning--release-strategy) for details.

## [Unreleased]

### Security

- **1.2.4 — Security Cleanup Tail (2026-04-25):** four fixes carried over from the 1.2.3 audit. F-53 — `checkPermission()` from `@atlas/ee/auth/roles` now runs at every admin route boundary; custom roles authored without admin flags can no longer reach role/user/audit/connections/settings/semantic surfaces (closes #1849, PR #1878). F-56 + F-59 — SSO enforcement runs against `byot`-mode JWTs whose email domain matches an enforced provider (was skipped); audit-row failures fail closed instead of swallowing the error; three new test cases lock the `simple-key` / `byot` / managed-API-key SSO branches (closes #1852, PR #1877). MCP actor binding — the MCP transport binds the resolved actor at server boot rather than per-request (mirrors the F-54/F-55 scheduler hardening), preventing actor confusion when concurrent requests interleave (closes #1858, PRs #1879/#1880). F-57 — admin user-mutation routes (changeRole / ban / removeMembership / delete / revokeSessions / assignRole) now consult SCIM provenance against `account ↔ scimProvider`. New workspace setting `ATLAS_SCIM_OVERRIDE_POLICY` (`strict` default | `override`) decides: strict returns 409 `code: SCIM_MANAGED` so the IdP stays canonical; override proceeds and stamps `metadata.scim_override = true` on the existing audit row. ban + delete are global mutations and scan all SCIM providers (orgId: undefined); the other handlers scope to the active workspace. Helper fails closed: EE off / no internal DB / `42P01 scimProvider does not exist` treat as non-SCIM, but a genuine query error propagates as 500 (closes #1853, PR #1881).
- F-41 plaintext-column drop: dropped the plaintext credential columns from all 10 workspace integration tables (`slack_installations.bot_token`, `teams_installations.app_password`, `discord_installations.bot_token`, `telegram_installations.bot_token`, `gchat_installations.credentials_json`, `github_installations.access_token`, `linear_installations.api_key`, `whatsapp_installations.access_token`, `email_installations.config`, `sandbox_credentials.credentials`). Reads now decrypt `<col>_encrypted` directly; the back-compat fall-through in each integration store and `pickDecryptedSecret` / the email/sandbox `pickEncryptedConfig` helpers are deleted. `backfill-integration-credentials.ts` is removed (one-shot tool, never runs again). Operator pre-flight checks against US/EU/APAC must report zero residue rows before applying migration `0040_drop_integration_plaintext.sql` — see `apps/docs/content/docs/platform-ops/plugin-config-residue-audit.mdx`. Closes #1832
- F-42 plaintext-residue audit + strict mode: new read-only `bun run packages/api/scripts/audit-plugin-config-residue.ts` walks every encrypted column and every `secret: true` field in `plugin_settings.config` / `workspace_plugins.config` and exits `2` with row IDs (no values) when residue is found. New `ATLAS_STRICT_PLUGIN_SECRETS=true` env var rejects plugin admin writes whose catalog schema is corrupt or carries per-key secret-vs-passthrough drift, returning `422 Unprocessable Entity` with an actionable message. Default off preserves the existing tolerant passthrough; SaaS regions opt in. Closes #1835

### Breaking

- The plaintext credential columns listed above are gone. Any downstream tooling that read directly from those columns (custom backups, reporting queries, ad-hoc admin scripts) must migrate to read `<col>_encrypted` and decrypt via `decryptSecret` from `@atlas/api/lib/db/secret-encryption`. The encrypted-only shape was the dual-write contract since 2026-04-24, so the change is a column drop, not a semantic break for callers using `getInstallation*` helpers.

## 0.2.0 — Plugin Ecosystem (2026-03-10)

### Added

- Plugin scaffold CLI — `bun create @useatlas/plugin my-plugin` generates a complete plugin with tests, README, and `atlas.config.ts` wiring ([#140](https://github.com/AtlasDevHQ/atlas/pull/140))
- Plugin schema migrations — plugins can declare SQL migrations that run at startup against the internal database ([#141](https://github.com/AtlasDevHQ/atlas/pull/141))
- Multi-type plugin support — single plugin factory can provide multiple types (e.g., datasource + interaction + action) ([#122](https://github.com/AtlasDevHQ/atlas/pull/122))
- Plugin testing utilities in SDK — `createMockContext()`, `createMockConnection()`, lifecycle test helpers ([#119](https://github.com/AtlasDevHQ/atlas/pull/119))
- Interactive plugin directory page on docs site with type filtering ([#126](https://github.com/AtlasDevHQ/atlas/pull/126))
- Per-plugin docs pages for all 15 official plugins ([#123](https://github.com/AtlasDevHQ/atlas/pull/123))
- Plugin composition guide — ordering, priority, multi-plugin patterns ([#132](https://github.com/AtlasDevHQ/atlas/pull/132))
- Plugin cookbook — real-world patterns and recipes ([#127](https://github.com/AtlasDevHQ/atlas/pull/127))
- `wireSandboxPlugins()` helper for consistent sandbox wiring ([#138](https://github.com/AtlasDevHQ/atlas/pull/138))

### Changed

- Rename all plugins from `@atlas/plugin-*` to `@useatlas/*` scope ([#120](https://github.com/AtlasDevHQ/atlas/pull/120))
- Publish 18 packages to npm under `@useatlas` scope with OIDC trusted publisher
- Standardize `healthCheck()` across all 15 plugins — consistent error reporting, lazy peer dep loading ([#133](https://github.com/AtlasDevHQ/atlas/pull/133))
- Prepare all 15 plugins for npm publish — add `package.json` metadata, `files`, `exports`, `repository` ([#129](https://github.com/AtlasDevHQ/atlas/pull/129))

### Fixed

- Sandbox plugin error handling — consistent exec error propagation ([#137](https://github.com/AtlasDevHQ/atlas/pull/137))
- Bun `MODULE_NOT_FOUND` detection for lazy peer dep loading ([#134](https://github.com/AtlasDevHQ/atlas/pull/134))
- `tsgo` type errors in snowflake, vercel-sandbox, yaml-context plugins ([#139](https://github.com/AtlasDevHQ/atlas/issues/139))
- JIRA plugin test failures after multi-type migration ([#125](https://github.com/AtlasDevHQ/atlas/issues/125))
- Skip redundant plugin tests in publish workflow — CI already tests on every push ([c4dbea2](https://github.com/AtlasDevHQ/atlas/commit/c4dbea2))

## 0.1.0 — Documentation & DX (2026-03-08)

### Added

- `atlas doctor` CLI command — validate environment, connectivity, and configuration ([#68](https://github.com/AtlasDevHQ/atlas/pull/68))
- Actionable first-run error messages with provider signup URLs and masked connection strings ([#69](https://github.com/AtlasDevHQ/atlas/pull/69))
- CHANGELOG.md, CONTRIBUTING.md, and GitHub issue/PR templates ([#67](https://github.com/AtlasDevHQ/atlas/pull/67))
- Docs site scaffolded with Fumadocs — 13 MDX pages, Orama search, Railway deploy config ([#72](https://github.com/AtlasDevHQ/atlas/pull/72))
- `atlas validate` CLI command — offline config and semantic layer YAML validation ([#71](https://github.com/AtlasDevHQ/atlas/pull/71))
- SDK integration tests — 41 tests against mock Hono server covering full `@useatlas/sdk` API surface ([#70](https://github.com/AtlasDevHQ/atlas/pull/70))

## 0.0.x — Pre-release

### Added

- `executePython` tool with import guard and just-bash backend ([#46](https://github.com/AtlasDevHQ/atlas/pull/46))
- Wire executePython results into chat UI ([#48](https://github.com/AtlasDevHQ/atlas/pull/48))
- Python prompt tuning for agent system prompt ([#49](https://github.com/AtlasDevHQ/atlas/pull/49))
- nsjail Python sandbox backend ([#50](https://github.com/AtlasDevHQ/atlas/pull/50))
- Vercel sandbox Python backend ([#51](https://github.com/AtlasDevHQ/atlas/pull/51))
- Sandbox architecture design doc ([#55](https://github.com/AtlasDevHQ/atlas/pull/55))
- Platform-specific READMEs with deploy buttons for `create-atlas` ([#33](https://github.com/AtlasDevHQ/atlas/pull/33))
- CI workflow to automate starter repo sync ([#35](https://github.com/AtlasDevHQ/atlas/pull/35))
- `parserDialect` and `forbiddenPatterns` to datasource plugin SDK ([#23](https://github.com/AtlasDevHQ/atlas/pull/23))
- Plugin-driven dialect system for the agent ([#24](https://github.com/AtlasDevHQ/atlas/pull/24))
- Plugin-aware `validateSQL` and `ConnectionRegistry` ([#25](https://github.com/AtlasDevHQ/atlas/pull/25))
- ClickHouse datasource plugin with validation module ([#26](https://github.com/AtlasDevHQ/atlas/pull/26))
- Snowflake datasource plugin with validation module ([#27](https://github.com/AtlasDevHQ/atlas/pull/27))
- DuckDB datasource plugin ([#28](https://github.com/AtlasDevHQ/atlas/pull/28))
- Salesforce datasource plugin ([#31](https://github.com/AtlasDevHQ/atlas/pull/31))
- Admin user management and default password enforcement ([#1](https://github.com/AtlasDevHQ/atlas/pull/1))
- One-click Vercel deploy button with demo data support ([#3](https://github.com/AtlasDevHQ/atlas/pull/3))
- CI template drift check for `create-atlas` templates ([#9](https://github.com/AtlasDevHQ/atlas/pull/9))
- CI workflow to automate `atlas-starter` sync from monorepo ([#10](https://github.com/AtlasDevHQ/atlas/pull/10))

### Changed

- Replace just-bash Python backend with sidecar execution ([#47](https://github.com/AtlasDevHQ/atlas/pull/47))
- Drop Render as a deploy target ([#54](https://github.com/AtlasDevHQ/atlas/pull/54))
- Strip adapter code from core — plugins own their adapters ([#32](https://github.com/AtlasDevHQ/atlas/pull/32))

### Fixed

- Missing deps and files in starter templates ([#52](https://github.com/AtlasDevHQ/atlas/pull/52))
- Sync starters post adapter strip + add deploy buttons ([#36](https://github.com/AtlasDevHQ/atlas/pull/36))
- Resolve monorepo deps when generating starters from temp dir ([#37](https://github.com/AtlasDevHQ/atlas/pull/37))
- Install `create-atlas` deps separately in sync workflow ([#38](https://github.com/AtlasDevHQ/atlas/pull/38))
- Anchor statement-level forbidden patterns to avoid false positives ([#30](https://github.com/AtlasDevHQ/atlas/pull/30))
