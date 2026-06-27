/**
 * `bindMcpActor` — the single seam that constructs the bound `AtlasUser`
 * for an MCP dispatch, with the trusted-vs-hosted trust boundary expressed
 * as ONE explicit `switch (transport)` branch (#3603).
 *
 * ── The fork this seam makes explicit (ADR-0016 §platform_admin) ────
 *
 * Two MCP transports resolve an actor's role under intentionally-different
 * trust boundaries. Before this seam they were two separately-evolved code
 * paths (`actor.ts:resolveMcpActor` for stdio, `hosted.ts:bindFactoryContext`
 * for hosted) that happened to share the "construct an AtlasUser for an MCP
 * dispatch" shape with no common home. The seam does NOT erase the fork — it
 * names it:
 *
 *   - **stdio** (`transport: "stdio"`) — the operator's own env-bound
 *     process. `loadActorUser` resolves the USER-LEVEL role (a
 *     `platform_admin` over stdio MCP keeps `platform_admin`). The local
 *     operator is trusted. This is the *governed* / *trusted* MCP actor.
 *
 *   - **hosted** (`transport: "hosted"`) — customer-facing OAuth. The role
 *     is resolved as the caller's ORG (member) role for the ADMITTED
 *     workspace ONLY; the user-level role is passed as `undefined` to
 *     `resolveEffectiveRole`, so a cross-tenant `platform_admin` is NEVER
 *     auto-applied. Auto-escalating staff to god-mode over a customer's
 *     workspace through an OAuth client would be a privilege-escalation
 *     surface. This is the *hosted* MCP actor.
 *
 * CRITICAL INVARIANT (ADR-0016, holds byte-for-byte): hosted withholds
 * `platform_admin` (org role only); stdio resolves the user-level role.
 *
 * Wiring (so the claim is precise, not aspirational): the **hosted** edge
 * (`hosted.ts:bindFactoryContext`) calls `resolveMcpActorRole` directly, so its
 * trust rule lives here and nowhere else. The **stdio** production path
 * (`actor.ts:resolveMcpActor` → `loadActorUser`, shared with the scheduler)
 * resolves the user-level role via the SAME `resolveEffectiveRole(userRole, …)`
 * the stdio arm below encodes — so this switch is the canonical *declaration*
 * of both arms' rules even though stdio reaches `resolveEffectiveRole` through
 * `loadActorUser` rather than calling this function at runtime. `bind-actor.test.ts`
 * pins both arms so the stdio path can't silently diverge from this declaration.
 *
 * `resolveEffectiveRole` fails closed on both branches: a member-table read
 * error yields no resolved role → downstream defaults to least privilege
 * (`member`), never escalates.
 *
 * @see docs/adr/0016-mcp-v2-security-model.md §`platform_admin` over hosted MCP
 */

import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { resolveEffectiveRole } from "@atlas/api/lib/auth/effective-role";

/**
 * Which trust boundary the MCP actor is being bound under. The discriminator
 * the seam switches on — see the module docstring.
 *
 * `stdio` covers both the stdio binary and the self-hosted `--transport sse`
 * standalone server: both run in the operator's own trusted process and bind
 * a single boot-time actor (`resolveMcpActor`). `hosted` is the SaaS
 * per-bearer OAuth edge. `cli` is the `atlas login` device-flow credential
 * (ADR-0026): a portable, file-stored bearer that resolves ORG-role-only —
 * like `hosted` but for the CLI transport, withholding `platform_admin`
 * REGARDLESS of deploy mode (a copied-off credential file is never the
 * trusted local operator).
 *
 * SCOPE NOTE: the `cli` arm is a forward-declaration — no runtime caller binds
 * `transport: "cli"` yet (only `hosted.ts` calls this, with `"hosted"`). The
 * device-flow credential is a getSession session bearer, so its runtime
 * downgrade happens in `buildCustomSessionPayload` (REST path, keyed on
 * `session.origin === "cli"`), NOT here. This arm reserves the same trust
 * boundary for the day the cli bearer reaches MCP dispatch; `bind-actor.test`
 * proves it resolves org-role-only (it does NOT exercise the gate chain).
 */
export type McpTransportTrust = "stdio" | "hosted" | "cli";

export interface ResolveMcpActorRoleArgs {
  /** The trust boundary this binding is happening under. */
  readonly transport: McpTransportTrust;
  /** The actor's user id (the bearer subject for hosted, the bound user for stdio). */
  readonly userId: string;
  /** The workspace the role is resolved against (the admitted org for hosted). */
  readonly activeOrganizationId: string | undefined;
  /**
   * The actor's user-level role, when known. ONLY consulted on the stdio
   * branch — the hosted branch deliberately ignores it so `platform_admin`
   * is never auto-applied cross-tenant (ADR-0016). Optional; absent for
   * hosted callers (who must never pass it through).
   */
  readonly userRole?: AtlasRole | undefined;
}

/**
 * Resolve the effective role for an MCP actor under its trust boundary. The
 * single branch where the stdio-vs-hosted difference lives.
 *
 * Returns the resolved role, or `undefined` when neither side yields one
 * (fail-closed: downstream defaults to least privilege).
 */
export function resolveMcpActorRole(
  args: ResolveMcpActorRoleArgs,
): Promise<AtlasRole | undefined> {
  switch (args.transport) {
    case "stdio":
      // Trusted local operator: resolve the USER-LEVEL role too, so a
      // `platform_admin` over stdio keeps `platform_admin` (ADR-0016).
      return resolveEffectiveRole(
        args.userRole,
        args.userId,
        args.activeOrganizationId,
      );
    case "hosted":
      // Customer-facing OAuth: ORG role ONLY. Pass `undefined` for the
      // user-level role so a cross-tenant `platform_admin` is never
      // auto-applied over a customer's workspace (ADR-0016 §platform_admin).
      return resolveEffectiveRole(undefined, args.userId, args.activeOrganizationId);
    case "cli":
      // `atlas login` device-flow bearer (ADR-0026): ORG role ONLY, exactly
      // like `hosted`. A portable file-stored credential is an exfiltration
      // surface — `platform_admin` is withheld regardless of deploy mode, so
      // a stolen `~/.atlas/credentials` can never act past its org/member role
      // for the bound workspace. Distinct case (not a fall-through) so the
      // trust boundary is named, audited, and pinned independently of hosted.
      return resolveEffectiveRole(undefined, args.userId, args.activeOrganizationId);
    default: {
      // Exhaustiveness guard — a new transport must declare its trust boundary
      // here rather than silently inherit one.
      const _exhaustive: never = args.transport;
      throw new Error(`Unhandled MCP transport trust boundary: ${String(_exhaustive)}`);
    }
  }
}
