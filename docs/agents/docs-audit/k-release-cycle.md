## Part K: Release-Cycle Scoping (end-of-cycle runs)

When running this audit at the end of a code cycle (before `/release`), scope the discovery parts to what actually changed since the last tag, and add the release-specific checks below. The full-repo parts (A–G) still run unscoped — reference drift accumulates regardless of when it was introduced.

### K1. Establish the cycle window

```bash
git fetch --tags origin          # remote/ephemeral clones often lack tags — fetch first
LAST_TAG=$(git describe --tags --abbrev=0)
git log --oneline "$LAST_TAG"..HEAD | wc -l          # cycle size
git log "$LAST_TAG"..HEAD --pretty='%s' | grep -P '^(feat|fix)' # customer-visible candidates
```

Use `$LAST_TAG..HEAD` as the window everywhere a recency filter appears (Part H's "5 most recent guides", J2's new migrations, this part). Per ADR-0008, customer-visible changes since the tag are what forces the next tag's semver position — the audit's shipped-feature list doubles as that input.

### K2. Per-feature docs coverage for the cycle

For each customer-visible commit/PR in the window (dedupe by feature — use PR titles, milestone issues via `gh api repos/AtlasDevHQ/atlas/milestones`, and ROADMAP `[x]` items from J4):

| Check | How |
|-------|-----|
| **Docs exist** | Feature has a page/section in the correct audience tree (see layout table at top) → missing = HIGH |
| **Docs updated, not just existing** | If the feature *changed* an already-documented behavior, was the page touched in the same window? `git log $LAST_TAG..HEAD -- apps/docs/content/` vs the feature's code paths |
| **Generated surfaces regenerated** | New/changed routes → openapi.json + api-reference MDX regenerated (Part D); SAAS_ENV_KEYS changes → saas-environment-variables.mdx regenerated (Part A2) |

### K3. Stability commitments

**Docs:** `apps/docs/content/shared/reference/stability.mdx`

If any commit in the window touched a contract that page documents as stable (wire types, REST endpoints, plugin SDK, MCP tools), flag it CRITICAL — it either needs a docs update, a semver decision, or both. Contract breaks are reserved for major versions.

### K4. Chat-plugin × Atlas contract doc (milestone-closeout blocker)

**Docs:** `docs/architecture/chat-plugin-atlas-contract.md`

If the window includes commits touching `plugins/chat/src/`, `packages/api/src/lib/slack/`, or `packages/api/src/lib/integrations/install/*-oauth-handler.ts`, the contract table must have been updated in those same commits. Also check for open ⚠ rows — they block milestone closeout regardless of this audit.

```bash
git log "$LAST_TAG"..HEAD --oneline -- plugins/chat/src/ packages/api/src/lib/slack/ 'packages/api/src/lib/integrations/install/*-oauth-handler.ts'
grep -n '⚠' docs/architecture/chat-plugin-atlas-contract.md
```

### K5. Changelog material (hand-off, not a fix)

The per-tag changelog entry (`apps/docs/src/components/changelog-data.ts` `releases[]`) is written by `/release`, not here — don't add it. But the audit's shipped-feature list from K2 is the raw material: include it in the report under a "Changelog input" heading so `/release` doesn't re-derive it.

---
