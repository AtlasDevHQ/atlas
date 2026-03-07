# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Atlas uses internal milestones (v0.1–v1.0+) to track architectural progress.
Public semver releases will start fresh when the API stabilizes — see
[CLAUDE.md](./CLAUDE.md#versioning--release-strategy) for details.

## [Unreleased]

### Added

- `atlas doctor` CLI command — validate environment, connectivity, and configuration ([#68](https://github.com/AtlasDevHQ/atlas/pull/68))
- Actionable first-run error messages with provider signup URLs and masked connection strings ([#69](https://github.com/AtlasDevHQ/atlas/pull/69))
- CHANGELOG.md, CONTRIBUTING.md, and GitHub issue/PR templates ([#67](https://github.com/AtlasDevHQ/atlas/pull/67))
- Docs site scaffolded with Fumadocs — 13 MDX pages, Orama search, Railway deploy config ([#72](https://github.com/AtlasDevHQ/atlas/pull/72))
- `atlas validate` CLI command — offline config and semantic layer YAML validation ([#71](https://github.com/AtlasDevHQ/atlas/pull/71))
- SDK integration tests — 41 tests against mock Hono server covering full `@useatlas/sdk` API surface ([#70](https://github.com/AtlasDevHQ/atlas/pull/70))

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
