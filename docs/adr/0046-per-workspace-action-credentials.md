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

The workspace is threaded to the executor through a new `ActionExecutionContext`, carrying `action_log.org_id` — the workspace stamped at **request** time. It is deliberately not re-read from the ambient request context at execution time, because a manual-approval action executes inside the *approver's* request: reading the context there would let whoever approves decide whose credentials fire. `packages/api/src/lib/tools/actions/__tests__/handler.test.ts` (the "Formerly execution-context.test.ts" section) pins that with an approver in a different workspace than the requester.

## Storage: a new table, not `integration_credentials`

`workspace_action_credentials` (migration 0213), keyed `(workspace_id, target)`, encrypted via `db/secret-encryption.ts` and registered in `INTEGRATION_TABLES` so F-47 rotation and the F-42 residue audit pick it up with no per-table code.

Extending [ADR-0005](0005-integration-credentials-table.md)'s `integration_credentials` was the obvious alternative and was rejected on shape. That table holds OAuth refresh-token *bundles* for lazy-loaded integration plugins, keyed against a catalog row, with a lifecycle driven by 401-triggered refresh. Action-target credentials are static admin-entered field maps keyed by a target slug, with no catalog row and no refresh lifecycle. Jira makes the collision concrete: the Jira *query* plugin already stores an OAuth bundle in `integration_credentials` for this same workspace, while the Jira *action* uses Basic auth with an account email and API token. One table would key two incompatible payloads on the same natural key.

The bundle is a `{ <ENV_VAR_NAME>: <value> }` map — the same shape `operator_integration_credentials` uses, and for the same reason: env-var names as keys let one field spec read both the DB rung and the env rung with no per-target mapping table.

## The registry is the seam

`ACTION_TARGETS` in `lib/tools/actions/credentials/targets.ts` is the workspace-tier analogue of `OperatorPlatformSpec`. The resolver, the store, the Admin route and the status surface all iterate it and carry no per-target branches, so Linear, GitHub App and Salesforce are one registry entry plus that action's port off `process.env` — the "one-entry `ready-for-agent` children" the 2026-07-26 triage plan assumed.

## A partial row is unrepresentable through the Admin path — and still nameable

