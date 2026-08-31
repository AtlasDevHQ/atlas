/**
 * Shared contract for the REST confirm-before-write flow (PRD #2868 slice 5,
 * #2929; single-use token gate #3007). When the agent stages an allowlisted
 * write, `executeRestOperation` returns a `needs_confirmation` result carrying a
 * {@link RestWriteConfirmRequest} — the exact replay payload the chat surface's
 * confirm-before-write banner POSTs to `POST /api/v1/rest-operations/confirm`.
 * The write fires there, after the human confirms, never silently in the agent
 * loop.
 *
 * This module is the single source of truth for that wire shape + the
 * human-facing summary, so the staging tool and the confirming endpoint can't
 * drift. Both re-run {@link import("./validate-rest-operation").validateRestOperation}
 * against the resolved datasource — the confirm endpoint is NOT a trusted
 * fast-path; it re-validates the allowlist + params server-side (defense in
 * depth: a tampered client payload still can't escalate past the allowlist).
 *
 * ## The single-use confirm token (#3007)
 *
 * The allowlist alone makes `/confirm` a stateless at-least-once endpoint: any
 * holder of a valid staged payload (a replayed request, an XSS/CSRF against the
 * SPA, a looping agent) could re-fire an allowlisted write. To make the
 * human-in-the-loop guarantee SERVER-verifiable, every staged write now carries a
 * short-lived, server-signed, single-use {@link RestWriteConfirmRequest.token}:
 *
 *   - {@link mintRestConfirmToken} (staging) signs a token binding
 *     `(workspaceId, datasourceId, operationId, canonical-params, nonce, exp)`
 *     with the resolved encryption keyset (`ATLAS_ENCRYPTION_KEYS` →
 *     `ATLAS_ENCRYPTION_KEY` → `BETTER_AUTH_SECRET`) — the same keyset
 *     `oauth-state-token.ts` signs with, so no new signing secret is introduced.
 *   - {@link verifyRestConfirmToken} (confirm) re-derives that binding from the
 *     re-resolved request and rejects a missing / tampered / expired token, or
 *     one minted for a different workspace / datasource / operation / params.
 *   - {@link import("../confirm-token").burnConfirmNonce} consumes the nonce so a
 *     replay of the same token is rejected — single-use.
 *
 * Since #5496 the scheme itself is NOT written here: it lives in
 * `lib/confirm-token.ts`, which the two staged brain verbs share through
 * `lib/brain/staged-write.ts`. The
 * three functions above are this gate's thin specialization of it (its `typ`
 * domain separator, its TTL env var, and the four things it binds). That is what
 * keeps the two gates one implementation rather than two copies of a security
 * primitive, only one of which anybody reads.
 *
 * The token is OPAQUE to the banner: it lives inside the `confirm` payload, which
 * the banner POSTs verbatim. Mirror this field on the web-local
 * `RestWriteConfirmRequest` (`packages/web/src/ui/lib/rest-operation-types.ts`).
 */
import {
  claimsHash,
  mintConfirmToken,
  verifyConfirmToken,
  type ConfirmClaims,
  type ConfirmTokenKind,
  type ConfirmTokenVerification,
  type MintConfirmTokenOptions,
} from "@atlas/api/lib/confirm-token";
import type { Operation, OperationParams } from "./types";

/**
 * The request header by which a chat surface declares it can RENDER the
 * confirm-before-write banner and POST the payload above (#5495).
 *
 * `POST /api/v1/chat` serves two clients with the same auth and the same
 * registry: `packages/web`, which ships `rest-write-confirm-card.tsx`, and the
 * embeddable `@useatlas/react` widget, which ships its own `tool-part.tsx` with
 * no such card. Nothing already on the request tells them apart — not
 * `dashboardUrlResolver`, the registry-build signal that gates `createDashboard`
 * (#4566) and `correct_fact` (#4915), because both clients resolve the same
 * `defaultRegistry`. So the surface declares the capability itself.
 *
 * Web sets it in `packages/web/src/ui/hooks/use-atlas-transport.ts` and
 * `components/dashboards/bound-chat-drawer.tsx`; those literals mirror this
 * constant the same way `rest-operation-types.ts` mirrors the wire shape (the
 * frontend cannot import from `@atlas/api`). `lib/cors.ts` lists it in
 * `Access-Control-Allow-Headers` so a cross-origin embedder that learns the card
 * is not blocked at the preflight.
 */
