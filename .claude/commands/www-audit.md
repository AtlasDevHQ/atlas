# www Accuracy Audit

Cross-reference the marketing site (`apps/www/`) against source code, vendor reality, and the docs site to find stale claims, legal-copy drift, and compliance overstatements. Run before public launches, after pricing/legal changes, or as a periodic sweep.

**Mode:** Read-only audit — generate a report with findings. Fix trivial issues (< 5 lines) directly. File GH issues for larger gaps.

**Why this is its own command:** The www site is *legal* and *marketing* surface. Drift here is more dangerous than docs drift — it can mislead a buyer, misstate a vendor name in a DPA, or claim a certification we don't hold. The verification anchors are different too (billing code, vendor reality, OpenStatus monitors, deployed regions).

---

## Execution Strategy

Run 4 agents in parallel, one per audit domain. Each agent reads www pages and cross-references against the authoritative source.

The www pages live under `apps/www/src/app/<route>/page.tsx` (Next.js App Router). Public assets live under `apps/www/public/`.

Surface as of this writing: `/`, `/pricing`, `/privacy`, `/terms`, `/dpa`, `/aup`, `/security`, `/why-atlas`, `/blog/*`, `/sub-processors/data.json` + `/sub-processors/feed.xml` (machine feeds, no HTML page), plus `/.well-known/security.txt`. There are NO `/sla` or `/status` pages — status is an external link (`NEXT_PUBLIC_STATUS_URL`, default `atlas.openstatus.dev`, wired in `src/components/footer.tsx`). Discover from disk first; don't trust this list.

**Memory-file caveat:** several parts below cite session-memory files (`memory/railway.md`, `reference_openstatus.md`, `feedback_legal_doc_vendor_grep.md`). Those live in user-level memory and may not exist in a remote/fresh session — when absent, fall back to the in-repo sources named alongside them (the `deploy/` directory is the SSOT for deployed services) and note "operator should verify" for anything only memory could answer.

---

## Part A: Pricing Claims (CRITICAL — purchase decisions)

**Pages:** `apps/www/src/app/pricing/page.tsx`, `apps/www/src/app/page.tsx` (landing pricing teaser)
**Source of truth:** `packages/api/src/lib/billing/`, plan enforcement middleware, `/api/v1/billing` route

### Steps

1. Read the pricing page top-to-bottom. Extract every quantitative claim:
   - Plan names (Free, Trial, Team, Enterprise — confirm against billing code)
   - Trial length (currently 14 days per `0.9.0`)
   - Grace buffer percent (currently 10% per docs error-codes — confirm against `plan_limit_exceeded` enforcement)
   - Per-plan query/token caps
   - Per-seat pricing
   - Custom domain / SSO / SCIM gating per tier
   - Self-hosted vs SaaS positioning
2. Walk `packages/api/src/lib/billing/` and the plan-enforcement middleware. Confirm every quantitative claim matches what's actually enforced.
3. Cross-reference:

| Check | How |
|---|---|
| **Plan name drift** | Pricing page name doesn't match billing code identifier → HIGH |
| **Trial length drift** | Page says 14 days; code says something else → CRITICAL |
| **Grace buffer drift** | Page says X%; code enforces Y% → HIGH |
| **Cap drift** | Page lists "100k queries/mo"; code allows different cap → HIGH |
| **Gating drift** | Page says SSO is "Team+"; code requires Enterprise → HIGH |
| **Feature claims** | "Unlimited workspaces" claim ↔ confirm no cap exists |

Memory: PR #1934 (#1929) shipped a "pricing claims match billing code" pass. Verify it stayed clean.

---

## Part B: Legal Pages (CRITICAL — legal correctness)

