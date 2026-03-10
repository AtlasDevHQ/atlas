# Changelog

Generate a changelog entry for recent work. Groups commits by type (Added, Changed, Fixed), links PRs/issues, and follows Keep a Changelog format.

**Run at the end of a milestone** or before a version bump to draft the changelog entry.

---

**Step 1: Determine scope**

Figure out what period to cover:

1. Read the current `CHANGELOG.md` — find the last entry's date and version:
   ```
   Read CHANGELOG.md (first 30 lines)
   ```

2. Get commits since the last changelog entry:
   ```
   git log --oneline --since="<last_entry_date>" --format="%h %s"
   ```

3. Get merged PRs in the same period:
   ```
   gh pr list -R AtlasDevHQ/atlas --state merged --limit 50 --json number,title,mergedAt,labels --jq '.[] | select(.mergedAt > "<last_entry_date>") | "#\(.number) \(.title)"'
   ```

4. Read `.claude/research/ROADMAP.md` — identify which milestone this work belongs to

**Step 2: Categorize changes**

Group all commits/PRs into Keep a Changelog categories:

| Category | What goes here | Commit prefix signals |
|----------|---------------|----------------------|
| **Added** | New features, new commands, new tools | `feat:`, `feat(*)` |
| **Changed** | Behavior changes, renames, dependency updates | `refactor:`, `chore:` (when user-facing) |
| **Fixed** | Bug fixes | `fix:`, `fix(*)` |
| **Removed** | Removed features or deprecated items | "remove", "drop", "delete" |
| **Security** | Security patches, vulnerability fixes | security-related fixes |

**Skip these** — don't include in changelog:
- CI-only changes (`fix(ci):`, workflow tweaks)
- Internal refactors with no user-facing impact
- Version bumps and tag pushes
- Test-only changes (unless they fix a user-reported bug)
- Comment/docs-only changes within code (not docs site)

**Include these even if minor:**
- Docs site changes (new pages, restructured content) → under Added or Changed
- CLI changes (new commands, changed flags) → under Added or Changed
- Plugin changes (new plugins, breaking changes) → under Added or Changed

**Step 3: Draft the entry**

Write the changelog entry following the existing format in `CHANGELOG.md`:

```markdown
## X.Y.0 — Theme Name (YYYY-MM-DD)

### Added

- Description of feature — context on what it enables ([#N](https://github.com/AtlasDevHQ/atlas/pull/N))
- Description of feature ([#N](https://github.com/AtlasDevHQ/atlas/pull/N))

### Changed

- Description of change ([#N](https://github.com/AtlasDevHQ/atlas/pull/N))

### Fixed

- Description of fix ([#N](https://github.com/AtlasDevHQ/atlas/issues/N))
```

**Style guidelines (match existing entries):**
- Each line starts with a verb: "Add", "Wire", "Replace", "Fix", "Drop"
- Include enough context to understand the change without reading the PR
- Link to the PR (not the issue) when both exist — PRs have the code
- Link to the issue when there's no PR (direct commits)
- For commit-only changes (no PR), link the commit hash
- Group related items (e.g., all plugin changes together)
- Most important/impactful changes first within each category
- Keep descriptions to one line (two at most for complex changes)
- Use em dashes (—) for inline clarification, not parentheses

**Step 4: Present for review**

Show the draft entry to the user. Ask:
- Does the version number and theme name look right?
- Any items to add, remove, or reword?
- Should any items be promoted (e.g., from Changed to Added)?

Wait for approval before writing.

**Step 5: Apply**

After approval:

1. Insert the new entry into `CHANGELOG.md` — below `## [Unreleased]` and above the previous entry
2. Commit:
   ```
   git add CHANGELOG.md
   git commit -m "docs: changelog for X.Y.0"
   git push
   ```

---

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with `gh` commands
- Follow the existing format exactly — consistency matters
- Don't inflate the changelog — skip trivial internal changes
- Each bullet should make sense to someone who uses Atlas but doesn't read the source
- Version numbers come from ROADMAP milestones, not package.json versions
- If a PR fixed an issue, link the PR (it has the code diff). Link issues only for commit-only fixes
- Date format: YYYY-MM-DD
- The `## [Unreleased]` section always stays at the top (empty)