export const WRITE_CONFIRM_UI_HEADER = "x-atlas-write-confirm-ui";

/**
 * Read {@link WRITE_CONFIRM_UI_HEADER}. Absent, blank, or anything other than
 * `1` / `true` (case- and whitespace-insensitive) ⇒ `false`.
 *
 * **A capability hint, not a security control — and it is not relied on as
 * one.** Asserting it grants nothing a caller could not already do: the write is
 * still only STAGED in the agent loop, and firing it needs a separate POST to
 * `/api/v1/rest-operations/confirm`, which re-resolves the datasource, re-runs
 * the allowlist and param validation server-side, and verifies + burns the
 * single-use token (#3007). A client that lies here only re-earns the dead-ended
 * turn the gate exists to prevent.
 *
 * The value is entirely in the DEFAULT. Fail-closed means every published
 * `@useatlas/react` version — none of which send this — stops being offered a
 * write it cannot finish, with no new code shipped to them.
 */
export function readsWriteConfirmUiHeader(headers: Headers): boolean {
  const raw = headers.get(WRITE_CONFIRM_UI_HEADER);
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}
/** A scalar param value the agent / banner may carry (matches the tool input). */
export type RestParamScalar = string | number | boolean;

/**
 * The replay payload for a staged write. Bucketed exactly like the
 * `executeRestOperation` tool input so the banner echoes back what the agent
 * staged; the confirm endpoint converts it into {@link OperationParams}.
 */
export interface RestWriteConfirmRequest {
  readonly datasourceId: string;
  readonly operationId: string;
  // The three parameter buckets are loose-optional (`| undefined`): this is the
  // REST input contract the banner POSTs verbatim, so it arrives Zod-parsed
  // with `T | undefined` in every optional slot, and `confirmRequestToParams`
  // below reads each through a truthiness guard before it can reach the
  // request (#5522).
  readonly pathParams?: Record<string, RestParamScalar> | undefined;
  readonly query?: Record<string, RestParamScalar | ReadonlyArray<RestParamScalar>> | undefined;
  readonly header?: Record<string, RestParamScalar> | undefined;
  /** JSON request body for the write. */
  readonly body?: unknown;
  /**
   * Server-signed, single-use confirm token (#3007) binding this exact staged
   * write to `(workspace, datasource, operation, canonical params, nonce, exp)`.
   * Minted by {@link mintRestConfirmToken} at staging; required + verified +
   * burned by the confirm endpoint. Opaque to the banner — it POSTs the whole
   * `RestWriteConfirmRequest` (including this token) verbatim.
   */
  readonly token: string;
}

