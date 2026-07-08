# Blog Post — Write & Polish

Turn a rough idea into a finished `apps/www` blog post, or run an editorial polish pass over an existing one. The `new` mode is a **collaboration, not a one-shot generator**: you bring an idea, it mines the repo (git history, ROADMAP, changelog, code, ADRs, sibling posts) for real truths and concrete material, riffs on the angle with you in a back-and-forth, then drafts it. Both modes bake in the house voice (plainspoken founder voice, no AI tells), the prose-component structure, and the multi-file anatomy (route + index + sitemap + metadata + byline) so nothing drifts out of sync.

**Modes** (first arg picks one; default to asking if unclear):
- **`new <idea>`** — ground → ideate → outline → draft. Mine the repo for what actually shipped, shape the angle with Matt, then write it through the prose system. Bring a one-line idea; it does the rest collaboratively.
- **`pass [<slug | path | "diff">]`** — de-AI + voice + consistency polish over an existing post. No arg → operate on the working diff (changed `apps/www/blog` files). `diff` → same.

**Why this is its own command:** the blog is a *public, founder-voice* surface — half marketing, half personal. The failure modes are specific and easy to miss: AI-tell prose (the "it's not X, it's Y" cadence), an unintended double-entendre, or a rename that updates the slug in 3 of 5 places and silently 404s the rest. The editorial law and the file anatomy below are the hard-won rules; follow them exactly.

**Canonical voice exemplars** — read these two before writing or judging anything:
- `apps/www/src/app/blog/why-this-one-stuck/page.tsx` (founder note)
- `apps/www/src/app/blog/announcing-atlas/page.tsx` (product recap)

---

## House voice & style — applies to BOTH modes

The single most important job is **prose that doesn't read as AI-written.** Matt will notice; assume a hostile reader who pattern-matches for LLM tells.

### Kill these AI tells (non-negotiable)

- **Antithesis / define-by-negation.** The #1 tell. Hunt and destroy every:
  - "it's not X, it's Y" · "not a Z, but a W" · "X, not just Y" · "isn't the point; Y is"
  - Doubled negation: "not another BI tool… and not a chatbot parlor trick."
  - Fix by **stating the thing positively.** If a contrast is genuinely load-bearing, keep *one*, phrased naturally ("rather than", floor/ceiling), never the formulaic pair.
- **Precious aphorisms / self-narrating insight.** "That's also, quietly, the thesis." · "There's a symmetry I didn't plan." Cut or flatten to a plain statement.
- **Reveal-construction openings.** "I want to tell you something… it's the first thing I ever finished." Open with the plain fact instead.
- **Em-dash pile-ups.** One post should not lean on `—` for every aside. Prefer commas and full stops. An em-dash introducing a list is fine; three appositive em-dashes a paragraph is a tell.
- **Overused LLM words.** Watch repetition of: *legible, seamless, robust, leverage, delve, crucial, testament.* If a word appears 3× across a post, vary it.
- **Tricolon-of-fragments as filler.** "A refactor I couldn't land. A rewrite that looked cleaner. A week off." — one earned list per post, max; don't reflexively triple everything.
- **"For the first time" / "for once"** as a closer crutch — use sparingly.
- **Cross-post phrase duplication.** A pull-quote or aphorism reused verbatim across two posts reads templated (we caught "Same wager, both ends" in both). Each post gets its own.

### Innuendo / double-entendre check (do this every pass)

Read every headline, slug, stat label, and pull quote cold for an unintended second reading. Real catches from this blog: **"bad at finishing"**, **"the first thing I finished"**, **"more fun than finishing."** Words to eyeball: *finish/finishing, come, hard, blow, member.* When in doubt, reword — these are the highest-embarrassment, lowest-cost fixes, and a slug is the worst place to leave one.

### Voice

