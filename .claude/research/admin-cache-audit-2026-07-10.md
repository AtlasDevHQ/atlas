# Admin Cache — elevation audit (2026-07-10)

**What this is:** prep for a `/grill-with-docs` session on elevating the **admin cache surface** — the query-result cache (`packages/api/src/lib/cache/`), its one consumer (`executeSQL`), the admin page (`packages/web/src/app/admin/cache/page.tsx`), and its routes (`packages/api/src/api/routes/admin-cache.ts`). Not a plan; a briefing. The grill, PRD, and issue slicing happen downstream with the user in the loop.

**Dimensions run (4, in parallel):**
1. End-user UX of the admin page.
2. The agent/AI path through the cache (executeSQL hit/write seam, what a chat user/agent learns).
3. Backend cache engine correctness + configuration semantics.
4. Multi-tenancy / SaaS deploy-mode / ops / docs / wire contract.

**Live product:** could **not** be driven — Docker is unavailable in this environment, so there is no dev server or Playwright pass. Every finding is anchored to source read at the cited `file:line`. Screenshots were not captured.

**Hand-verified anchors:** all four HIGH findings and both filed issues were re-read (or reproduced) at their cited lines by the collating agent — marked `verified` below. The nested-claims key bug (H1) was reproduced with a standalone script confirming the collision.

