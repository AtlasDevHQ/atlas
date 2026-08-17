---
description: "Research the codebase to answer a question or plan a change, from ROADMAP, the competitive-landscape doc, and CLAUDE.md's subsystem map."
---

You are researching the Atlas codebase to answer a question or plan a change.

**Start with these for high-level context:**
- `.claude/research/ROADMAP.md` — shipped milestones, Ideas/Backlog for future work
- `.claude/research/design/competitive-landscape.md` — competitive analysis, positioning, licensing strategy

**Orientation:** CLAUDE.md § *`lib/` subsystem map* names every subsystem and its entry point, and each `package.json` says what its package is. Start there, then search — do not expect a file list here.

> A hardcoded path table used to live in this command. It was deleted on 2026-08-17 because nothing enforced it: three of its rows had drifted into *different packages* (`lib/semantic.ts` → `lib/semantic/`, `lib/errors.ts` → `packages/types/src/errors.ts`, `packages/cli/bin/enrich.ts` → `lib/semantic/enrich/`) and two counts were off by 3× (14 chat components → 42, 15 plugins → 25). A map that sends you to a path that moved packages is worse than no map, because you stop searching. If you want one back, it needs a `scripts/check-*.sh` guard that fails when a listed path stops existing.

Conventions (bun-only, strict mode and path aliases, SELECT-only SQL, the `semantic/` traversal guard, the Better Auth plugin pattern) are CLAUDE.md § *⚠️ Always* verbatim — read them there, so there is one copy to keep true.

**Your job:** Explore the relevant files to answer the question. Trace through code to understand data flow. Provide a clear, specific answer with file paths and line numbers.
