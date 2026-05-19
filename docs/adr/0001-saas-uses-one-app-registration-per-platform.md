# ADR-0001: SaaS uses one operator-owned App Registration per Platform

**Status:** Accepted
**Date:** 2026-05-19
**Context milestone:** Multi-Adapter SaaS Readiness (forthcoming)

## Context

When a SaaS customer wants to connect a chat Platform (Slack, Teams, Discord, etc.) to their Workspace, two layers of setup exist:

1. **Platform-vendor app registration** — Someone registers an App with the Platform (Slack API console, Teams Bot Framework, Discord Developer Portal) to get a `client_id` / `client_secret`. This is inherent to OAuth on third-party platforms; there is no way to skip it.
2. **OAuth flow** — A customer admin clicks "Connect Slack," runs OAuth against the registered App, and gets a per-workspace bot token.

The question is **who owns step 1**: the SaaS operator (Atlas) or the customer?

Atlas's history biased toward self-host: every operator owned their own App Registration because every Atlas deployment was its own self-hosted instance. As SaaS launched, this shape persisted — but on SaaS, "operator" and "customer" are now different parties.

## Decision

**SaaS uses one App Registration per Platform, owned by Atlas (the SaaS operator).** Customers connect their Workspaces via OAuth against the Atlas-owned App; they never see or manage `client_id` / `client_secret`.

Self-host is unchanged: a self-host operator brings their own App Registration, since they are both operator and customer.

## Alternatives considered

### A2 — Bring-your-own App Registration per customer

Every customer admin registers their own App with each Platform vendor and pastes the credentials into Atlas admin.

Rejected because:
- ~30 minutes of Slack-developer-portal configuration per customer per Platform is hostile SaaS UX
- No major SaaS (Linear, Notion, Sentry, Vercel) does this — they all use operator-owned App Registrations
- The argument *for* it — letting enterprise customers control their own App Registration for data-residency reasons — is better served by self-hosting

### A3 — Atlas-curated marketplace

Same operational shape as A1 with a marketing layer ("approved integrations"). No architectural difference.

## Consequences

**Operator owns:**
- One App Registration per Platform Atlas chooses to support
- The `client_id` / `client_secret` env vars per Platform per deployment region
- The OAuth redirect URI and event-subscription endpoints registered with each Platform vendor

**Customer owns:**
- The per-Workspace decision to connect a Platform
- The OAuth-completed bot token (persisted by Atlas in `chat_cache` per-workspace)
- Per-Workspace Platform configuration (channel allowlist, proactive enable/disable, etc.)

**Implication for `atlas.config.ts`:** Listing supported Platforms is operator work, done once per Platform per Atlas codebase. Activating a Platform for a specific customer is admin-UI work, done by the customer.

**Self-host symmetry:** A self-host operator's App Registration + Workspace are 1:1 (one workspace, one App Registration per Platform they want). The same code path handles both; the seam is at the Workspace identity resolver, not at the App Registration layer.

## References

- Closes the "atlas.config.ts edit per Platform" pain documented in the Multi-Adapter SaaS Readiness PRD
- See `CONTEXT.md` for canonical terminology (Platform, Adapter, App Registration, Workspace Connection)