- Plainspoken, concrete, a little dry. Understatement over hype.
- **Specifics carry it.** Real numbers (the `StatStrip`), real names (the `tide → tide-ai → tide-monorepo` list), real artifacts. Generic = AI.
- First-person "I". It's been one person + an AI agent — own the singular, no corporate "we."
- **Background is narrative fuel, not a résumé.** Weave it only where it sharpens the story (e.g. "I ship for a living, on a team — solo is where it died"). **Decision point per post:** how much background, and *domain vs. company* (name the field, or name the employer?). Surface this to Matt; don't assume. Default to domain-not-company unless told otherwise.
- The **recap stays product-led** — no personal background. The **founder note** is where the personal voice lives.
- Tooling note: **`/copywriting` is for marketing pages (landing/pricing), not personal essays** — wrong register; edit essays by hand. **`/impeccable` for a blog post means restraint** — the prose system already carries the design; don't bolt on ornaments.

---

## Structure & conventions

**Read `apps/www/src/components/prose.tsx` for the live component inventory** (don't trust a hardcoded list — it grows). As of now the beats are: `Article` (one 680px reading column) · `PostHeader` (tag, isoDate, dateLabel, readingTime, title, dek → renders `Byline`) · `Lead` · `P` · `H2` · `InlineCode` · `CodeBlock` · `PullQuote` · `StatStrip` · `DefList`/`DefItem` · `Steps`/`Step` · `PostActions` · `Signoff` · `BackToBlog`. Brand color flows through tokens (`text-fg`, `text-accent`, `bg-bg-sunken`, …) — never hardcode hex.

Rhythm that works: **Lead → a stat or visual beat early → H2 sections → one `PullQuote` for a breath → `DefList`/`Steps` for scannable structure → `PostActions` + `Signoff` → `BackToBlog`.** Headlines are **sentence case** ("Why this one stuck", not Title Case). Keep JSX apostrophes escaped (`&apos;`, `&ldquo;`/`&rdquo;`) — the repo lints `react/no-unescaped-entities`.

### The multi-file anatomy — a post is **5 places**, keep them in lockstep

| Concern | Lives in |
|---|---|
| The post | `apps/www/src/app/blog/<slug>/page.tsx` (dir name **is** the slug) |
| Index card | `apps/www/src/app/blog/page.tsx` → `POSTS` array (`slug`, `title`, `description`, `isoDate`, `dateLabel`, `readingTime`, `tag`) |
| Sitemap | `apps/www/src/app/sitemap.ts` → a `/blog/<slug>` entry |
| Metadata/OG | the page's own `export const metadata` (title, description, OG title/description/**url**) |
| Cross-links | other posts that `<a href="/blog/<slug>">` it — the link **text** should match the title |

**Consistency invariants** (a rename or retitle must satisfy all of these — the rename we did proved how easy it is to miss one):
- slug string identical in: directory name · `metadata.openGraph.url` · `POSTS.slug` · `sitemap.ts` · every cross-post `href`.
- title string consistent in: `<PostHeader title>` (h1) · `metadata.title` + OG title · `POSTS.title` · cross-post link text.
- If renaming a slug: `git mv` the directory (preserves history), then grep the **old** slug repo-wide to prove zero stragglers. Add a redirect **only if it already shipped to prod** (check: is the post's commit at/behind the latest release tag? if not, it's staging-only — no redirect needed).

---

## Mode: `new <idea>` — ground it, craft it together, then write it

A **collaboration**, not a generator. The whole point is to turn a rough idea into a post grounded in what actually shipped — by mining the repo for truths and shaping the angle *with Matt* before any prose exists. Don't skip to drafting.

### Phase 1 — Ground in reality (mine the repo for truths)

Before pitching anything, gather real, citable material relevant to the idea. Sources, richest first:
- **`git log`** — what shipped and when; real cadence and counts, never invented (`git log --oneline --since=…`, `… | wc -l`, dates, commit volume). This is where stats like "29 releases in 27 days" come from — verified, not guessed.
- **`.claude/research/ROADMAP.md` + `ROADMAP-archive.md`** — the milestone/tag narrative. The `## Today` paragraph is the canonical one-paragraph product truth.
- **`apps/docs/src/components/changelog-data.ts`** — per-tag shipped features in customer language (already vetted prose).
- **`docs/adr/`** + **`.claude/research/architecture-wins.md`** — decisions and deepening stories; gold for an engineering-flavored post.
- **GitHub** (`gh … -R AtlasDevHQ/atlas`) — the milestone, PRD, or issue behind a feature.
- **The code itself** — read the real implementation so technical claims are exact (e.g. the SQL validation layers in `packages/api/src/lib/semantic/whitelist.ts`; `prose.tsx`). Never approximate a number you can read.
- **Existing posts** — voice exemplars, and to avoid reusing a hook, stat, or pull quote.

Collect concrete candidates: real numbers, real names, real before/after stories, real dates. **Flag anything you can't verify and never invent a stat** — a fabricated number on a public founder post is the worst outcome.

### Phase 2 — Back-and-forth (shape the angle)

Now converse. Bring the mined material as concrete options — don't interrogate in a vacuum. Drive the genuine forks with AskUserQuestion and iterate until the shape is shared:
- **Audience + the one takeaway** — who it's for, the single thing they remember.
- **Angle / hook** — pitch 2–3 hooks built from real material ("open on the Tide repo saga", "open on the 29-in-27 cadence", "open on the safety pipeline"). Let Matt pick or redirect.
- **Founder-note vs product-led**, and the `tag`.
- **Background depth + domain-vs-company** (per House voice — surface it, don't assume).
- **Which truths make the cut** — the 3–5 concrete artifacts that anchor the piece.

(`/grill-me` and `/grill-with-docs` are good engines here when an idea needs real stress-testing against the domain.)

### Phase 3 — Outline

Converge on the beat structure (Lead → an early stat/visual → H2 sections → one `PullQuote` → `DefList`/`Steps` → `PostActions` + `Signoff`) and the slug (kebab-case, innuendo-checked, no "finished"-class words). Confirm the outline with Matt before drafting.

### Phase 4 — Draft & wire

1. **Branch** (`feat/www-blog-<slug>`). If another session may share this checkout, use a worktree (see `revamp.md` Step 0).
2. **Write `page.tsx`** through the prose beats with the voice rules live — real material from Phase 1, not filler. Fill `metadata` + OG (title, description, `url` with the slug, `authors`).
3. **Wire the other 4 places**: `POSTS` entry (newest first — first entry is the featured lead), the `sitemap.ts` line, cross-links from sibling posts.
4. **Self-audit against "Kill these AI tells"**, then run **Pre-flight**. Show it, iterate.

## Mode: `pass [<slug | path | "diff">]`

1. **Scope it.** A slug/path → that post. No arg or `diff` → the changed `apps/www/blog` files in the working tree (`git diff --name-only`).
2. **Branch if not already on a feature branch.**
3. **Three sweeps, in order:**
   - **De-AI** — walk "Kill these AI tells" line by line. Quote each tell + its fix in your report so Matt can sanity-check the calls.
   - **Innuendo** — headline, slug, stat labels, pull quotes, read cold.
   - **Consistency** — run the invariants table. Grep the slug repo-wide; confirm title agreement across all 5 places.
4. **Surgical edits only.** Preserve content and structure; this is line-craft, not a rewrite. Don't add background to a product-led post.
5. Run **Pre-flight**.

---

## Pre-flight — both modes, before declaring done

1. **Lint the changed files** (catches `react/no-unescaped-entities` + Tailwind canonical-class hints):
   ```bash
   cd apps/www && bun x oxlint <changed paths>
   ```
2. **Render check.** `apps/www` dev server runs on **:3002** (`cd apps/www && bun run dev`, background). Then:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/blog/<slug>     # expect 200
   curl -s http://localhost:3002/blog | grep -o "<slug>"                          # index lists it
   ```
   On a rename, also confirm the **old** URL → **404**.
3. **Fact-safety.** Cross-check any hard claim against reality before it ships — license is **AGPL-3.0** (not MIT), the SQL pipeline is **7-layer**, datasource/plugin/region counts, pricing. The stale `.claude/research/launch/blog-intro.md` (MIT, 4-layer) is the cautionary tale. For anything load-bearing, hand off to **`/www-audit`** rather than trust memory.
4. **Don't auto-commit.** Blog work is creative and iterative — show the result (quote the key new/changed lines), let Matt react, commit only when he says so. Keep the dev server up for live reload while he reads; offer to shut it down after.
