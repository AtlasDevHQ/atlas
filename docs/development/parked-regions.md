# Parked regions — turning one off, and turning it back on

`eu` and `apac` are **parked**: built, shipped, tested, and switched off so two
always-on API processes stop billing. This page is the procedure for both
directions.

It exists because the config comment's claim — *"un-parking is deleting the
flag"* — is not true on its own. Deleting the flag is one of seven steps, and two
of the others are ordering constraints that break prod if you get them backwards.

## Why they are parked

Measured against prod on 2026-09-01 (Railway CLI + dashboard, billing period
Jul 28 – Aug 28):

| | |
|---|---|
| Project bill | **$38.87** |
| Memory share | **90%** ($35.17) |
| CPU / egress / volume | $2.06 / $0.31 / $1.54 |
| `api-eu` + `api-apac` + their int-postgres + backup-scratch | **$16.65/mo — 43%** |

Railway bills memory per GB held resident per minute, so an idle region costs the
same as a busy one — an always-on API process holds ~0.6 GB whether or not
anyone calls it. What the two regions were serving at the time:

| region | users | conversations |
|---|---|---|
| `eu` | 1 (`admin@useatlas.dev`, seeded) | **0** |
| `apac` | 2 (seeded admin + one external signup, 2026-08-24) | **0** |

## What "parked" means mechanically

`selectable: false` + `requestable: true` in `deploy/api/atlas.config.ts`.

The two flags are **not** redundant, and this is the distinction the whole
mechanism turns on:

- `selectable: false` **alone** → *internal*. The `staging` arm. Exists for
  `RegionGuardLive` and routing; must never be shown to a customer.
- `+ requestable: true` → *parked*. Built and shippable, switched off to save
  money. Advertised as available on request, so the demand signal still arrives.

`isRegionRequestable` (`packages/api/src/lib/residency/picker.ts`) requires both.
Inferring requestability from non-selectability alone would advertise an
internal hostname in the signup funnel.

## ⚠️ The two ordering constraints

Both directions have one, and they point opposite ways.

**Parking — config first, then scale down.** `api-eu` deploys from the `prod`
branch. Until prod serves the parked config, the live signup picker still offers
Europe; scaling the service down first means a prospect picks it and hits a dead
host.

**Un-parking — scale up first, then config.** The reverse, for the same reason:
ship a config that offers Europe before `api-eu` is actually serving and you have
advertised a dead host to every visitor.

**And before parking a region that holds real data: migrate it to `us` first.**
See the reachability note below — after parking there is no funnel that can reach
those accounts.

## Reachability while parked (read this before parking a populated region)

With one selectable arm the US region-map has a single entry, so `resolveRegion`
(`packages/web/src/lib/login-frontdoor.ts`) takes its `map.regions.length === 1`
short-circuit and returns `{outcome: "single", region: "us"}` **without probing**.

A dormant `eu`/`apac` account is therefore **not** told "unavailable" — it is
silently **routed to US**, where it does not exist, and fails sign-in as an
unknown account. A wrong answer, not an outage, which is the worse of the two.

The admin console cannot rescue it either: `otherRegions` in
`packages/web/src/app/admin/residency/page.tsx` derives from
`buildAvailableRegions`, which holds only `us` while the others are parked, so
`canMigrate` is false.

Parking `eu`/`apac` was acceptable **only** because both held 0 conversations.

## Un-parking a region

1. **Scale the service up first** and confirm it is serving:
   ```bash
   railway redeploy --service api-<region>
   curl -fsS https://api-<region>.useatlas.dev/api/health
   ```
   Two sibling services matter, and they are in **different** states after the
   2026-09-01 park — check both:

   ```bash
   railway redeploy --service <region>-int-postgres   # still EXISTS (left up); just redeploy
   ```

   `backup-scratch-<region>` does **not** exist any more — it was **deleted**,
   not scaled down, so un-parking has to **recreate** it:

   - a Postgres service from `ghcr.io/railwayapp-templates/postgres-ssl:18.3`,
     with a volume at `/var/lib/postgresql/data` (match `backup-scratch-us`,
     which is still live and is the working reference),
   - then point that region's `ATLAS_BACKUP_VERIFY_SCRATCH_URL` at it.

   It must be a **genuinely disposable** database — full-restore verification
   WIPES it on every run (`ee/src/backups/verify.ts`), so it must never point at
   the region's real internal DB.

   ⚠️ Skipping this does not fail. The region's `scheduled_backup` fiber still
   runs, but verification silently degrades from full-restore to a `pg_dump`
   header check — the weaker guarantee #4457 was built to replace. The `/health`
   `backups` component is the only tripwire; check it once the region is up.
2. **Delete `selectable: false` and `requestable: true`** from that region's arm
   in `deploy/api/atlas.config.ts`.
3. **Update `deploy-config-residency-regions.test.ts`** — it pins the parked
   count and the parked/advertised split, deliberately, so this change has to
   come here and say so.
4. **Add the arm back to `SELECTABLE_REGIONS`** in
   `packages/api/scripts/generate-apex-discovery.ts`, then regenerate:
   ```bash
   cd packages/api && bun scripts/generate-apex-discovery.ts
   ```
   This is the **agent-facing** region directory served at
   `useatlas.dev/.well-known/atlas-regions.json`, and it is a separate list from
   the browser picker for a reason: every entry is a host an agent will actually
   call, so a parked region must not appear at all — there is no "ask a human"
   affordance in a machine-readable directory. `assertRegionsMatchConfig()`
   fails generation if this list and the config disagree in either direction,
   which is how CI catches a half-done park or un-park.
5. **Restore the copy** that parking made conditional. Grep is the check, not
   memory — every site that named the region count:
   - `apps/www/src/app/pricing/pricing-content.tsx` (tier bullets + the
     `CELL_LABEL_OVERRIDES` table)
   - `apps/www/src/components/landing/deploy.tsx`
   - `apps/www/src/app/privacy/page.tsx` — the residency paragraph. **Treat this
     one as a policy change, not copy**: it states where customer data lives.
   - `apps/docs/content/docs/guides/signup.mdx`
   - `apps/docs/content/docs/guides/billing-and-plans.mdx`
   - `apps/www/src/app/pricing/pricing-content.tsx` →
     `REQUESTABLE_REGION_LABELS`, if the region should no longer deep-link
6. **Merge and release to prod** — the config only takes effect once the `prod`
   branch carries it.
7. **Verify the funnel end to end** with `/verify-prod-signup`, which exercises
   region routing and the cold-start answer per region.

## Parking a further region

The same list in reverse, plus: migrate any real workspace to `us` **before**
step 1, and scale the service down **after** the config reaches prod.

## What parking does NOT change

ADR-0024 stands in full. Regional identity isolation is **built** and stays
built. This is not the *"dark-launch US-only, ship regional identity
post-launch"* option that ADR rejected — that one deferred the **engineering**,
and the rejection reasoned only about that (*"retrofitting
identity-regionalization after real EU customers exist is the migration that
actually hurts"*). The engineering shipped. This defers only the **spend**, and
the ADR's own Consequences bless the mechanism: *"the policy lives on in the
deploy config's `selectable: false`."*

An EU customer is one flag plus a redeploy away, which is the property ADR-0024
was protecting.