**Filed this run** (Step 4 — broken today AND fix invariant under the grill's outcome):
- **#4532** — `buildCacheKey` replacer-array erases nested RLS claims from key material (latent cross-tenant row serve). [H1]
- **#4533** — flush audit row uses fire-and-forget `logAdminAction` on a surface that declares "attribution is the security control". [M-audit]

Everything else stays in this doc for the grill — the correct fix is entangled with a design decision the elevation exists to settle, so filing it standalone would pre-decide the design.

---

## Verdict

**Strong engine, unfinished cockpit — and the engine's best idea has one gap.**

Preserve these wholesale; they constrain the grill as much as the problems do:

- **Org/claims-scoped keys by construction** — `packages/api/src/lib/cache/keys.ts:14-30` hashes `sql + connectionId + orgId + sorted-claims` with NUL separators, so cross-tenant cache **content** sharing is impossible by design and `cache.test.ts:418-446` pins it. (H1 is a gap *inside* this otherwise-sound design — the nested-claim case — not a refutation of it.)
- **Governance-ordered cache hits** — `packages/api/src/lib/tools/sql.ts:1896-1900`: the cache check runs *deliberately after* the approval gate, and hits re-apply the **current** row limit (#3406) and PII masking (`sql.ts:1931-1956`) rather than what was stored. EE masking is non-mutating by contract (`ee/src/compliance/masking.ts:429`, `{ ...row }` copy), so hit-path masking can never corrupt the shared entry, and a masking/limit change propagates to cached data instantly. A cache hit cannot bypass approvals, masking, or a lowered cap.
- **#3616 `executionMs` replay** — `types.ts:10-18` + `sql.ts:1915-1924`: hits carry the original query's real cost into `audit_log.duration_ms` instead of `0`, with graceful degradation for legacy/external entries, so `/analytics/slow` averages stay honest. Tested on both halves (`sql-cache-audit.test.ts`).
- **Fail-open seams with no silent swallows** — cache write failure never fails the query (`sql.ts:1410-1412`), a failed audit write never costs the hit (`sql.ts:1907-1930`, with a why-comment), backend-swap flush logs rather than throws (`index.ts:67-73`). Consistent with the repo error-handling rules.
- **An honest, self-documenting flush docblock** — `admin-cache.ts:1-15` states the process-global blast radius plainly instead of hiding it. Most findings below are refinements of a decision that was at least written down.
- **Full shared-admin-plumbing compliance + a11y hygiene** — `useAdminFetch`+schema, `useAdminMutation` with `invalidates: refetch`, `MutationErrorSurface`, `AdminContentWrapper`, registered `feature="Cache"`; `role="status" aria-live="polite"` on the flush banner and `aria-label` on both progress bars; the load-bearing Safari/Firefox disabled-button span-wrapper comment (`page.tsx:264-266`). No hand-rolled fetch anywhere.

**Where the problems live: at the seams, and in the cockpit.** The cache engine is correct in isolation; what's unfinished is (a) the **configuration seam** — knobs are env/config-file only, pinned on SaaS, frozen at first use, with no settings-registry home, so the admin page tells SaaS admins to set an env var they cannot set; (b) the **staleness seam** — a hit can serve up-to-TTL-old data, but neither the chat user, the agent, nor the admin is told the age, and there is no bypass; (c) the **governance-freshness seam** — RLS (unlike masking/limits) is baked into cached rows and never invalidated on config change, and plugin hooks are skipped on hits; (d) the **tenancy seam** — flush is fleet-wide, the stats are fleet-wide, and neither is disclosed in the UI; and (e) the **cockpit** — the page offers lifetime, flush-immune counters and one nuclear button, with no windowing, no entry visibility, and no per-scope invalidation.

No CRITICAL: nothing is exploitable-for-data-leak in the **default** SaaS (managed-auth) configuration — H1's leak is shielded incidentally, and the RLS staleness is a transient window on an admin config change. The ceiling is HIGH.

---

## Ranked findings

### HIGH

#### H1 — `buildCacheKey` replacer-array erases nested RLS claims → latent cross-tenant row serve · `verified` · filed #4532
**Anchors:** `packages/api/src/lib/cache/keys.ts:24`; `packages/api/src/lib/rls.ts:33-40`; `packages/api/src/lib/auth/managed.ts:169`; `packages/api/src/lib/cache/__tests__/cache.test.ts:430-446`.
`JSON.stringify(claims, Object.keys(claims).sort())` passes the sorted keys as a **replacer array**, which applies at every nesting level. Nested claim objects serialize to `{}` — reproduced: `{ app_metadata: { org_id: "org-42" } }` and `{ ...: "org-99" }` both stringify to `{"app_metadata":{}}`, identical key material. Nested claim paths are supported RLS config (`resolveClaimPath` dot-paths). Cached rows are RLS-filtered at write time (injection is live-path only), so the claims-in-key is the *only* per-user discriminator; when the RLS discriminator is nested, two users on the same org+connection+SQL collide and user B is served user A's filtered rows for up to TTL. **Shielded incidentally** by managed-auth spreading top-level `sub` into claims — simple-key mode with nested claims re-opens it. **Fix (invariant):** recursive canonical serialization + a nested-claims regression test. Full detail in #4532.

#### H2 — Deploy-mode-blind cockpit: SaaS admins told to set an env var they can't; no settings-registry knob; ttl/maxSize frozen at first use · `verified`
**Anchors:** `packages/web/src/app/admin/cache/page.tsx:163-169`; `packages/api/src/lib/cache/index.ts:36-42, 47-55, 57-60`; `deploy/api/atlas.config.ts:1112-1116`; `packages/api/src/lib/settings.ts` (no `ATLAS_CACHE_*` key — only unrelated catalog/rate-limit/health TTLs at `:1367, :1410, :1492`); `packages/api/src/lib/config.ts:1565-1574`.
Three stacked problems, all verified:
1. **Wrong copy in both modes when a config block exists.** The disabled notice says *"Set `ATLAS_CACHE_ENABLED=true` to enable."* But `isCacheEnabled()` short-circuits `if (config?.cache) return config.cache.enabled` — the env var is ignored whenever `atlas.config.ts` has a `cache:` block, which SaaS **always** does (pinned `{ enabled: true, ttl: 300_000, maxSize: 1000 }`). A SaaS workspace admin cannot set env vars at all; the page has zero `useDeployMode` awareness (the sibling `sandbox/page.tsx:170-219` shows the idiom).
2. **No runtime knob anywhere.** CLAUDE.md's SaaS-first rule: *"A SaaS operator or workspace admin must never have to redeploy to change configuration. The default home for a new knob is the settings registry."* There is no query-cache entry in `settings.ts`, so tuning/disabling the cache on SaaS requires editing `deploy/api/atlas.config.ts` and redeploying all three regions — during an incident (e.g. serving stale rows after a customer ETL run) that is the only lever.
3. **ttl/maxSize freeze at first `getCache()`.** The backend is constructed once (`index.ts:48-53`); config reload flushes entries (`config.ts:1566-1568`) but never recreates the backend, so new ttl/maxSize never apply until process restart, undocumented. Only `enabled` is truly dynamic (`index.ts:57-60`), yet the comment there ("Re-reads config on each call for dynamic toggling") invites the false belief that ttl/maxSize are too.
**Fix direction (grill decides shape):** platform- (and possibly workspace-) scoped `ATLAS_CACHE_ENABLED/TTL/MAX_SIZE` in the settings registry with backend re-creation/resize on change; deploy-mode-branched page copy.

#### H3 — RLS is the sole governance layer baked into cached rows, and an RLS config change never invalidates the cache · `verified`
**Anchors:** `packages/api/src/lib/tools/sql.ts:1094-1125` (SaaS settings-based RLS overlay, hot-reload via `getSettingAuto`); `flushCache` call sites — `config.ts:1567-1568`, `residency/migrate.ts:299-300`, `admin-orgs.ts:746`, `admin-cache.ts:95` (grep-confirmed: **none** on the RLS/settings-write path).
Every other governance layer is re-evaluated on the hit path (whitelist/validation, approval gate, masking, current row limit). RLS is the exception — it is filtered into the rows at write time, and only the claims hash in the key distinguishes entries. On SaaS an admin **enabling or tightening RLS via the settings overlay** (hot-reload by design) does **not** flush the query cache, so pre-RLS unfiltered rows keep serving under the same key for up to TTL (default 5 min; `ATLAS_CACHE_TTL` unbounded). The operator believes RLS is enforced the instant they save; a business user sees rows the new policy should hide.
**Not filed** — the correct fix forks (flush on any `ATLAS_RLS_*` settings change, mirroring `config.ts:1567`, **vs** hashing the resolved RLS config into the cache key), and that fork is precisely a grill question about what governance is baked-in vs re-evaluated per hit. A narrow flush-on-RLS-settings-write patch is available independent of the grill if the user wants the window closed immediately.

#### H4 — Plugin `CacheBackend` is synchronous — can't support the advertised Redis; type-laundered cast turns a wrong-shape backend into fleet-wide phantom hits · `verified`
**Anchors:** `packages/api/src/lib/cache/types.ts:33-40` (sync `get(): CacheEntry | null`); `packages/plugin-sdk/src/types.ts:400-407, 505-509` ("Optional external cache backend (e.g. Redis)"); `packages/api/src/lib/effect/services.ts:1002-1006` (`plugin.cacheBackend as ...CacheBackend`); `packages/api/src/lib/plugins/__tests__/effect-lifecycle.test.ts:632-663`; `packages/api/src/lib/tools/sql.ts:1906`.
The interface is fully synchronous, so the "e.g. Redis / Memcached" docblocks describe something structurally impossible without blocking the event loop. The wiring casts any shape through (`services.ts:1004`), and `setCacheBackend` (`index.ts:63-74`) does zero shape validation. The repo's own test proves the hazard: the registered stub is **async** (`get: async () => undefined`) with a **wrong stats shape** (`{ hits, misses, size }` — missing `entryCount/maxSize/ttl`), cast via `as never`. A plugin copying that shape makes `getCache().get(cacheKey)` return a **Promise (always truthy)** → every query becomes a phantom "cache hit", `cached.rows` throws, SQL execution breaks fleet-wide the moment the plugin loads.
**Fix direction (grill / #2055):** make the `CacheBackend` contract async (and await the two call sites), or add a runtime shape/thenable probe in `setCacheBackend`; fix the stub + the "e.g. Redis" docblocks. This is the external-backend seam tracked by **#2055**.

### MEDIUM

#### M-audit — flush audit row is fire-and-forget on an "attribution is the security control" surface · `verified` · filed #4533
**Anchors:** `admin-cache.ts:9-14, 101-106`; `packages/api/src/lib/audit/admin.ts:128-158`. The docblock leans on the `cache.flush` row as the control, but logs it with fire-and-forget `logAdminAction` (`internalExecute`, circuit-breaker) — during a circuit-open window the flush succeeds with no committed row. The codebase already has `logAdminActionAwait` for exactly "surfaces where the audit row **is** the security control." Fix is invariant → filed #4533.

#### M1 — Hit/miss counters are lifetime-since-boot: flush-immune, no window, no reset
**Anchors:** `packages/api/src/lib/cache/lru.ts:14-15, 66-68` (`flush()` clears entries, **not** counters — pinned intentional by `cache.test.ts:384-395`); `admin-cache.ts:79-82`. The page's "hit rate" is a lifetime average that (a) doesn't visibly move after a flush (admin flushes, refreshes, sees the same 84% → concludes flush failed), (b) asymptotically freezes so even a total cache failure barely moves it, (c) can't answer "is my TTL right *now*?". No `reset-stats` action exists; counters also silently zero on plugin backend swap. **Fix direction:** include a `since` (backend-creation) timestamp in `CacheStats` and label it; better, a windowed rate or an explicit reset affordance.

#### M2 — Fleet-wide flush blast radius: any org admin can cold every tenant in the region at ≥60 rpm, and the UI shows/deletes the fleet-wide count without disclosure
**Anchors:** `admin-cache.ts:9-14, 86-108`; `packages/api/src/lib/auth/middleware.ts:174-180` (admin bucket floor 60 rpm — the only throttle); `page.tsx:255-257, 285-288` (dialog says "remove {entryCount} entries" where `entryCount` is fleet-wide). Keys are org-scoped so there's **no confidentiality/integrity impact** — this is a perf/noisy-neighbor + mental-model issue, honestly MEDIUM not CRITICAL. But one admin can flush once per second forever (every tenant's queries cold, all load pushed to customers' DBs), and the confirm copy implies self-scope. **Fix direction:** per-org key index (org-scoped flush) or a flush cooldown + revert flush-only to `platform_admin`; one blast-radius sentence in the dialog meanwhile. Root-fixable via #2055.

#### M3 — Staleness is invisible and inescapable: no age surfaced, no bypass, and the agent isn't told the cache exists
**Anchors:** `packages/api/src/lib/cache/types.ts:8` (`cachedAt` exists); `sql.ts:1969-1980` (hit response drops it); `packages/web/src/ui/components/chat/sql-result-card.tsx:181` (bare "cached" chip, no age); tool schema `sql.ts:2504-2527` (no freshness flag); `descriptions.ts` (no cache mention). A hit can serve 5-min-old data; the agent sees only `cached: true` with no age and no tool-description guidance, so it can't caveat "how many orders *right now*?"; the user sees a bare chip; "refresh that number" regenerates the same SQL → same key → same stale rows for the full TTL. `cachedAt` is already on the entry, so surfacing age is cheap. **Fix direction:** add `cacheAgeMs` to the hit response, render "cached · 3m old", document `cached`/age in the tool description, optionally a governance-safe `bypass-cache` input flag.

#### M4 — Flush of a disabled cache renders a green success banner ("Flushed 0 entries")
**Anchors:** `page.tsx:98-113` vs `admin-cache.ts:91-93, 57`. The backend returns **HTTP 200** with `{ ok: false, flushed: 0, message: "Cache is disabled" }`, but the page types the response as `useAdminMutation<{ flushed?: number }>` (dropping `ok`/`message`) and branches on `useAdminMutation`'s HTTP-level `result.ok`, not the body's. A refused flush shows in the emerald success banner. Reachable via the 30 s stale window + `cacheEnabled()` re-reading config mid-session. **Fix direction:** type the full `{ ok, flushed, message }` and branch `data.ok === false` into an error surface (and arguably the backend shouldn't 200 an `ok:false`).

#### M5 — `ATLAS_CACHE_*` env vars silently dead under a config-file `cache` block; Zod defaults beat explicit env
**Anchors:** `config.ts:593-600` (schema, all fields `.default`, block `.optional`), `config.ts:951-963` (env derivation), `index.ts:22-24, 30-32, 38-41`. Traced: no config file → env works (via a full env-built block); config file **without** a cache block → env fallbacks are live; config file **with** a cache block → env ignored entirely, and a *partial* block like `cache: { enabled: true }` gets `ttl/maxSize` from Zod defaults that beat an operator's explicit `ATLAS_CACHE_TTL`, with no warning. Env parsers also silently coerce bad values to defaults where the same value in a config file fails Zod validation. Docs set the trap (see M9). **Fix direction:** merge env over file-defaults explicitly, or warn at boot when `ATLAS_CACHE_*` is set but shadowed.

#### M6 — `maxSize` counts entries, not bytes: no memory bound, and expired entries hold memory / inflate the fill gauge until read
**Anchors:** `lru.ts:32-36` (TTL expiry only on read — no sweeper), `lru.ts:49-57` (entry-count eviction), `types.ts:5-9` (entry holds full `rows`), `sql.ts:1403-1409` (caches full result unconditionally). Default geometry: 1000 entries × up to 1000 rows each, each row an unbounded record — hundreds of MB to multi-GB of heap in a shared multi-tenant process, zero byte accounting, no per-entry cap. Never-re-read expired entries sit at full size until capacity eviction reaches them and inflate `entryCount` (the admin "fill" gauge shows "950/1000" of mostly-expired corpses after a quiet weekend). Eviction loop itself is correct. **Fix direction:** approximate-byte budget + per-entry size cap at the write seam; optional lazy sweep before `stats()`.

#### M7 — No visibility into *what* is cached; the only management action is nuclear, and per-scope invalidation is structurally impossible
**Anchors:** `page.tsx:130, 248-299`; `packages/api/src/lib/cache/types.ts:36` (`delete(key)` exists, zero external callers); `keys.ts:14-30` (opaque SHA-256, no reverse index); `admin-orgs.ts:746` + `residency/migrate.ts:297-306` (both go nuclear because per-org purge can't be expressed). The page title promises "management" but delivers one destructive button. An admin whose real job is "one dashboard's number is stale" must flush the entire fleet's cache. **Fix direction:** a `Map<orgId, Set<key>>` alongside the LRU → org-scoped flush, per-connection flush, and org-bucketed stats all fall out (same index that fixes M2/L13). Redis/#2055 is the external-backend version.

#### M8 — `stats().ttl` reports a constructor-frozen value nothing enforces; a config reload makes the admin page lie
**Anchors:** `lru.ts:17-21, 32, 76` (`defaultTtl` used only in `stats()` + validation; expiry uses `entry.ttl`; `set()` never applies it), `index.ts:85-87` (`getDefaultTtl()` re-reads config per write), `config.ts:1565-1574`. Actual entry TTL comes from the writer per-write, so after a reload that changes `cache.ttl`, new entries get the **new** ttl while `stats().ttl` (hence the admin page) reports the **old** one. `defaultTtl` on the backend is decorative. **Fix direction:** have `stats()` report `getDefaultTtl()` at the seam, or recreate/resize the backend on reload (couples with H2.3).

#### M9 — Docs inaccuracies + audience misplacement
**Anchors:** `apps/docs/content/docs/guides/caching.mdx:24, 71-77, 99, 11`; `apps/docs/content/docs/guides/admin-console.mdx:484, 487-498`; correct baseline at `apps/docs/content/self-hosted/deployment/cache-configuration.mdx` and `shared/reference/config.mdx:339-359`. Specific errors: (1) `caching.mdx:24` claims hits log "0ms query duration, marked `cached:true` in audit logs" — both false since #3616 (real `executionMs` replayed; `cached` is on the tool response, not the audit row). (2) Env-var tuning guidance (`caching.mdx:99`, `admin-console.mdx:484`) sits in the **SaaS-audience** `docs/` tree, telling hosted readers to set vars they can't (and which the SaaS pin ignores) — belongs in `self-hosted/`. (3) Neither page discloses the process-global-across-all-workspaces flush blast radius. (4) Nobody documents that ttl/maxSize changes need a restart (H2.3). **Best fixed in the grill's docs pass** (`/grill-with-docs` updates docs inline) rather than pre-filed.

#### M10 — `lib/cache/index.ts` (config-resolution singleton) has essentially zero direct test coverage
**Anchors:** `packages/api/src/lib/cache/__tests__/cache.test.ts` (LRU + keys only, no `../index` import); `admin-cache.test.ts:48-59` (mocks the whole cache module); `effect-lifecycle.test.ts:632-663` (only real-`index.ts` consumer, and its stub violates the contract — H4). The LRU is excellently tested; unpinned: `getCache()` freeze semantics, the `isCacheEnabled/getCacheTtl/getCacheMaxSize` precedence matrix (M5), the `getDefaultTtl`-vs-`stats().ttl` divergence (M8), `setCacheBackend` old-backend flush + failure logging, reload-flush wiring, the admin route against a **real** backend. **Fix direction:** a `lib/cache/__tests__/index.test.ts` using `_resetCache()` + `mock.module` on config — the seam (`index.ts:89-92`) was built for it and never used for its purpose.

#### M11 — Cache hits bypass plugin `beforeQuery` governance and skip `afterQuery` / metrics entirely
**Anchors:** `sql.ts:1900-1996` (cache short-circuit) vs `sql.ts:2000-2043` (`beforeQuery` dispatch, *after* the cache check) and `sql.ts:1430-1441` (`afterQuery`, live path only). The pre-step comment promises hits "never bypass governance" — true for approval/whitelist/masking, but `beforeQuery` is also a governance seam (it can reject or rewrite). On a hit neither hook runs: a plugin that starts rejecting a query class (quota, incident lockdown) is bypassed for any already-cached SQL for up to TTL; `afterQuery` egress/notification consumers and `connections.recordQuery`/SLA metrics + pattern-learning counts never see hit traffic (skewing `/analytics` and learned patterns toward cold queries). **Fix direction (grill):** document the carve-out at the pre-step type with H3's rigor, or move rate-limit-slot + `beforeQuery` above the cache check.

### LOW

| # | Finding | Anchor | Who / scenario |
|---|---------|--------|----------------|
| L1 | Fanout hardcodes `cached: false` / `maskingApplied: false`, discarding per-leg cache signals · `verified` | `sql.ts:2487-2498` (`cached: false,` at :2493), member map `:2450-2456` | Chat user / agent — an all-hit fanout reports `executionMs:0` and `cached:false`, so stale data renders as a fresh 0-second query |
| L2 | Fresh-boot zero state reads as failure ("0.0% hit rate" over an empty bar, "across 0 total queries") | `page.tsx:115, 179, 184-188` | Trial admin — first visit looks broken |
| L3 | Disabled cache still renders nonsense stat cards ("Entries 0 / 0", "TTL 0ms") below the amber banner | `admin-cache.ts:76`; `page.tsx:224-244` + `formatTtl` `:47-48` | Any admin — placeholder zeros dressed as telemetry |
| L4 | Disabled-button tooltip is mouse-only (span has no `tabIndex`, button no `aria-describedby`) | `page.tsx:262-274` | Keyboard/AT users never learn *why* flush is disabled |
| L5 | Hand-rolled web Zod schema + loose `z.record(z.string(), z.unknown())` OpenAPI stats schema (flush response *is* typed) — repo norm, not an outlier (263 `z.record` uses; 2/40 pages import `@useatlas/schemas`) | `page.tsx:34-43`; `admin-cache.ts:39` vs `:57` | Any field rename trips every viewer's strict parse into `schema_mismatch`; SDK gets `Record<string,unknown>` for stats |
| L6 | `isEmpty={!data}` empty state is unreachable dead UI (`data` is null only on error; backend always returns a full object) | `page.tsx:157-159`; `use-admin-fetch.ts:156` | Maintainer wastes time styling a phantom state |
| L7 | Jargon ("TTL", "Fill") shown bare though `StatItem` already supports a `description` prop that's unused | `page.tsx:63-84` vs `:224-238` | Non-engineer workspace admin |
| L8 | Exact-hash keys + trim-only normalization → hits mostly accidental (agent regenerates SQL nondeterministically); nobody documents that low hit-rate is structural | `keys.ts:21`; `sql.ts:1683, 1905` | Operator misreads low hit-rate as a fault. Note: key is built before auto-LIMIT/RLS — correct |
| L9 | `orgId ?? ""` + undefined claims collapse to `sql\0connId\0\0`; isolation then rests entirely on `connectionId`, and that invariant is unstated (`keys.ts` header overclaims "by construction") | `keys.ts:23-24`; `sql.ts:1902-1905` | Safe today (single-tenant when orgId absent); latent — one sentence + a undefined-vs-undefined test |
| L10 | Dashboard/metrics/REST paths never cache (neither read nor write); deliberate via the discriminated pre-step union but the *why* and the stats-reflect-agent-traffic-only consequence are undocumented | `sql.ts:1578-1587, 2157-2164, 1899-1900` | Operator interpreting the hit-rate; one doc sentence closes it |
| L11 | Flush count is read-then-flush (racy; meaningless for a shared external backend); disabled-branch early-return refuses to clear a still-resident cache | `admin-cache.ts:91-95`; `index.ts:77-82` | Cosmetic in-process; call `flushCache()` even in the disabled branch |
| L12 | Attribution asymmetry: the `cache.flush` row is scoped to the flusher's org, so victim tenants can't see who cold-started them (only the operator can) | `admin-actions.ts:192`; `platform-actions.ts` | Docblock's "always attributed" holds only at operator level |
| L13 | Stats endpoint exposes region-fleet-wide `hits/misses/entryCount` (+ config `maxSize/ttl`) to any tenant admin — weak cross-tenant activity signal | `admin-cache.ts:6-7, 78-82`; `types.ts:21-27` | Resolves itself if stats become org-bucketed (M7) |
| L14 | Cache correctness silently depends on `numReplicas:1`; the replica-cap rationale (`deploy/README.md:67-72`) cites only MCP sessions, so a future cap-lift (post-#2069) breaks stats/flush with no guard | `deploy/api/railway.json:35-36`; `index.ts:44-55` | Prospective — add the cache to the cap rationale + #2069 checklist; #2055 is the real exit |

---

## Grill agenda

The design questions the findings force — the grill walks this list. Phrased as questions, not solutions.

1. **Where do the cache knobs live, and at what scope?** Settings registry (hot-reload, per-workspace TTL?) vs env/config pin. If the registry, does `maxSize` need a resizable/recreatable backend, and does `ttl` need to un-freeze `stats().ttl`? (H2, M8)
2. **What does a cache hit surface — to the user, and to the agent?** An age / "as-of" ("cached · 3m old")? A freshness/bypass affordance? Should the executeSQL tool description even tell the model caching exists so it can caveat time-sensitive answers? (M3)
3. **What governance is baked into cached rows vs re-evaluated per hit?** Today masking + row-limit re-run on hits but RLS is frozen in and plugin `beforeQuery`/`afterQuery` are skipped. Should RLS hash into the key, or flush on RLS change? Should hooks run on hits? What's the principle? (H3, M11)
4. **What is the invalidation model?** Nuclear-only today. Per-org / per-connection / per-query invalidation all need one `orgId → keys` index — the same index that org-scopes flush, org-buckets stats, and defuses the cross-tenant blast radius. Is that index the move, or is Redis/#2055 the external-backend exit? (M2, M7, L13)
5. **What does "hit rate" mean, over what window?** Lifetime-since-boot, flush-immune, no reset today. Windowed rate? A reset action? Per-workspace counters? A sampled-at timestamp + refresh affordance? (M1)
6. **What should the admin page *do* beyond stats + one nuclear button?** Entry inspection, per-scope flush, honest zero/disabled/empty states for a trial admin's first visit? (M4, M7, L2, L3)
7. **What is the multi-tenant flush contract?** Is fleet-wide flush at ≥60 rpm, deleting other tenants' entries, acceptable — or does flush need org-scoping / a cooldown / platform-admin-only, and disclosure in the dialog? (M2, L12)
8. **Should the plugin `CacheBackend` contract become async** so the advertised Redis/Memcached is actually buildable — and should `setCacheBackend` validate shape? This is the #2055 external-backend seam. (H4)
9. **What is the config-precedence contract**, and should the env-shadowed-by-config-block case warn instead of silently winning? (M5)

---

## Handoff

**Next: run `/grill-with-docs` with this doc.**

The grill should settle the seam decisions (agenda 1–4 above) before any PRD — the cache knobs' home (settings registry vs pin), the staleness contract, the governance-freshness principle, and the invalidation/index model are entangled and shouldn't be sliced piecemeal. Two fix-invariant bugs are already filed and can proceed independently of the grill: **#4532** (nested-claims key bug) and **#4533** (flush audit-await). The docs-accuracy cluster (M9) is best swept during the grill's inline docs pass rather than pre-filed.
