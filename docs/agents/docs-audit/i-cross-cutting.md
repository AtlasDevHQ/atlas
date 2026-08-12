## Part I: Cross-Cutting Checks (LOW-MEDIUM RISK)

### I1. Stale Package References

```bash
# Check for references to old package names or paths (ALL content trees)
grep -rP '@atlas/web|@atlas/cli|@atlas/mcp' apps/docs/content/ --include='*.mdx' -l
# These are internal packages — docs should reference @useatlas/* public packages instead
# Exception: deployment/architecture docs may legitimately reference internal packages
```

### I2. Dead Links (Internal)

Internal-path and `#anchor` resolution is now a CI gate (promoted per the
ratchet — #4480): `bun scripts/check-docs-links.ts` validates every internal
link against the tree mounts and every anchor against `github-slugger`-computed
heading slugs, per mount. Run the gate first; this audit checks only the residue
the gate can't see:

- `href={...}` JSX expressions and `[x](</path>)` angle-bracket
  destinations (not statically resolvable / extracted)
- Anchors into generated `api-reference/` pages (JSX `<APIPage>` body — the
  gate checks page existence only)
- A `shared/` page hard-linking a saas-only page with a root path: the link
  *resolves* (no 404), but sends a `/self-hosted` reader on a cross-section
  jump — judge whether audience-appropriate phrasing or `<AudienceLink>` fits

### I3. Notebook Docs Currency — RETIRED 2026-08-12

**Deleted, not skipped.** Both sides of this check stopped existing at `8a552d375` —
*"refactor(notebook): retire the notebook surface end-to-end (ADR-0035) (#4589)"* — which
removed `apps/docs/content/docs/guides/notebook.mdx` and
`packages/web/src/ui/components/notebook/` in the same commit, along with the three source
files this check read (`use-keyboard-nav.ts`, `use-notebook.ts`, `notebook-export.ts`).

It had therefore been **silently passing** ever since: a check whose docs page and source
tree are both gone matches nothing and reports nothing.

The number is kept as a tombstone rather than renumbering, because `audit-docs.md` and
this file both reference **I4** by name.

The only remaining "notebook" strings in the content trees are in
`shared/comparisons/{cube,vanna,index}.mdx`, all describing **competitors'** notebooks —
correct, and not an Atlas claim. Nothing to re-add here.

### I4. Audience Drift (content-level — the build gate can't catch this)

The taxonomy gate validates *placement*; this check validates *content* against the audience the tree promises:

| Check | How |
|-------|-----|
| **SaaS instructions in shared/** | A `content/shared/` page telling readers to edit env vars / redeploy / `docker compose` — those steps don't apply to SaaS readers, where config lives in the Admin console (settings registry). Shared pages must be audience-neutral or branch explicitly |
| **Self-hosted-only features in the SaaS tree** | `content/docs/` pages describing `.env`-only knobs, `atlas.config.ts`, nsjail, sidecar, etc. that SaaS customers can't touch → move or re-scope |
| **SaaS-only features in shared/ or self-hosted/** | Marketplace, residency, billing plans, SSO/SCIM (SaaS flavors), platform-ops surfaces described as if available self-hosted → mis-scoped |
| **Fork pairs drifted** | Files sharing a `fork:` frontmatter key are deliberately divergent duplicates. `grep -rn '^fork:' apps/docs/content/` — for each pair, check both sides were updated when the underlying feature changed (the gate only checks the markers exist). As of 2026-07 **zero fork pairs exist** — audience branching is done in-page via `<WhenSaaS>`/`<WhenSelfHosted>`/`<AudienceLink>` components, so an empty grep is a PASS, not a broken check |

---