/** Convert a {@link RestWriteConfirmRequest} into the client's {@link OperationParams}. */
export function confirmRequestToParams(req: RestWriteConfirmRequest): OperationParams {
  return {
    ...(req.pathParams ? { path: req.pathParams } : {}),
    ...(req.query ? { query: req.query } : {}),
    ...(req.header ? { header: req.header } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  };
}

/**
 * A concise, factual one-line description of a staged write for the banner
 * header, e.g. `Delete a person — DELETE /people/{id} on Twenty` — the label is
 * the operation's spec `summary` when present, falling back to its
 * `operationId`. The agent supplies the richer natural-language framing
 * ("permanently delete 3 people") in its turn; this derives purely from the
 * resolved {@link Operation} (it takes no agent-supplied params) so the banner
 * can't misstate the verb or target even if the agent's prose is wrong.
 */
export function buildRestWriteSummary(operation: Operation, datasourceName: string): string {
  const label = operation.summary?.trim() || operation.operationId;
  return `${label} — ${operation.method} ${operation.path} on ${datasourceName}`;
}

// ─────────────────────────────────────────────────────────────────────
//  Single-use confirm token (#3007)
// ─────────────────────────────────────────────────────────────────────
//
//  The scheme itself lives in `lib/confirm-token.ts` (extracted by #5496, when
//  `correct_fact` became the second gate on this shape). This section is the
//  REST gate's THIN specialization of it: the domain separator, the TTL env
//  var, and which four things a REST confirm token binds. Behaviour and wire
//  bytes are unchanged — the payload is still `{w, ds, op, ph, n, exp}`, and
//  `rest-write-confirm.test.ts` is what says so.

/**
 * The REST write gate's token identity. `typ` is the domain separator carried
 * in the signed header: it is why a brain-correction confirm token — signed
 * with the same keyset — cannot be presented at `/api/v1/rest-operations/confirm`.
 */
const REST_CONFIRM_KIND: ConfirmTokenKind = {
  typ: "AtlasRestConfirm",
  ttlEnvVar: "ATLAS_OPENAPI_CONFIRM_TTL_SECONDS",
};

/** The binding a confirm token is signed over and re-verified against. */
export interface RestConfirmBinding {
  readonly workspaceId: string;
  readonly datasourceId: string;
  readonly operationId: string;
  /** The {@link OperationParams} the write dispatches with — bound via a canonical hash. */
  readonly params: OperationParams;
}

/**
 * The signed claims for a REST confirm token. Short keys are the wire format
 * this gate has always used; `ph` binds the exact params by hash rather than
 * embedding them, so the token stays small and says nothing readable about the
 * write it authorizes.
 */
function restClaims(binding: RestConfirmBinding): ConfirmClaims {
  return {
    /** Workspace (org) id. */
    w: binding.workspaceId,
    /** Datasource install id. */
    ds: binding.datasourceId,
    /** Operation id. */
    op: binding.operationId,
    /** sha256(canonical params) — binds the exact params without embedding them. */
    ph: claimsHash(binding.params),
  };
}

/**
 * Mint a single-use confirm token binding a staged write. Always signs with the
 * active (highest-version) key in the resolved encryption keyset.
 *
 * Throws when no signing key is configured — like {@link import("../integrations/install/oauth-state-token").mintOAuthStateToken},
 * the human-in-the-loop confirm gate must NOT degrade silently to an unsigned
 * (forgeable) token. The caller (the staging tool) maps the throw to a structured
 * "can't stage this write" result so the operator gates this on real key material.
 */
export function mintRestConfirmToken(
  binding: RestConfirmBinding,
  options: MintConfirmTokenOptions = {},
): string {
  return mintConfirmToken(REST_CONFIRM_KIND, restClaims(binding), options);
}

/**
 * Verify a confirm token against the binding re-derived from THIS confirm request.
 * Pure — it does not touch the single-use store (the caller burns
 * the returned nonce with `burnConfirmNonce` once the rest of validation passes). Returns a tagged result;
 * the route maps every `ok: false` arm to one neutral 400 (never revealing which
 * check tripped — that would let an attacker probe the pipeline).
 *
 * `nowSeconds` is injectable for deterministic expiry tests; it defaults to wall-clock.
 */
export function verifyRestConfirmToken(
  token: string,
  expected: RestConfirmBinding,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ConfirmTokenVerification {
  return verifyConfirmToken(REST_CONFIRM_KIND, token, restClaims(expected), nowSeconds);
}

// ⚠️ **This gate is deliberately NOT a `StagedVerb`** (`lib/brain/staged-write.ts`),
// and the reason is a real difference in the invariant rather than a refactor
// that stopped short. The two brain gates burn the nonce on the ATTEMPT: verify,
// burn, then run the verb, so a refused write still spends its confirmation and
// one card cannot be re-fired against many targets. This gate burns LATER —
// `rest-operations.ts` interposes the allowlist re-validation and the
// write-only check between verification and the burn (all synchronous, so the
// no-`await` property still holds), so a confirm rejected by the allowlist does
// NOT spend its nonce. Folding this into `verifyAndBurnStagedConfirm` would
// change that, which is a behaviour change and not a deduplication.
//
// `burnRestConfirmNonce`, `_resetRestConfirmNonces`, `MintRestConfirmTokenOptions`,
// `RestConfirmTokenRejection` and `RestConfirmTokenVerification` were removed by
// #5571. Each was a re-export of `lib/confirm-token.ts` under a `Rest`-prefixed
// name — a second vocabulary for a concept that has exactly one implementation,
// which is how a reader ends up believing there are two nonce stores. The nonce
// store IS shared across every gate, deliberately (one eviction policy rather
// than N that drift), and callers now say so by importing `burnConfirmNonce` /
// `_resetConfirmNonces` directly.
