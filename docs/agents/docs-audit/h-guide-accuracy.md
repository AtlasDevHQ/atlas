## Part H: Guide Accuracy Spot-Check (MEDIUM RISK)

**Docs:** guides live in all three trees — `apps/docs/content/docs/guides/` (SaaS), `apps/docs/content/self-hosted/{getting-started,deployment,guides,frameworks}/` (self-hosted), `apps/docs/content/shared/guides/` (both audiences)
**Source of truth:** Various source files

Pick the 5 most recently changed guides across ALL THREE trees (by git log) and spot-check:

| Check | How |
|-------|-----|
| **Import paths** | Do `import` statements in code examples resolve to real exports? |
| **Config snippets** | Do `atlas.config.ts` examples validate against current schema? |
| **File paths** | Do referenced file paths (`semantic/entities/*.yml`, etc.) exist in the expected structure? |
| **Screenshots** | If guide references UI elements, do they still exist? (check component names) |
| **Prerequisites** | Are version requirements and dependency lists current? |

### Grep patterns
```bash
# Find recently modified guides (all three trees) — use $LAST_TAG..HEAD when running end-of-cycle (Part K)
git log --oneline --since="2 weeks ago" -- apps/docs/content/docs/guides/ apps/docs/content/self-hosted/ apps/docs/content/shared/guides/ | head -10

# Check import paths in code examples
grep -rP 'from ["'"'"']@' apps/docs/content/docs/guides/ apps/docs/content/self-hosted/ apps/docs/content/shared/guides/ --include='*.mdx' | grep -v node_modules
```

---
