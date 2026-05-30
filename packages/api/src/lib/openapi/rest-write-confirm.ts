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
 *   - {@link burnRestConfirmNonce} consumes the nonce so a replay of the same
 *     token is rejected — single-use.
 *
 * The token is OPAQUE to the banner: it lives inside the `confirm` payload, which
 * the banner POSTs verbatim. Mirror this field on the web-local
 * `RestWriteConfirmRequest` (`packages/web/src/ui/lib/rest-operation-types.ts`).
 */
import * as crypto from "crypto";

import { createLogger } from "@atlas/api/lib/logger";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import type { Operation, OperationParams } from "./types";

const log = createLogger("openapi.rest-write-confirm");

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
  readonly pathParams?: Record<string, RestParamScalar>;
  readonly query?: Record<string, RestParamScalar | ReadonlyArray<RestParamScalar>>;
  readonly header?: Record<string, RestParamScalar>;
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

const SIG_ALGORITHM = "sha256";
const ALG = "HS256";
/** Domain separator (in the signed header) — a confirm token can't be cross-used as another signed-token type. */
const TYP = "AtlasRestConfirm";

/**
 * Default confirm-token lifetime. The confirm step is interactive — the agent
 * stages the write, the human reads the banner ("this will delete 3 people") and
 * clicks Confirm. Ten minutes covers reasonable read/deliberate latency while
 * keeping the replay window narrow (same interactive rationale as the OAuth state
 * token). Override via `ATLAS_OPENAPI_CONFIRM_TTL_SECONDS`, clamped [60, 3600].
 */
const DEFAULT_TTL_SECONDS = 10 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60;
const NONCE_BYTES = 16;

/** The binding a confirm token is signed over and re-verified against. */
export interface RestConfirmBinding {
  readonly workspaceId: string;
  readonly datasourceId: string;
  readonly operationId: string;
  /** The {@link OperationParams} the write dispatches with — bound via a canonical hash. */
  readonly params: OperationParams;
}

export interface MintRestConfirmTokenOptions {
  /** Override the TTL in seconds (≥1). Primarily for tests; production uses the env/default. */
  readonly ttlSeconds?: number;
  /** Override "now" in unix seconds — tests mint expired / far-future tokens deterministically. */
  readonly nowSeconds?: number;
  /** Override the random nonce — tests only (forces a deterministic single-use id). */
  readonly nonce?: string;
}

interface TokenHeader {
  readonly alg: typeof ALG;
  readonly kid: number;
  readonly typ: typeof TYP;
}

interface TokenPayload {
  /** Workspace (org) id. */
  readonly w: string;
  /** Datasource install id. */
  readonly ds: string;
  /** Operation id. */
  readonly op: string;
  /** sha256(canonical params) — binds the exact params without embedding them. */
  readonly ph: string;
  /** Single-use nonce. */
  readonly n: string;
  /** Expiration in unix seconds. */
  readonly exp: number;
}

/** Why a confirm token was refused. Machine-readable for server-side logging; the route maps every arm to one neutral 400. */
export type RestConfirmTokenRejection =
  | "missing"
  | "malformed"
  | "no-key"
  | "bad-signature"
  | "binding-mismatch"
  | "expired";

