# Action targets are per-workspace, and there is no operator tier

Status: accepted (2026-08-30, arch-backlog decision session — [#3766](https://github.com/AtlasDevHQ/atlas/issues/3766))

Every action target read a single global `process.env.*`. `lib/tools/actions/jira.ts` read `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` directly, so on SaaS *every* tenant's "create Jira ticket" hit the one operator-configured Jira. The action handler already threaded `orgId` — but only for the approval queue, RBAC, and row isolation; there was no per-workspace credential resolution for actions at all. That is the self-host shape running on a multi-tenant deployment.

This ADR settles the shape: **action-target credentials resolve per workspace, from an encrypted row keyed by `(workspace_id, target)`, with `process.env` as a self-hosted-only fallback and nothing in between.**

## The ladder, and the rung that is deliberately missing

```
workspace row  →  process.env (SELF-HOSTED ONLY)  →  throw
```

The chat-platform seam has three rungs: a workspace install, an operator-set DB row ([ADR-0005](0005-integration-credentials-table.md) / #3704's `operator_integration_credentials`), and operator env. Action targets get two, and the omission is the decision.

An operator-configured shared Jira serving several tenants is not a useful default — it is the exact multi-tenant confusion this work exists to remove. The asymmetry follows from what each tier *is*: an operator credential is Atlas's own app registration, and every tenant's Slack install legitimately talks to the same Slack app. A Jira site is the tenant's own external system. "Platform default Jira" has no referent.

On SaaS the env rung is absent outright, so a workspace with no row throws rather than resolving. On self-hosted the env rung is real, because there the operator owns both the deploy environment and the only workspace — the same carve-out [ADR-0007](0007-unified-install-pipeline.md)'s per-tenant resolvers make, and the reason an existing self-hoster's `.env` keeps working untouched.

## All-or-nothing per rung

A resolved credential set comes from **exactly one** rung. The rungs are never merged field by field, and this is where the design departs most sharply from the operator resolver — which *does* overlay DB over env per field.

The case that forces it: a tenant fills in their own `JIRA_BASE_URL` and `JIRA_EMAIL` but leaves `JIRA_API_TOKEN` blank. Under per-field precedence the blank token falls through to the operator's env token, and the ticket is created *against the tenant's Jira using Atlas's credential*. Invert which field is blank and it lands in Atlas's Jira instead. That is [#2850](https://github.com/AtlasDevHQ/atlas/issues/2850)'s Direction-1 leak, one tier down.

So a workspace row is used only when it satisfies every **required** field of the target. A partial row throws — it does not degrade to env, and it does not report as env-configured in the Admin status either, because a status that promises a rung the resolver will never reach is worse than one that says "unconfigured". A store read failure (transport, decrypt) propagates for the same reason: a decrypt failure that fell through to env would silently re-route a tenant's action at the operator's target.

## Where resolution happens, and whose workspace it uses

`lib/tools/actions/credentials/resolver.ts` is the single place the ladder is decided. Individual actions stay credential-agnostic — they receive a credential set as an argument.

The workspace is threaded to the executor through a new `ActionExecutionContext`, carrying `action_log.org_id` — the workspace stamped at **request** time. It is deliberately not re-read from the ambient request context at execution time, because a manual-approval action executes inside the *approver's* request: reading the context there would let whoever approves decide whose credentials fire. `packages/api/src/lib/tools/actions/__tests__/execution-context.test.ts` pins that with an approver in a different workspace than the requester.

## Storage: a new table, not `integration_credentials`

`workspace_action_credentials` (migration 0213), keyed `(workspace_id, target)`, encrypted via `db/secret-encryption.ts` and registered in `INTEGRATION_TABLES` so F-47 rotation and the F-42 residue audit pick it up with no per-table code.

Extending [ADR-0005](0005-integration-credentials-table.md)'s `integration_credentials` was the obvious alternative and was rejected on shape. That table holds OAuth refresh-token *bundles* for lazy-loaded integration plugins, keyed against a catalog row, with a lifecycle driven by 401-triggered refresh. Action-target credentials are static admin-entered field maps keyed by a target slug, with no catalog row and no refresh lifecycle. Jira makes the collision concrete: the Jira *query* plugin already stores an OAuth bundle in `integration_credentials` for this same workspace, while the Jira *action* uses Basic auth with an account email and API token. One table would key two incompatible payloads on the same natural key.

The bundle is a `{ <ENV_VAR_NAME>: <value> }` map — the same shape `operator_integration_credentials` uses, and for the same reason: env-var names as keys let one field spec read both the DB rung and the env rung with no per-target mapping table.

## The registry is the seam

`ACTION_TARGETS` in `lib/tools/actions/credentials/targets.ts` is the workspace-tier analogue of `OperatorPlatformSpec`. The resolver, the store, the Admin route and the status surface all iterate it and carry no per-target branches, so Linear, GitHub App and Salesforce are one registry entry plus that action's port off `process.env` — the "one-entry `ready-for-agent` children" the 2026-07-26 triage plan assumed.

## Consequences

- **A migrated action declares `requiredCredentials: []`.** `ToolRegistry.validateActionCredentials()` checks that list against the global `process.env`, a question with no meaningful answer for a per-workspace target: on SaaS there is no global rung, and on self-hosted a workspace that configured Jira from Admin would still report "missing credentials". Configuration status is per-workspace and lives on the Admin surface. This is the same position `sendEmailReport` already held. #3905's deploy-mode gate on the startup check stays, for whatever env-only actions remain.
- **The two tiers must never share a module.** Their precedence policies differ, so a shared helper would put the wrong policy one import away. Enforced structurally and pinned by `credentials/__tests__/action-credential-isolation.test.ts`, mirroring #3704's operator-side test.
- **Self-host is unchanged.** Same env-var names, same behavior when no row exists.
- **Still open, deliberately.** The Admin UI page itself (this ships the API), and whether a workspace can hold more than one credential set per target (today: one row per `(workspace_id, target)`).

See also: [#3766](https://github.com/AtlasDevHQ/atlas/issues/3766) (the decision record), [#2850](https://github.com/AtlasDevHQ/atlas/issues/2850) (the leak directions this generalizes), [ADR-0005](0005-integration-credentials-table.md), [ADR-0007](0007-unified-install-pipeline.md).