Amended 2026-08-31 ([#5564](https://github.com/AtlasDevHQ/atlas/issues/5564)). The all-or-nothing rule above is unchanged; what changed is who is allowed to create the state it punishes, and whether the status API can say the state exists.

`missingRequired` — the predicate that decides completeness — had **no caller on the write path**. Neither the store's save nor the Admin update route checked that the merged result satisfied the target's required fields, so a half-filled form freely created a row that shadows the environment rung. On a self-hosted deploy that silently broke a target that had been working from `process.env`, which is the exact failure the rule exists to make loud rather than to cause.

Two changes, and one deliberate non-change:

**The write path rejects an incomplete merge.** `PUT /api/v1/admin/action-credentials/{target}` computes the merged outcome — stored row, plus incoming `fields`, minus `clearFields` — and returns 400 naming the unsatisfied fields when any required one would be left unset. Strict, with no "the admin will finish it later" exception, because the row such a save creates is not inert. The check reads the same object the write persists; a check that re-derived its own copy, or re-read the row, could disagree with what lands. `DELETE` stays ungated on completeness, so refusing the write traps nobody: the way out of an entry an admin no longer wants is to clear it whole.

**This invariant cannot live in the schema, and that is a consequence of the design rather than an oversight.** The bundle is one AES-256-GCM ciphertext column, so Postgres cannot see the fields inside it and no `CHECK` constraint can express completeness. Application-level validation is the only lever the encryption-at-rest choice leaves, which is also why the cleanup of rows already stored is a one-shot script (`migrations/scripts/purge_partial_action_credentials.ts`) rather than a numbered migration — there is no DDL half. That script is correct exactly once, against the specs as they stand when it runs, and its docblock says at length why it must never become a recurring sweep.

**The status response names the partial states anyway.** `configured: boolean` + `resolvedFrom: rung | null` is replaced by one discriminant:

| `state` | Meaning |
|---|---|
| `unconfigured` | No workspace row; env rung absent or incomplete |
| `workspace` | A complete workspace row resolves |
| `env` | No workspace row; a complete env rung resolves (self-hosted only) |
| `partial-row` | Workspace row incomplete; nothing is being shadowed |
| `partial-row-shadowing-env` | Workspace row incomplete **and** the env rung complete — execution throws, and a previously working target is now broken (self-hosted only) |

The old pair could not distinguish an incomplete row from no row: both reported `configured: false, resolvedFrom: null` with every field `unset`. Under this ADR's own rule those are opposite situations, and the one that matters most was the one nobody could see. `configured` and `resolvedFrom` are removed outright rather than kept as derived duplicates — there is no compatibility shim and no deprecation window, because there are no customers and the Admin page is the only consumer. Two booleans-worth of representable combinations for five real states is the duplication [#5561](https://github.com/AtlasDevHQ/atlas/pull/5561) rejected when it declined a `kind` discriminant alongside `secret`; one discriminant makes the illegal combinations unrepresentable rather than merely undocumented.

**Why the partial states earn their place once writes are strict.** With the gate and the cleanup, no admin can create a partial row through the Admin path. The state stays reachable by exactly one route: **a target's field spec gaining a required field after rows are stored**, which turns every stored row for that target partial at once. `ACTION_TARGETS` is live code that gained three entries in a week, so that is a real path. The tests and this wording are written around it rather than around a half-finished form.

The field status also carries `stored` — whether the workspace's row holds that field, independently of which rung wins. `present`/`source` answer "what would execute", and in a partial state nothing executes, so every field reads `unset` even when the row holds it. Without `stored` the Admin form could only assume the admin must re-type every required field, which in the spec-evolution case would block the one save that repairs the row. It is presence only, and discloses nothing `source: "workspace"` does not already disclose on the winning path.

**What was considered and rejected.** Letting a partial row fall through to the environment rung per field would remove the footgun at its root, and is refused for the reason the all-or-nothing section states: it reintroduces exactly the cross-rung mixing [#2850](https://github.com/AtlasDevHQ/atlas/issues/2850) closed structurally. Revisiting it needs a new ADR, not this amendment.

## Consequences

- **A migrated action declares `requiredCredentials: []`.** `ToolRegistry.validateActionCredentials()` checks that list against the global `process.env`, a question with no meaningful answer for a per-workspace target: on SaaS there is no global rung, and on self-hosted a workspace that configured Jira from Admin would still report "missing credentials". Configuration status is per-workspace and lives on the Admin surface. This is the same position `sendEmailReport` already held. #3905's deploy-mode gate on the startup check stays, for whatever env-only actions remain.
- **The two tiers must never share a module.** Their precedence policies differ, so a shared helper would put the wrong policy one import away. Enforced structurally and pinned by `credentials/__tests__/action-credential-isolation.test.ts`, mirroring #3704's operator-side test.
- **Self-host is unchanged.** Same env-var names, same behavior when no row exists.
- **The status response is a discriminated state, not a flag pair.** Every consumer branches on `state`; `configured` and `resolvedFrom` do not exist. A new state is a breaking change to that enum by design — the point of the shape is that adding one forces every consumer to say what it does about it.
- **Still open, deliberately.** Whether a workspace can hold more than one credential set per target (today: one row per `(workspace_id, target)`). The Admin UI page shipped in [#5553](https://github.com/AtlasDevHQ/atlas/issues/5553).

See also: [#3766](https://github.com/AtlasDevHQ/atlas/issues/3766) (the decision record), [#5564](https://github.com/AtlasDevHQ/atlas/issues/5564) (the strict-write amendment above), [#2850](https://github.com/AtlasDevHQ/atlas/issues/2850) (the leak directions this generalizes), [ADR-0005](0005-integration-credentials-table.md), [ADR-0007](0007-unified-install-pipeline.md).