/** The result of {@link verifyRestConfirmToken}. On success it carries the nonce + exp the caller burns. */
export type RestConfirmTokenVerification =
  | { readonly ok: true; readonly nonce: string; readonly expSeconds: number }
  | { readonly ok: false; readonly reason: RestConfirmTokenRejection };

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
  options: MintRestConfirmTokenOptions = {},
): string {
  const keyset = getEncryptionKeyset();
  if (!keyset) {
    throw new Error(
      "mintRestConfirmToken: no signing key configured — set ATLAS_ENCRYPTION_KEYS / ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET. " +
        "The confirm-before-write gate cannot fall through to an unsigned token.",
    );
  }

  const ttl = resolveConfirmTtlSeconds(options.ttlSeconds);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + ttl;
  const nonce = options.nonce ?? crypto.randomBytes(NONCE_BYTES).toString("base64url");

  const header: TokenHeader = { alg: ALG, kid: keyset.active.version, typ: TYP };
  const payload: TokenPayload = {
    w: binding.workspaceId,
    ds: binding.datasourceId,
    op: binding.operationId,
    ph: paramsHash(binding.params),
    n: nonce,
    exp,
  };

  const headerB64 = encodeJson(header);
  const payloadB64 = encodeJson(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac(SIG_ALGORITHM, keyset.active.key).update(signingInput).digest();
  return `${signingInput}.${sig.toString("base64url")}`;
}

/**
 * Verify a confirm token against the binding re-derived from THIS confirm request.
 * Pure — it does not touch the single-use store (the caller {@link burnRestConfirmNonce}s
 * the returned nonce once the rest of validation passes). Returns a tagged result;
 * the route maps every `ok: false` arm to one neutral 400 (never revealing which
 * check tripped — that would let an attacker probe the pipeline).
 *
 * `nowSeconds` is injectable for deterministic expiry tests; it defaults to wall-clock.
 */
export function verifyRestConfirmToken(
  token: string,
  expected: RestConfirmBinding,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): RestConfirmTokenVerification {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing" };

  let keyset: ReturnType<typeof getEncryptionKeyset>;
  try {
    keyset = getEncryptionKeyset();
  } catch (err) {
    // getEncryptionKeyset throws on malformed ATLAS_ENCRYPTION_KEYS (operator
    // misconfig that should normally fail at boot). Warn once, reject all tokens.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "verifyRestConfirmToken: keyset resolution threw — operator misconfig; rejecting",
    );
    return { ok: false, reason: "no-key" };
  }
  if (!keyset) return { ok: false, reason: "no-key" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeJson<TokenHeader>(headerB64);
  if (!header || header.alg !== ALG || header.typ !== TYP) return { ok: false, reason: "malformed" };
  if (typeof header.kid !== "number" || !Number.isFinite(header.kid)) return { ok: false, reason: "malformed" };

  const key = keyset.byVersion.get(header.kid);
  // Unknown kid (key rotated out) — treat like a bad signature: we can't verify it.
  if (!key) return { ok: false, reason: "bad-signature" };

  // The signature covers the received `headerB64.payloadB64` literally, so ANY
  // tampering of either segment fails this comparison — constant-time on the sig.
  const expectedSig = crypto.createHmac(SIG_ALGORITHM, key).update(`${headerB64}.${payloadB64}`).digest();
  const providedSig = Buffer.from(sigB64, "base64url");
  if (providedSig.length !== expectedSig.length) return { ok: false, reason: "bad-signature" };
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return { ok: false, reason: "bad-signature" };

  // Signature verified ⇒ the payload is trusted. Decode + structurally check it.
  const payload = decodeJson<TokenPayload>(payloadB64);
  if (
    !payload ||
    typeof payload.w !== "string" ||
    typeof payload.ds !== "string" ||
    typeof payload.op !== "string" ||
    typeof payload.ph !== "string" ||
    typeof payload.n !== "string" ||
    payload.n.length === 0 ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }

  // Binding: the signed token must match the workspace/datasource/operation/params
  // re-resolved for THIS confirm request. A token minted for a different binding —
  // or a payload whose params were swapped after staging (ph diverges) — is refused.
  if (
    payload.w !== expected.workspaceId ||
    payload.ds !== expected.datasourceId ||
    payload.op !== expected.operationId ||
    payload.ph !== paramsHash(expected.params)
  ) {
    return { ok: false, reason: "binding-mismatch" };
  }

  if (payload.exp <= nowSeconds) return { ok: false, reason: "expired" };

  return { ok: true, nonce: payload.n, expSeconds: payload.exp };
}

// ─────────────────────────────────────────────────────────────────────
//  Single-use nonce store (in-process)
// ─────────────────────────────────────────────────────────────────────

/**
 * Burned-nonce store: `nonce → exp (unix seconds)`. Only holds nonces that were
 * actually consumed (human-gated confirms — tiny). Eviction is lazy / on-write:
 * each {@link burnRestConfirmNonce} call first drops entries past their token's
 * `exp`, so if confirm traffic stops, already-expired entries linger until the
 * next burn — harmless, since the expiry check in {@link verifyRestConfirmToken}
 * rejects an expired token regardless of whether its nonce is still in the store.
 *
 * In-process, like the rate-limit token bucket in `validate-rest-operation.ts`:
 * the single-use guarantee is exact WITHIN a process (the check-and-set is
 * synchronous, so two concurrent replays can't both win). Across replicas a
 * captured token could in principle be replayed on a different instance before
 * its short TTL — the same multi-instance caveat the rate-limit bucket documents.
 * A process restart drops the store, which only invalidates pending confirms
 * (fail-safe). Reset between tests via {@link _resetRestConfirmNonces}.
 */
const burnedNonces = new Map<string, number>();

/**
 * Atomically consume a confirm nonce. Returns `true` when it was newly burned
 * (caller may proceed to dispatch), `false` when it was already burned (a replay —
 * caller must reject). MUST be called synchronously with no intervening `await`
 * between token verification and dispatch, so concurrent replays of the same token
 * can't both pass before the nonce is recorded.
 */
export function burnRestConfirmNonce(
  nonce: string,
  expSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  // Opportunistic eviction of expired entries (store is small — short TTL, low
  // volume). Deleting during Map iteration is safe.
  for (const [n, exp] of burnedNonces) {
    if (exp <= nowSeconds) burnedNonces.delete(n);
  }
  if (burnedNonces.has(nonce)) return false; // replay
  burnedNonces.set(nonce, expSeconds);
  return true;
}

/** Clear the burned-nonce store. For tests. */
export function _resetRestConfirmNonces(): void {
  burnedNonces.clear();
}

// ─────────────────────────────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * The effective confirm-token TTL in seconds. Per-call override (tests) takes
 * precedence; otherwise read `ATLAS_OPENAPI_CONFIRM_TTL_SECONDS`, clamped
 * [60, 3600], defaulting to 600. Mirrors `ATLAS_OAUTH_STATE_TTL_SECONDS`.
 */
function resolveConfirmTtlSeconds(override?: number): number {
  if (override !== undefined) {
    if (Number.isFinite(override) && override >= 1) return Math.floor(override);
    return DEFAULT_TTL_SECONDS;
  }
  const raw = process.env.ATLAS_OPENAPI_CONFIRM_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_TTL_SECONDS || parsed > MAX_TTL_SECONDS) {
    log.warn(
      { ATLAS_OPENAPI_CONFIRM_TTL_SECONDS: raw, min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS },
      "Ignoring out-of-range ATLAS_OPENAPI_CONFIRM_TTL_SECONDS — using default",
    );
    return DEFAULT_TTL_SECONDS;
  }
  return parsed;
}

/** sha256 hex of the canonicalized params — order-stable, so equal params hash equally. */
function paramsHash(params: OperationParams): string {
  return crypto.createHash("sha256").update(canonicalize(params)).digest("hex");
}

/**
 * Deterministic JSON serialization: object keys sorted recursively, `undefined`
 * object values dropped, array order preserved (query array values are
 * order-significant). So the same logical params always produce the same string
 * (and thus the same {@link paramsHash}), regardless of key insertion order.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** base64url-encode a JSON value (native — no hand-rolled regex strip). */
function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Decode a base64url JSON segment to `T`, or `null` on any parse failure. Only
 * called AFTER signature verification, so a tampered segment has already been
 * rejected; this just guards against a structurally-broken (but somehow signed)
 * payload.
 */
function decodeJson<T>(b64: string): T | null {
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as T;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    // intentionally ignored: a malformed segment collapses to null, which the
    // caller maps to a uniform rejection — the contract is boolean-shaped.
    return null;
  }
}