**Pages:** `apps/www/src/app/privacy/page.tsx`, `terms/page.tsx`, `dpa/page.tsx`, `aup/page.tsx`, `security/page.tsx`
**Sources of truth:**
- Vendor reality (grep + ask user; see `feedback_legal_doc_vendor_grep.md` if available)
- `packages/api/src/lib/db/schema.ts` (audit retention default — grep for the retention setting, don't trust a line number; 365 days per #1927)
- `packages/api/src/lib/auth/` (TOTP MFA per #1925, password reset per #1946)
- Deployed regions — `deploy/` directory (`api`, `api-eu`, `api-apac` services) is the in-repo region list

### Steps

1. **Vendor names** — extract every vendor mention from each legal page (`grep -P 'Anthropic|OpenAI|Stripe|Resend|Railway|...'`). For each: is this a vendor Atlas actually uses today? Don't trust the page — verify against:
   - `packages/api/src/lib/email/delivery.ts` (email transports)
   - `packages/api/src/lib/billing/` (Stripe usage)
   - `ee/src/auth/sso.ts` (IdP providers)
   - `packages/api/src/lib/db/connection.ts` (datasource clients)
   - Memory: `feedback_legal_doc_vendor_grep.md` — prototype copy lists vendors a hypothetical SaaS would use, NOT Atlas's actual stack
2. **Audit retention** — every retention claim must match the 365-day default (#1927). If the page hasn't been updated since 1.3.0, flag it.
3. **MFA / auth flow claims** — TOTP MFA (#1925) and password reset (#1946) shipped in 1.3.0. If legal copy still says "username/password only" or omits MFA, flag.
4. **Effective dates / version numbers** — every legal doc should have an effective date. Stale "Effective March 2025" on a 1.3.0 era doc is a flag (the user just shipped the legal pages design pass in 1.3.0 Bucket 8 — confirm dates moved).
5. **DPA pre-signed PDF** — issue #1922 tracks a pre-signed DPA PDF (originally planned at `apps/www/public/dpa/`; no such directory exists today). Grep the DPA page for any PDF href — if it references a PDF that doesn't exist on disk → CRITICAL (broken link on a contract). If no PDF link exists, check #1922's state before flagging.

Memory: PR #1933 cleaned up "license, regions, retention, AUP, certifications" — verify those didn't regress.

---

## Part C: Compliance & Certification Claims (CRITICAL — legal risk)

**Pages:** All legal + landing + pricing + `/security` (the dedicated trust page — highest-risk surface for this part)
**Source of truth:** **Reality — verify it fresh, don't trust this paragraph.** As of last writing Atlas held no third-party certification; issue #1928 tracks the certification *program*. Check #1928's current state (and `ee/src/compliance/` for what the product actually reports) before judging a claim — the program may have progressed since this command was written.

### Steps

1. Grep all www pages for certification claims:
   ```bash
   grep -rEn 'SOC 2|SOC2|ISO 27001|ISO27001|HIPAA|PCI[ -]?DSS|FedRAMP|Type II' apps/www/src/
   ```
2. For each hit:
   - Is the page promising the certification, or describing the program in progress?
   - "We are SOC 2 Type II certified" → **CRITICAL** drift (false claim)
   - "SOC 2 Type II program in progress, target 2026" → OK if true
   - "SOC 2 Type II report available on request" → CRITICAL if no report exists
3. Check the landing page Trust/Compliance section against #1928's actual state.

Memory: PR #1933 cleaned this once. The risk is regression — a marketing iteration adding a "certified" badge.

---

## Part D: Status & SLA (HIGH)

**Pages:** there are NO `/sla` or `/status` pages on disk. The status surface is the external OpenStatus page linked from the footer (`NEXT_PUBLIC_STATUS_URL` in `src/components/footer.tsx`, default `atlas.openstatus.dev`). Uptime/SLA *claims* may appear on `/pricing`, `/security`, or landing copy — grep for them (`grep -rEn '99\.|uptime|SLA' apps/www/src/`).
**Source of truth:** `memory/reference_openstatus.md` if available (status page IDs, monitor IDs, free-tier limits); otherwise curl the status URL and note "operator should verify monitor inventory"

### Steps

1. **SLA uptime claims** — wherever a "99.9% uptime" or similar claim appears. Verify:
   - The OpenStatus integration is actually monitoring all the endpoints the claim covers.
   - The monitor list matches what's claimed (e.g., if the claim covers "API + Web + Docs" but only API + Web are monitored).
2. **Status link target** — confirm `NEXT_PUBLIC_STATUS_URL` (and its default) resolves with TLS. Check the deployed env value in `deploy/www/` if set there.
3. **Per-region promises** — if any page promises per-region uptime, confirm per-region monitors actually exist (#1936 tracked the OpenStatus tier upgrade — check its current state).

---

## Part E: Domains & Regions (HIGH)

**Pages:** All; especially landing, deploy/install, /pricing, /security
**Source of truth:**
- `deploy/` directory — one subdirectory per deployed service (`api`, `api-eu`, `api-apac`, `web`, `www`, `docs`, `dns`); this is the in-repo SSOT for services and regions (`memory/railway.md` supplements it when available)
- Production domains: `api.useatlas.dev` (+ regional `api-eu`/`api-apac`), `app.useatlas.dev`, `docs.useatlas.dev`, `useatlas.dev`

### Steps

1. **Deployed domain spot-check** — every URL in marketing copy should resolve (or be obviously a placeholder like `your-atlas.example.com`). Watch for:
   - `app.useatlas.dev` — auth/sign-in CTA
   - `api.useatlas.dev` (or regional `api-{region}.useatlas.dev`) — install snippets
   - `docs.useatlas.dev` — every "see docs" link
2. **Region claims** — if landing or pricing page claims "deployed in N regions", confirm N matches reality.
3. **Regional API URLs** — install snippets that show base URL: should they pick US by default? Document the customer choice point if ambiguous.

---

## Part F: Install / Embed Snippets (MEDIUM)

**Pages:** Landing page (hero "Try in 60 seconds"), any embed CTA on pricing
**Source of truth:**
- `create-atlas/templates/` (the `bun create atlas-agent` flow)
- `packages/react/src/index.ts` (the React component name + props)
- `packages/api/src/api/routes/widget.ts` (widget script URL + data attributes)
- npm registry — current published versions (`@useatlas/sdk`, `@useatlas/react`, etc.)

### Steps

1. Every code snippet on www must be runnable. Specifically:
   - `bun create atlas-agent my-app` — flag still works (memory: feedback_useatlas_types_scaffold_gotcha covers value-export gotcha)
   - Script tag widget — `data-api-url`, `data-theme`, etc. attributes match `widget.ts`
   - React component — `<AtlasChat apiUrl="..." />` matches `@useatlas/react` exports
2. Spot-check the npm version refs in any "Installation" snippets — for `0.0.x` semver, `^0.0.N` pins exact (memory: feedback_version_bump_ordering).

---

## Part G: security.txt + Vulnerability Disclosure (HIGH)

**File:** `apps/www/public/.well-known/security.txt`
**Source of truth:** [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116) + open issue #1923 (PGP key)

### Steps

1. Read `apps/www/public/.well-known/security.txt`.
2. Check required + recommended fields:
   - `Contact:` — must be a real address (security@useatlas.dev or similar). Validate format.
   - `Expires:` — must be in the future. **CRITICAL** if expired (RFC 9116 says clients should reject).
   - `Encryption:` — references a PGP key. Open issue #1923 tracks generating + adding it. If `security.txt` references an `Encryption:` line but the key file doesn't exist, **CRITICAL** broken trust.
   - `Policy:` — link to vulnerability-disclosure policy page (resolves?).
   - `Preferred-Languages:` (recommended).
   - `Canonical:` (recommended).
3. Cross-check: if the file says `Encryption: https://useatlas.dev/security.asc` and that file 404s, that's a worse signal than not having a key at all.

---

## Part H: Sub-processor List (HIGH)

**Pages:** `apps/www/src/app/privacy/page.tsx`, `apps/www/src/app/dpa/page.tsx` (rendered tables)
**Data SSOT:** `apps/www/data/sub-processors.json` — the single source consumed by the rendered pages AND the machine feeds at `/sub-processors/data.json` + `/sub-processors/feed.xml` (route handlers under `src/app/sub-processors/`)

### Steps

1. Read `apps/www/data/sub-processors.json`, then confirm the rendered tables on /privacy and /dpa actually derive from it (hand-copied duplicates drift → flag).
2. Each row should be a vendor Atlas actually uses for processing customer data:
   - LLM providers (Anthropic, OpenAI, etc. — only if customers' queries reach them; flag overclaim)
   - Email (Resend or platform email provider per `lib/email/delivery.ts`)
   - Billing (Stripe — only if billing is live)
   - Hosting (Railway per `memory/railway.md`)
   - Database (Postgres on Railway — usually internal, not user data, depending on the customer's deployment)
   - Observability (OTel collectors, Sentry — only if active)
3. **CRITICAL:** Every listed sub-processor must be one Atlas actually contracts with for customer data. Listing an extra vendor is a DPA contract violation.
4. **Sub-processor change-feed** (#1924 — SHIPPED as `/sub-processors/feed.xml` + `data.json` + the webhook subscribe button, `src/components/sub-processor-webhook-button.tsx`). Check the feed routes return valid RSS/JSON built from the SSOT file, and that whatever notification promise the DPA/privacy pages make matches what the feed + webhook actually deliver.

---

## Part I: Cross-Cutting Checks (MEDIUM)

### I1. www ↔ docs ↔ README drift

The same fact (plan tier, region count, plugin count, datasource list) is repeated across:
- `apps/www/src/app/page.tsx` (landing claims)
- `apps/www/src/app/pricing/page.tsx`
- `apps/docs/content/` — ALL THREE docs trees: `docs/` (SaaS, served at `/`), `self-hosted/` (served at `/self-hosted`), `shared/` (mounted in both). www claims about self-hosted ("always free", deploy targets) must match the `self-hosted/` tree specifically
- Root `README.md`
- `apps/docs/content/shared/comparisons/*.mdx` (competitor pages)

Pick 3-4 high-leverage facts (plugin count, datasource count, region count, plan tier names) and verify all sources agree.

### I2. Stale internal package references

```bash
grep -rE '@atlas/(web|cli|mcp|api)' apps/www/src/ -l
```

The www site is an end-user surface — internal monorepo package names should not appear in marketing copy. Public packages are `@useatlas/*`.

### I3. Dead internal links

```bash
# Internal anchor + path links in www MDX/TSX
grep -roE 'href="(/|#)[^"]+"' apps/www/src/app/ | sort -u
```

For each `href="/foo"`, confirm a matching route exists. For each `#anchor`, confirm a corresponding `id="anchor"` exists on the same page.

### I4. Outbound links to docs / docs site

Every `href="https://docs.useatlas.dev/foo"` from www must resolve to a real docs page. Resolution follows the docs three-tree mounts: a root path `/foo` resolves to `apps/docs/content/docs/foo.mdx` OR `apps/docs/content/shared/foo.mdx`; a `/self-hosted/foo` path resolves to `apps/docs/content/self-hosted/foo.mdx` OR `apps/docs/content/shared/foo.mdx`.

---

## Part J: Undocumented or Untracked Surfaces (HIGH)

### J1. Missing/extra pages

```bash
# All routes on www
find apps/www/src/app -name "page.tsx" -o -name "page.mdx"

# Public assets that look user-facing
ls apps/www/public/.well-known/
ls apps/www/public/dpa/ 2>/dev/null
```

For each route, check:
- Does the landing page link to it?
- Does the docs site cross-link to it (where appropriate, e.g. /pricing)?
- Is it indexed by the generated sitemap (`apps/www/src/app/sitemap.ts`)?

### J2. Recently-shipped public-page work

Read `git log --oneline --since="4 weeks ago" -- apps/www/`. For each commit:
- Did the change land cleanly with no follow-up issue still open?
- Open issues referencing apps/www: #1922 (DPA pre-signed PDF), #1923 (PGP key + security.txt), #1924 (sub-processor change feed), #1928 (compliance program), #1936 (OpenStatus upgrade).
- Each open issue is a known gap. Audit findings should align with these — don't re-file existing tracked work.

### J3. Routes that exist but landing doesn't surface

If `apps/www/src/app/foo/page.tsx` exists but the landing page (and main nav) never links to it, it's effectively orphaned. Flag for the user — they may want it linked or want it deleted.

---

## Output Format

```markdown
## Summary
- Total checks: X
- PASS: X | DRIFT: X | MISSING: X | STALE: X

## Critical (Must Fix Before Launch / Sign Anything)
| Section | Page | Issue | Source |
|---|---|---|---|

## High (Fix Soon)
| Section | Page | Issue | Source |
|---|---|---|---|

## Medium (Should Fix)
| Section | Page | Issue | Source |
|---|---|---|---|

## Low (Can Defer)
| Section | Page | Issue | Source |
|---|---|---|---|

## Verified Accurate
- [section]: X items verified against source
```

---

## Execution

Run 4 agents in parallel:

1. **Pricing + Legal** (Parts A + B) — both legal/contract correctness, both are buyer-visible
2. **Compliance + Status/SLA** (Parts C + D) — both compliance-claim correctness; Status uses OpenStatus reference, Compliance uses certification reality
3. **Domains + Install snippets + security.txt** (Parts E + F + G) — all factual claims about technical surface
4. **Sub-processors + Cross-cutting + Discovery** (Parts H + I + J) — vendor accuracy + drift between www/docs/README + orphaned pages

Each agent should:
- Read the page(s) on www
- Read the source-of-truth file(s)
- Perform the cross-reference checks
- Report findings with severity

After agents complete, compile into the output format above. Fix trivial issues (< 5 lines) directly with a branch + PR. File GH issues for larger gaps:

```bash
gh issue create -R AtlasDevHQ/atlas --title "www: <description>" --body "<details>" --label "<type>,area: web"
```

Use `area: web` for www-page issues, `area: deploy` for OpenStatus / domain / region issues, `area: docs` only when the fix is in `apps/docs/`.
