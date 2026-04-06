# Atlas Sitrep

Quick strategic orientation — where the project stands right now. Read-only, no actions.

**Run at the start of a session**, when switching context, or when you need the big picture before deciding what to do.

---

**Step 1: Gather state (all in parallel)**

1. Recent commits (last 3 days):
   ```
   git log --oneline --since="3 days ago" --format="%h %s (%cr)" | head -20
   ```

2. Open issues by category:
   ```
   gh issue list -R AtlasDevHQ/atlas --state open --limit 50 --json number,title,labels,milestone
   ```

3. Recently closed issues (last 3 days):
   ```
   gh issue list -R AtlasDevHQ/atlas --state closed --limit 30 --json number,title,closedAt,labels --jq '[.[] | select(.closedAt > "YYYY-MM-DD")] | length' 
   ```
   (Replace YYYY-MM-DD with 3 days ago)

4. Open milestones:
   ```
   gh api repos/AtlasDevHQ/atlas/milestones?state=open --jq '.[] | "\(.title): \(.open_issues) open / \(.closed_issues) closed"'
   ```

5. CI + deploy health:
   ```bash
   # Latest CI on main
   gh run list -R AtlasDevHQ/atlas --branch main --limit 3 --json status,conclusion,name,createdAt

   # Railway deploy statuses
   gh api repos/AtlasDevHQ/atlas/commits/main/statuses --jq '[.[] | {context, state}] | unique_by(.context) | .[] | "\(.context): \(.state)"'
   ```

6. Published package versions:
   ```bash
   npm view @useatlas/types version 2>/dev/null
   npm view @useatlas/sdk version 2>/dev/null
   npm view @useatlas/react version 2>/dev/null
   npm view @useatlas/plugin-sdk version 2>/dev/null
   ```

7. Test counts (quick — just count, don't run):
   ```bash
   # Count test files
   find packages/api/src -name '*.test.ts' | wc -l
   find packages/cli -name '*.test.ts' | wc -l
   find ee/src -name '*.test.ts' | wc -l
   find e2e -name '*.spec.ts' | wc -l
   ```

8. Read active ROADMAP section:
   - Read `.claude/research/ROADMAP.md` — focus on the most recent non-shipped section and Ideas/Backlog

---

**Step 2: Build the status report**

### 2a. Project Phase

Determine the current phase from milestones and ROADMAP:
- What milestone (if any) is active?
- If no active milestone, what's the strategic focus? (post-launch polish, new feature arc, etc.)
- What's the north star right now?

### 2b. Recent Velocity

From commits and closed issues:
- How many commits in the last 3 days?
- How many issues closed?
- What themes? (features, refactors, bug fixes, docs)
- Any notable ships? (new features, major refactors, breaking changes)

### 2c. Open Work Landscape

Categorize open issues:
- **Bugs** (label: `bug`) — count and list
- **Features** (label: `feature`) — count and group by area
- **Refactors** (label: `refactor`) — count
- **Docs** (label: `docs`) — count
- **Blocked** — any issues explicitly blocked? Why?

### 2d. Health Snapshot

- **CI**: Green on main? If not, what's failing?
- **Railway**: All services deployed? Any pending/failing?
- **Test coverage**: How many test files across API, CLI, EE, browser?
- **Package versions**: Current published versions of @useatlas/* packages

### 2e. Strategic Context

From ROADMAP and competitive landscape:
- Where does Atlas stand in its lifecycle? (pre-launch, post-launch, growth)
- What's the most important thing to ship next and why?
- Any upcoming deadlines or external dependencies?

---

**Step 3: Output the report**

Use this format:

```markdown
## Atlas Status — YYYY-MM-DD

### Phase
<1-2 sentences on current project phase and north star>

### Recent Activity (last 3 days)
- **Commits:** N
- **Issues closed:** N
- **Themes:** <what shipped — features, refactors, fixes>
- **Notable:** <any big ships worth calling out>

### Open Issues (N total)
| Category | Count | Notes |
|----------|-------|-------|
| Bugs | N | <any critical?> |
| Features | N | <grouped by area> |
| Refactors | N | <any blocked?> |
| Docs | N | |

### Health
| System | Status |
|--------|--------|
| CI (main) | ✓ green / ✗ failing — <details> |
| Railway API | ✓ deployed / ⏳ deploying / ✗ failed |
| Railway Web | ✓ / ⏳ / ✗ |
| Railway Docs | ✓ / ⏳ / ✗ |

### Packages (@useatlas/*)
| Package | Version |
|---------|---------|
| types | 0.0.X |
| sdk | 0.0.X |
| react | 0.0.X |
| plugin-sdk | 0.0.X |

### Tests
| Area | Files |
|------|-------|
| API | N |
| CLI | N |
| EE | N |
| Browser (e2e) | N |

### What Matters Now
<2-3 sentences on what's most strategically important to focus on, informed by the open issue landscape, recent momentum, and project phase>
```

---

**Rules:**
- Read-only — don't create issues, close issues, edit files, or push commits
- Keep it concise — this is orientation, not analysis
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands
- If CI is failing, flag it prominently — that's the #1 thing to know
- Don't speculate about timelines — focus on what IS, not when things will be done
