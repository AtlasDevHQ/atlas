# Roadmap Extension

Research and propose the next milestone. Analyze the codebase, competitive landscape, and user needs to draft what comes next.

**Run when there are zero open issues** and you need to plan the next body of work.

---

**Step 1: Understand current state**

Run these in parallel:

1. Read `.claude/research/ROADMAP.md` — shipped history and Ideas/Backlog
2. Read `CLAUDE.md` — architecture overview, key patterns, config surface
3. Scan the codebase for TODOs and FIXMEs:
   ```
   Grep for: TODO|FIXME|HACK|XXX in packages/ and apps/ (type: ts, output_mode: count)
   ```
4. Check open issues for themes:
   ```
   gh issue list -R AtlasDevHQ/atlas --state open --limit 100 --json number,title,labels
   ```
5. Check GitHub Discussions or community feedback (if any):
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
- Read `.claude/research/design/competitive-landscape.md` for the full analysis
- Focus on differentiators Atlas could pursue vs. table-stakes features it's missing

### 2c. Developer platform potential
- What would make Atlas attractive as a platform others build on?
- Plugin ecosystem gaps (what types of plugins are missing?)
- SDK/API surface area — what can't external developers do today?

### 2d. User experience
- Chat UX gaps (mobile, accessibility, theming, embedding)
- Onboarding flow improvements
- Semantic layer authoring experience
- Visualization capabilities

**Step 3: Draft the next milestone**

Propose 1-2 milestones. For each:

```
## X.Y.Z — [Theme Name]

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
- Items from the existing Ideas/Backlog section should be incorporated where they fit
- Only propose milestones that have clear customer impact — skip internal-only refactors unless they unblock user-facing work

**Step 4: Present for review**

Output the full proposed milestone(s). Include:

1. **Summary of findings** — What gaps did the analysis reveal? What themes emerged?
2. **Proposed milestones** — Full text in ROADMAP format
3. **Ideas/Backlog updates** — New items to add, items to promote to milestones
4. **Competitive positioning** — 2-3 sentences on how this differentiates Atlas

Wait for user feedback before writing changes.

**Step 5: Apply changes**

After user approval (with any requested modifications):

1. Update `.claude/research/ROADMAP.md` with new milestone section
2. Add a `"planned"` entry to `apps/docs/src/components/changelog-data.ts` if it's a significant release customers should know about
3. Create the GitHub milestone:
   ```
   gh api repos/AtlasDevHQ/atlas/milestones -f title="X.Y.Z — Theme Name" -f description="Brief description"
   ```
4. Commit and push

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
