# Milestone Closeout

Final review and closeout for a completed milestone. Verify everything shipped, docs are current, changelog is updated, and tracking is clean.

**Run after the last issue in a milestone ships.**

---

**Step 1: Verify milestone completeness**

Run these in parallel:

1. Open issues in the milestone:
   ```
   gh issue list -R AtlasDevHQ/atlas --state open --milestone "<milestone>" --json number,title
   ```

2. Read `.claude/research/ROADMAP.md` — check all items in the milestone section are `[x]`

If any issues are still open or ROADMAP items unchecked, **stop and report** — the milestone isn't ready for closeout.

---

**Step 2: Docs site audit**

Check that every shipped feature in this milestone is documented.

### 2a. Feature-to-docs mapping

For each checked `[x]` item in the ROADMAP milestone section:
1. Identify what user-facing behavior changed (new API endpoints, config options, UI pages, plugins, CLI commands)
2. Search the docs site for coverage:
   ```
   grep -ri "<keyword>" apps/docs/content/docs/ --include="*.mdx" -l
   ```
3. Build a table:
   ```
   | Feature | Docs page | Status |
   |---------|-----------|--------|
   | Session management | admin-console.mdx, config.mdx, env-vars.mdx | ✓ Documented |
   | Webhook plugin | plugins/interactions/webhook.mdx | ✓ Documented |
   | ... | ... | ... |
   ```

### 2b. Config and environment variable audit

Check that all new config options and env vars from this milestone appear in the reference pages:
```bash
# Find new config options added in this milestone's commits
git log --all --oneline --grep="<milestone_number>" -- packages/api/src/lib/config.ts | head -10
# Cross-reference with docs
grep -c "ATLAS_" apps/docs/content/docs/reference/environment-variables.mdx
```

- Read `apps/docs/content/docs/reference/config.mdx` — verify new `defineConfig()` options are documented
- Read `apps/docs/content/docs/reference/environment-variables.mdx` — verify new env vars are listed

### 2c. API reference audit

Check that new API endpoints appear in the OpenAPI spec and API reference:
```bash
# Find new routes added in this milestone
git log --oneline --since="<milestone_start>" -- packages/api/src/api/routes/ | head -20
```
- Verify new endpoints appear in the auto-generated API reference pages under `apps/docs/content/docs/api-reference/`

---

**Step 3: Public site audit (useatlas.dev)**

Read `apps/www/src/app/page.tsx` and check if the landing page should be updated:

- **Feature grid** — Do any new capabilities deserve a feature card?
- **Security checklist** — Are new security features reflected?
- **Integration logos/mentions** — New platforms supported?
- **Stats or copy** — Does any marketing copy need updating?

If changes are needed, make them.

---

**Step 4: Internal ROADMAP update**

Read the full milestone section in `.claude/research/ROADMAP.md`:
- Confirm every item has `[x]` with issue and PR numbers
- Confirm no items were shipped but not listed (check git log for the milestone period)
- Add any missing items that were shipped as part of this milestone (bug fixes, cleanup, docs)

---

**Step 5: Update public changelog**

If the milestone represents a customer-meaningful release, add an entry to `apps/docs/src/components/changelog-data.ts`:

1. Add a new entry at the TOP of the `releases` array with version, title, date, summary, and optional highlights
2. Only include if the milestone has user-facing impact — skip internal refactors and polish passes

---

**Step 6: Close the GitHub milestone**

```bash
# Close the milestone
gh api repos/AtlasDevHQ/atlas/milestones/<milestone_number> -X PATCH -f state=closed

# Verify
gh api repos/AtlasDevHQ/atlas/milestones --jq '.[] | "\(.number)\t\(.title)\t\(.state)"'
```

---

**Step 7: Memory update**

Update the project memory to reflect:
- Milestone status (COMPLETE with date)
- Any notable decisions or patterns established during this milestone
- Key statistics (issues shipped, PRs merged)

---

**Step 8: Report**

Output a summary:

```
## X.Y.Z — [Name] — CLOSEOUT COMPLETE

### Shipped
- N issues closed, N PRs merged
- Key features: [1-2 sentence summary]

### Docs
- N features verified documented
- N docs gaps found and fixed

### Public sites
- changelog-data.ts: [entry added or "no user-facing changes"]
- useatlas.dev: [changes made or "no changes needed"]

### Tracking
- GitHub milestone: CLOSED
- ROADMAP.md: all items [x]

### Next
- [What's next or "no active milestone"]
```

---

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands
- Don't skip the docs audit — stale docs are worse than no docs
- Don't update the www site gratuitously — only add genuinely new capabilities
- Only add changelog entries for customer-meaningful releases
- Commit docs and www changes separately (different commit messages)
- If you find doc gaps, fix them inline if small (< 20 lines), or file an issue if large
- The milestone isn't truly closed until the GH milestone is closed and memory is updated
