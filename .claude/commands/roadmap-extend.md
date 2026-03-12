# Roadmap Extension

Research and propose new milestones beyond what's currently planned. Analyze the codebase, competitive landscape, and user needs to draft the next phase of Atlas's roadmap.

**Run when the existing roadmap is mostly shipped** and you need to plan what comes after 0.5.0 (or fill gaps in existing milestones).

---

**Step 1: Understand current state**

Run these in parallel:

1. Read `.claude/research/ROADMAP.md` — full roadmap including Ideas/Backlog
2. Read `apps/docs/content/docs/roadmap.mdx` — public-facing roadmap
3. Read `CLAUDE.md` — architecture overview, key patterns, config surface
4. Scan the codebase for TODOs and FIXMEs:
   ```
   Grep for: TODO|FIXME|HACK|XXX in packages/ and apps/ (type: ts, output_mode: count)
   ```
5. Check open issues for themes:
   ```
   gh issue list -R AtlasDevHQ/atlas --state open --limit 100 --json number,title,labels
   ```
6. Check GitHub Discussions or community feedback (if any):
   ```
   gh api repos/AtlasDevHQ/atlas/issues?labels=help+wanted,good+first+issue --jq '.[].title'
   ```

**Step 2: Analyze gaps and opportunities**

Research these areas by reading relevant source files:

### 2a. What's built but incomplete
- Read through major subsystems and identify half-built features, commented-out code, or config flags that exist but aren't fully wired
- Check for env vars documented in CLAUDE.md that don't have full implementations
- Look for plugin types defined in the SDK but without reference implementations

### 2b. Competitive landscape
- Read `.claude/research/design/competitive-landscape.md` for the full analysis (competitors, positioning, licensing strategy, RAG vs semantic learning, action items)
- Focus on differentiators Atlas could pursue vs. table-stakes features it's missing
- Key competitors: WrenAI (AGPL, Docker-only), Vanna (Python library, RAG), Cube D3 (enterprise semantic layer), nao (YC-backed, early)
- The unmentioned threat: general-purpose AI tools (Cursor, Claude Desktop) with raw database MCP connections

### 2c. Developer platform potential
- What would make Atlas attractive as a platform others build on?
- Plugin ecosystem gaps (what types of plugins are missing?)
- SDK/API surface area — what can't external developers do today?
- Integration opportunities (Slack is done — what about Teams, Discord, email digests?)

### 2d. Operational maturity
- What's needed for production use at scale?
- Monitoring, alerting, backup/restore, migration tooling
- Performance: query caching, connection pooling, CDN for assets
- Security: audit improvements, compliance features, pen-test readiness

### 2e. User experience
- Chat UX gaps (mobile, accessibility, theming, embedding)
- Onboarding flow improvements
- Semantic layer authoring experience
- Visualization capabilities

**Step 3: Draft new milestones**

Propose 2-4 new milestones beyond what's currently in ROADMAP.md. For each:

```
## 0.X.0 — [Theme Name]

[2-3 sentence description of why this milestone matters and what it enables.]

### [Category 1]
- [ ] Item description — brief rationale
- [ ] Item description — brief rationale

### [Category 2]
- [ ] Item description — brief rationale
- [ ] Item description — brief rationale
```

**Guidelines for milestone design:**
- Each milestone should have a clear theme (not a grab bag)
- 8-15 items per milestone (shippable in 2-4 weeks of focused work)
- Order milestones by dependency — foundational before aspirational
- Mark items that could be community contributions with `(good first issue)`
- Include a mix of user-facing features and infrastructure/DX work
- Items from the existing Ideas/Backlog section should be incorporated where they fit

**Also propose updates to existing milestones if:**
- Items should be re-prioritized based on codebase analysis
- Items should be moved between milestones
- Items are missing that the codebase analysis revealed as necessary
- Items are no longer relevant or were already addressed

**Step 4: Present for review**

Output the full proposed roadmap extension. Include:

1. **Summary of findings** — What gaps did the analysis reveal? What themes emerged?
2. **Proposed milestones** — Full text in ROADMAP format
3. **Existing milestone updates** — Any changes to 0.3.0-0.5.0
4. **Ideas/Backlog updates** — New items to add, items to promote to milestones
5. **Competitive positioning** — 2-3 sentences on how this roadmap differentiates Atlas

Wait for user feedback before writing changes.

**Step 5: Apply changes**

After user approval (with any requested modifications):

1. Update `.claude/research/ROADMAP.md` with new/modified milestones
2. Update `apps/docs/content/docs/roadmap.mdx` with user-facing summaries for new milestones
3. Create new GitHub milestones if needed:
   ```
   gh api repos/AtlasDevHQ/atlas/milestones -f title="0.X.0 — Theme Name" -f description="Brief description"
   ```
4. Commit and push docs roadmap changes

---

**Rules:**
- Don't propose features that contradict Atlas's core principles (read-only SQL, semantic layer driven, deploy-anywhere)
- Don't propose switching core technologies (always bun, always Hono, always Next.js)
- Keep milestones realistic — each should be achievable in 2-4 weeks
- Prioritize features that increase adoption and stickiness over internal refactors
- Consider the solo-developer / small-team audience — Atlas isn't Looker
- Every proposed item should have a clear "who benefits" — end users, plugin authors, or operators
- Don't duplicate items already in the roadmap — check carefully
- Reference specific files/systems when proposing infrastructure work
- Think about what makes Atlas uniquely valuable: natural language SQL + semantic layer + plugin extensibility + deploy-anywhere
