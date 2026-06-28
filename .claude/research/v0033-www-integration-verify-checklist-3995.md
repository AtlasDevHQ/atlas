# v0.0.33 — www prod-live integration verify checklist (#3995, WS4 HITL)

> Operator aid for [#3995](https://github.com/AtlasDevHQ/atlas/issues/3995). The
> agent-doable count-reconciliation half already shipped (#4071); what remains is **prod-OAuth
> ground truth** — only you can confirm which chat OAuth apps are actually registered and
> functional in prod. This checklist tees that up: it lists every www claim, the repo-side
> wiring status, and the columns only you can fill. Hand the verdicts back and I'll adjust copy.

## The four ACs and where each stands

| AC | Status |
|----|--------|
| Chat-platform claims match **verified prod-live** status | ⏳ needs your prod-OAuth verification (this doc) |
| Plugin/integration counts internally consistent + accurate | ✅ #4071 reconciled counts; re-confirm after copy edits |
| Data-residency claim asserted only once #3967 lands | ✅ #3967 shipped (`v0.0.31`); residency claim is now truthful — keep it |
| SOC 2 / ISO copy unchanged | ✅ leave as-is (already honestly framed) |

## Current www claims (verbatim, with locations)

- `components/landing/comparison.tsx:29` — *"…MCP, **6 chat platforms**"*
- `components/landing/comparison.tsx:57` — *"Slack-native… reaction-first tracer… (paid plans)"*
- `app/blog/announcing-atlas/page.tsx:285` — *"**Six chat platforms — Slack live today**;
  Teams, Discord, Telegram, WhatsApp, and Google Chat **wired** — plus Linear and GitHub,
  **also wired**"* ← already uses the honest live-vs-wired framing
- `app/pricing/pricing-content.tsx:143` — *"**All 8 integrations** (6 chat + Linear + GitHub)"*
- `app/pricing/pricing-content.tsx:173` — Chat integrations → business: *"**All 6**"*;
  starter *"1 platform"*, pro *"3 platforms"*
- `app/pricing/pricing-content.tsx:150,206` — *"Data residency (3 regions)"* (now truthful — keep)

## Repo-side wiring (ground truth I can see)

From `plugins/chat/src/adapter-registry.ts` + `docs/architecture/chat-plugin-atlas-contract.md`:

| Platform | In adapter registry? | Install handler shipped? | Contract-doc status |
|----------|----------------------|--------------------------|---------------------|
| **Slack** | ✓ | ✓ `SlackOAuthInstallHandler` | **✓ verified live** (full state contract documented) |
| Telegram | ✓ | ✓ first `StaticBotInstallHandler` (#2748) | wired; keystone for Phase D |
| Teams | ✓ | ⏳ Phase D | catalog row, adapter wired |
| Discord | ✓ | ⏳ Phase D | catalog row, adapter wired |
| Google Chat | ✓ | ⏳ Phase D | catalog row, adapter wired |
| WhatsApp | ✓ | ⏳ Phase D | catalog row, adapter wired |
| GitHub | ✓ | ⏳ | catalog row, adapter wired |
| Linear | ✓ | ⏳ | catalog row, adapter wired |

So "6 chat" = Slack + Teams + Discord + Telegram + WhatsApp + Google Chat; "8 integrations" =
those 6 + Linear + GitHub. The counts are internally consistent; the open question is **how
many of these are prod-live**, not whether the code exists.

> ⚠️ Signal from the roadmap: staging OAuth apps for **Twenty / Linear / GitHub / Google** were
> deferred (closed not-planned — milestone #57 "Deferred"). If those never got **prod** OAuth
> apps either, the "All 8 / All 6" framing likely overstates prod-live and should soften.

## What only you can confirm (fill these in)

For each platform, check the prod OAuth app registration + a real install/@mention soak:

| Platform | Prod OAuth app registered? | Install flow works in prod? | Soaked (real @mention answered)? | Verdict (live / wired / drop) |
|----------|---------------------------|-----------------------------|----------------------------------|-------------------------------|
| Slack | ☐ (expected ✓) | ☐ | ☐ | |
| Telegram | ☐ | ☐ | ☐ | |
| Teams | ☐ | ☐ | ☐ | |
| Discord | ☐ | ☐ | ☐ | |
| Google Chat | ☐ | ☐ | ☐ | |
| WhatsApp | ☐ | ☐ | ☐ | |
| GitHub | ☐ | ☐ | ☐ | |
| Linear | ☐ | ☐ | ☐ | |

## Copy actions, by outcome (I'll apply once you return verdicts)

- **If only Slack is prod-live** (most likely): bring the comparison + pricing lines to the
  blog's honest framing — e.g. *"Slack live; N more wired"* instead of bare *"6 chat platforms"*
  / *"All 6"* / *"All 8 integrations"*. Keep capability framing, drop the "live today" implication.
- **If N>1 are prod-live:** state the live count explicitly and keep the rest as "wired."
- **Either way:** keep "Data residency (3 regions)" (now truthful) and leave SOC 2 / ISO copy
  untouched.

## Notes

- The blog (`announcing-atlas`) is already honest (live vs wired) — likely **no change** there.
- Don't soften the per-tier *capacity* claims ("1 platform" / "3 platforms" / "All 6") into
  fewer **slots** — those describe how many a tier may **connect**, not how many are prod-live.
  Only the "live today" implication needs to match reality.
