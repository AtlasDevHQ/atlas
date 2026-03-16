# Milestone Closeout

Final review and closeout for a completed milestone. Verify everything shipped, docs are current, public-facing sites reflect the work, and tracking is clean.

**Run after the last issue in a milestone ships** — before `/kickoff` on the next milestone.

---

**Step 1: Verify milestone completeness**

Run these in parallel:

1. Open issues in the milestone:
   ```
   gh issue list -R AtlasDevHQ/atlas --state open --milestone "<milestone>" --json number,title
   ```

2. Read `.claude/research/ROADMAP.md` — check all items in the milestone section are `[x]`

3. Read `apps/docs/content/docs/roadmap.mdx` — check milestone status in public roadmap

4. Board state (confirm no In Progress / In Review items for this milestone):
   ```
   gh project item-list 2 --owner AtlasDevHQ --format json --limit 200 | jq '[.items[] | select(.status != "Done") | {status: .status, number: .content.number, title: .title}]'
   ```

If any issues are still open or ROADMAP items unchecked, **stop and report** — the milestone isn't ready for closeout.

---

**Step 2: Docs site audit**

Check that every shipped feature in this milestone is documented.

### 2a. Feature-to-docs mapping

For each checked `[x]` item in the ROADMAP milestone section:
1. Identify what user-facing behavior changed (new API endpoints, config options, UI pages, plugins, CLI commands)
2. Search the docs site for coverage:
   ```
   # For each feature keyword, search docs
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

### 2d. Plugin docs audit

For any new plugins shipped in this milestone:
- Verify plugin has a docs page under `apps/docs/content/docs/plugins/`
- Verify plugin appears in the appropriate category index page (e.g., `interactions/index.mdx`)
- Verify plugin has a README.md
- Verify plugin has a LICENSE file
- Verify plugin is in `.github/workflows/publish.yml` (tag trigger + publish step)
- Verify plugin is in all Dockerfiles (`deploy/api/Dockerfile`, `deploy/web/Dockerfile`, `examples/docker/Dockerfile`)

### 2e. Cross-link check

Verify docs pages reference each other where appropriate:
- New features should be mentioned in the relevant guide pages
- Plugin pages should link to the plugin SDK docs
- Config/env var changes should be cross-linked from guide pages

---

**Step 3: Public site audit (useatlas.dev)**

Read `apps/www/src/app/page.tsx` and check if the landing page should be updated:

- **Feature grid** — Do any new capabilities deserve a feature card? (e.g., new integrations, security features)
- **Security checklist** — Are new security features reflected? (e.g., session management, data classification)
- **Integration logos/mentions** — New platforms supported? (e.g., Teams, webhooks for Zapier/Make)
- **Checklist items** — Any new items to add to capability checklists?
- **Stats or copy** — Does any marketing copy need updating? (e.g., "20+ plugins" if plugin count changed)

If changes are needed, make them. The www site is a single-page React app — keep edits minimal and consistent with the existing design.

---

**Step 4: Internal ROADMAP update**

Read the full milestone section in `.claude/research/ROADMAP.md`:
- Confirm every item has `[x]` with issue and PR numbers
- Confirm no items were shipped but not listed (check git log for the milestone period)
- Add any missing items that were shipped as part of this milestone (bug fixes, cleanup, docs)

---

**Step 5: Public roadmap update**

Update `apps/docs/content/docs/roadmap.mdx`:
1. Move the milestone from its current section to the "Shipped" section
2. Write a 1-2 sentence prose summary matching the style of existing entries
3. Remove the `---` separator that was before this milestone section
4. Update "The current milestone" language to point to the next milestone
5. Update next milestone bullet points if scope changed

Commit and push:
```bash
git add apps/docs/content/docs/roadmap.mdx
git commit -m "docs: update roadmap — mark 0.X.0 as shipped"
git push
```

If the www site was also updated:
```bash
git add apps/www/src/app/page.tsx
git commit -m "chore(www): update landing page for 0.X.0 features"
git push
```

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
## 0.X.0 — [Name] — CLOSEOUT COMPLETE

### Shipped
- N issues closed, N PRs merged
- Key features: [1-2 sentence summary]

### Docs
- N features verified documented
- N docs gaps found and fixed
- N new docs pages created

### Public sites
- roadmap.mdx: milestone moved to Shipped
- useatlas.dev: [changes made or "no changes needed"]

### Tracking
- GitHub milestone: CLOSED
- Project board: all items Done
- ROADMAP.md: all items [x]

### Ready for next
- Next milestone: 0.Y.0 — [Name]
- Run `/kickoff` to create issues and start work
```

---

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands
- Don't skip the docs audit — stale docs are worse than no docs
- Don't update the www site gratuitously — only add genuinely new capabilities
- Keep the public roadmap prose clean and user-facing (no issue numbers)
- Commit docs and www changes separately (different commit messages)
- If you find doc gaps, fix them inline if small (< 20 lines), or file an issue if large
- The milestone isn't truly closed until the GH milestone is closed and memory is updated
