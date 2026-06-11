# Handoff: #3374 sub-issue closeout (orchestrator)

You are the new ORCHESTRATOR for closing all 7 sub-issues of AtlasDevHQ/atlas#3374
(#3375, #3376, #3377, #3378, #3379, #3381, #3382). The previous session lost its
GitHub MCP connection mid-run; all implementation state lives on pushed branches.
Read #3374's body + summary comment, each sub-issue, the "Deploy-mode parity
contract" in `docs/development/enterprise-gating.md`, and CLAUDE.md before acting.
The drift audit is DONE — do not re-audit. Keep #3374 itself OPEN until all
children close (convention comment on it says so). Finish by commenting a status
table on #3374.

## Hard rules carried over

- One worktree+branch per slice off fresh `origin/main`; never two slices touching
  the same files concurrently; verify sub-agent claims yourself before opening a PR.
- Per-PR loop: implement+tests → `bun run test` (NEVER bare `bun test` on a
  directory; per-file isolation is load-bearing — two files in one process DO
  cross-pollute mocks) → open PR ("Closes #N", reference #3374) → /code-review the
  diff, fix real findings → subscribe_pr_activity → address every CodeRabbit
  comment → squash-merge only when all required checks green on HEAD SHA
  (`--admin` never) → close sub-issue if not auto-closed → pull main → next slice.
- Adjacent bugs: file a new issue (Atlas body format, bug + area labels, ref
  #3374), don't scope-creep the PR.
- OUT OF SCOPE: #3370 (BYOC credential consumption — own product decision; if
  forced, AskUserQuestion), #3368, everything on #3374's dropped-candidates list.
- Web tests run from `packages/web` (its bunfig.toml provides the `@/` alias).
- `@useatlas/types` is template-pinned (publish-before-ref-bump hazard);
  `@useatlas/schemas` is NOT pinned in `create-atlas/templates/*/package.json`,
  so new value exports there are safe. `create-atlas/templates/*/src/` is
  gitignored/generated — never treat its staleness as a finding.

## Decisions already made (do not re-litigate)

1. **#3376 semantics (user chose via AskUserQuestion): split flag.** Add a
   `saasWritable` axis to the settings registry, defaulting to the `saasVisible`
   value; enforce on PUT **and** DELETE in `admin.ts` (handlers at ~:3577 and
   ~:3674; they currently check secret/platform-scope/type but never saasVisible).
   Sandbox keys (`ATLAS_SANDBOX_BACKEND`, `ATLAS_SANDBOX_URL`) get
   `saasVisible: false, saasWritable: true` (the dedicated sandbox page writes
   them); `ATLAS_DEMO_INDUSTRY` becomes truly un-writable by SaaS workspace
   admins. Record the decision in the parity-contract section (Rule 4 mentions
   "#3376 tracks the decision").
2. **SaaS "Managed" sandbox target = follow platform default** (verified:
   `deploy/api/atlas.config.ts` pins `sandbox.priority: ["vercel-sandbox"]`, no
   sidecar on SaaS). Implemented as DELETE-the-override, already on the slice-1
   branch.
3. **#3377 is bigger than its issue text**: NO UI surface lists the
   ClickHouse/Snowflake/BigQuery datasource catalog cards anywhere
   (`GET /api/v1/integrations/catalog` filters `type IN ('chat','integration')`
   via `pillar-catalog-query.ts` `restrictToLegacyTypes`; the integrations page
   drops `pillar='datasource'`). #3300 shipped the form-install handlers
   (`POST /api/v1/integrations/:slug/install-form`) with no listing UI. So the
   fix exposes a `?pillar=datasource` listing and routes picker tiles to
   form-install — "just exclude the tiles" would leave zero UI install path.

## Slice status

| Slice | Issues | Branch | State |
|---|---|---|---|
| 1 | #3375+#3371 | `claude/sandbox-vocab-3375` (pushed, HEAD b18ca6c5) | **DONE + verified + code-reviewed. Open its PR first.** PR body staged at `.claude/pr-bodies/slice1-sandbox-vocab.md` on... see note below |
| 4 | #3377+#3381 | `claude/picker-form-install-3377` | In flight in the OLD session's worktree (uncommitted). If its push appears on origin, verify + review it; if the old session died before push, re-run from the brief below |
| 6 | #3379 | `claude/delivery-preflight-3379` | Same situation as slice 4 |
| 2 | #3376 | not started | After slice 1 MERGES (shares `settings.ts` + sandbox page) |
| 3 | #3382 | not started | After #3376 merges (locks in its semantics) |
| 5 | #3378 | not started | After slice 1 MERGES (shares sandbox page.tsx) |

Slice-1 verification already done by the old orchestrator (don't redo): diff
review against all acceptance criteria, 7-angle code review (1 finding, fixed in
b18ca6c5), 92/92 affected API test files, schemas 12/12, web 3/3, lint, type.
The staged PR body is also reproduced at the end of this document.

## Slice-1 PR notes (for the PR body / review replies)

- Out of scope, unchanged: #3370 (credentials consumption). Until it lands, a
  BYOC selection resolves through the normal plugin chain.
- Write-path normalization deliberately omitted (settings PUT is #3376's file);
  read-time normalization (`normalizeSandboxBackendValue` in explore.ts +
  admin-sandbox.ts) + registry description cover legacy values.
- `platformDefault: activePluginId ?? platformDefault` in the status route is
  pre-existing and correct per the field's contract — reviewed, left alone.

## Remaining slice briefs (condensed; full acceptance criteria in the issues)

**Slice 2 (#3376)** — implement decision 1 above. Files: `packages/api/src/lib/settings.ts`
(add `saasWritable?: boolean` to SettingDefinition + flag the sandbox keys),
`packages/api/src/api/routes/admin.ts` PUT/DELETE handlers (enforce: SaaS
workspace admin + `saasWritable === false` (defaulting to saasVisible) → 403),
`docs/development/enterprise-gating.md` Rule 4 (record the decision), route tests
(currently ZERO tests cover the write path's flag behavior). GET filtering
(saasVisible) unchanged.

**Slice 3 (#3382)** — `scripts/check-settings-readers.sh|ts`: every settings
registry key needs a non-test `getSetting`/`getSettingAuto`/`getSettingLive`
call site outside settings.ts and outside the generic admin settings routes;
allowlist with justification comments; wire into `/ci` (`.claude/skills` ci
skill / CI workflow) alongside `check-schema-drift.sh` + `check-ee-imports.sh`
precedents. Plus the saasVisible/saasWritable write-gate test if slice 2 didn't
already add it. Validate false-positive rate (~25 settings have verified readers
per the audit).

**Slice 5 (#3378)** — `packages/web/src/ui/hooks/use-deploy-mode.ts`: consumers
must not commit to a guessed mode (parity Rule 2 tiers: cosmetic-only may render
from guess; view-swapping components render neutral/loading until
`loading === false`; flows that WRITE mode-specific values must not save while
`loading || error`). Representative consumer: `/admin/sandbox` page (only reads
`deployMode`). 11 consumer files (list via grep). Decide failure-path default
for unknown public hosts (issue suggests neutral/unresolved beats guessing
"saas"). Test: settings fetch failure on a custom domain must not render the
SaaS-only sandbox view.

**Slice 4 (#3377+#3381), if re-run needed** — API: extend
`GET /api/v1/integrations/catalog` with `?pillar=datasource` (facade
`pillar-catalog-query.ts` has `restrictToLegacyTypes: false` seams; add
install-status-for-pillar), keep default response byte-identical; SaaS hides
DuckDB free via `saas_eligible=true` filter in `buildCatalogWhere`. Web:
`provider-meta.ts` URL_FORM_EXCLUDED += clickhouse/snowflake/duckdb;
`add-connection-picker.tsx` renders catalog form-install tiles (exclude slugs
postgres/mysql/demo-postgres/salesforce; reuse
`admin/integrations/form-install-modal.tsx`); refresh like CuratedInstallDialog's
`onInstalled`. API: `detectDBType` error copy (lib code — keep deploy-agnostic,
stop prescribing atlas.config.ts as the only remedy). Docs SAME PR:
`apps/docs/content/docs/plugins/datasources/{clickhouse,snowflake,bigquery}.mdx`
(+ check `guides/admin-console.mdx#connections`): real flow, BigQuery fields
match its config_schema (`service_account_json` secret + `project_id` plain),
no "after reload" claims (#3295 registers immediately). pg/mysql URL installs
byte-identical.

**Slice 6 (#3379), if re-run needed** — design decided: warn-don't-block.
`lib/scheduler/sender-preflight.ts` (`checkDeliverySenders(recipients, orgId)`);
resolve-only export refactored out of `lib/email/delivery.ts` provider chain
(per-org install → platform settings → ATLAS_SMTP_URL → RESEND_API_KEY → log;
"log" ⇒ warning); Slack: warning only when both teamId-token (chat_cache
`getBotToken`) and `SLACK_BOT_TOKEN` absent. POST+update responses gain
`warnings: string[]`. Permanent failures: `DeliverySummary` gains permanent
count + first message (today `permanent` only feeds the retry predicate at
delivery.ts:350); executor writes `deliveryStatus: "failed_permanent"` (free-text
column, no migration) when ALL failures permanent; web run-history badge +
form-dialog warning display. NO auto-pause (note in PR). SaaS + configured
self-hosted behavior unchanged (assert in tests). Webhook: no preflight, but it
participates in permanent surfacing naturally.

WARNING for slices 4/6: the old session's agents touched
`packages/types/src/scheduled-task.ts` + `packages/types/package.json` (slice 6)
— if that lands as a *value* export or a version bump, check
`scripts/check-published-symbols.ts` and the publish-before-ref-bump rule;
prefer keeping new wire fields type-only or relocating to `@useatlas/schemas`.

## Suggested skills

- `/code-review` on each PR diff before requesting review (high effort; old
  session ran a 7-angle manual equivalent on slice 1 — done, don't redo).
- `/ci` before each PR (lint + type + test + syncpack + template drift).
- GitHub MCP `subscribe_pr_activity` per PR; `unsubscribe` after merge.

## Final deliverable

All 7 sub-issues closed via squash-merged PRs, #3374 bar at 7/7, #3374 left
OPEN, final status table comment on #3374.

---

## Appendix: staged slice-1 PR body (use verbatim, title: "fix(sandbox): one backend-id vocabulary for ATLAS_SANDBOX_BACKEND end to end")

Closes #3375. Closes #3371. Part of the #3374 deploy-mode drift audit (taxonomy class 1 + class 4).

**What**
- `@useatlas/schemas` is now the SSOT for the sandbox provider vocabulary (new `packages/schemas/src/sandbox.ts`): `SANDBOX_PROVIDER_KEYS`, `SandboxProviderKeySchema`, the one statement of the provider-key → backend-id mapping (`SANDBOX_PROVIDER_BACKEND_IDS`), `normalizeSandboxBackendValue()` for legacy stored values, and the `/admin/sandbox/status` wire schemas. `@atlas/api` (`credentials.ts`, `admin-sandbox.ts`) and `@atlas/web` (via the `@/ui/lib/admin-schemas` re-export) both consume it — no `@atlas/web → @atlas/api` import, no hand-mirrored enums (#3371).
- The SaaS sandbox view now writes backend ids (`e2b-sandbox`, …) into `ATLAS_SANDBOX_BACKEND` instead of provider keys (`e2b`) that the explore runtime could never match — selection no longer silently falls through to the platform pin (#3375).
- The Managed card clears the override (DELETE, same revert-to-default path the self-hosted reset uses) instead of writing `"sidecar"` — a value with no backing service on SaaS. "Managed" now means *follow the platform default* (`vercel-sandbox` per the `deploy/api/atlas.config.ts` pin), and stays correct if the pin ever changes.
- `isActive` can no longer contradict `activeBackend`: the status route derives `isActive` as "(normalized) override selects this provider's backend id AND the resolved activeBackend landed on it". The web's `isManagedActive` derives from the server's `isActive`, not a string compare.
- Legacy stored values keep working: readers (`explore.ts` override resolution incl. the cache key, the status route, the disconnect-reset compare) normalize bare provider keys through `normalizeSandboxBackendValue`. The settings-registry description documents backend ids as the canonical value set (parity contract Rule 3).
- Docs ride-along (Rule 5): `guides/sandbox.mdx` + `reference/environment-variables.mdx` updated to the backend-id vocabulary and the real SaaS managed backend.

**Why**
Audit finding #3375: a SaaS workspace admin connecting E2B and clicking "Use this" saved `"e2b"`, the UI showed the row as **Live** (`isActive` compared provider keys), and every explore call silently ran on Vercel Sandbox instead. Three components held three different opinions of the same setting's vocabulary.

**Notes for review**
- Out of scope, unchanged: wiring stored BYOC credentials into backend construction is #3370 (sibling issue, own product decision). Until it lands, a BYOC selection resolves through the normal plugin chain.
- Write-path normalization (settings PUT) deliberately not added here — the generic settings write path is being touched by #3376's `saasWritable` work; read-time normalization + the registry description cover the legacy-value window.
- `platformDefault: activePluginId ?? platformDefault` in the status response is pre-existing and correct per the field's contract (reviewed, left alone).

**Tests**
- `packages/schemas` — mapping completeness + normalize identity/translation (12 tests)
- `packages/api` — status-route vocabulary agreement (legacy `"e2b"` and canonical `"e2b-sandbox"` both resolve; `isActive` ⇔ `activeBackend` coherence), explore override normalization incl. cache-key behavior (9 + 9 tests)
- `packages/web` — SaaS view save-value mapping: BYOC saves backend id; Managed clears the override (3 tests)
- Verified: 92/92 affected API test files, `bun run lint`, `bun run type`
