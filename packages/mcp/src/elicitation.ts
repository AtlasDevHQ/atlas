/**
 * Elicitation adapter — masked form-mode behind a thin seam (#3499 /
 * ADR-0016, spec 2025-11-25).
 *
 * A tool can ask the client for a single field mid-call via
 * `elicitMaskedField`. The entered value travels client→server out of band
 * and NEVER enters the agent/LLM context — which is the real security goal
 * for credentials. The adapter returns the value to the *server-side*
 * caller; it is the caller's contract never to echo it into a tool result.
 * (The 2025-11-25 form schema has no "password" primitive, so visual masking
 * is the client's rendering responsibility; the out-of-band delivery is the
 * structural guarantee.)
 *
 * ## Why a seam
 *
 * The 2026-07-28 draft replaces in-session elicitation delivery with the
 * stateless MRTR model, where server-held state is round-tripped through the
 * (attacker-controlled) client. Isolating every `elicitInput` call here
 * makes that migration a one-file edit. To be aligned with the draft's
 * attacker-controlled-state model **from day one**, the `requestState` this
 * adapter mints is:
 *
 *   - **HMAC-signed** (tamper-evident) with a key derived from
 *     `BETTER_AUTH_SECRET` — no new env knob;
 *   - **principal-bound** — a state minted for principal A can't authorize a
 *     value consumed under principal B;
 *   - **TTL-bounded** — expires so a captured state is useless after a window;
 *   - **single-use (anti-replay)** — a {@link NonceStore} consumes the nonce
 *     on verify, so the same state can't be replayed.
 *
 * Today the SDK correlates request/response by JSON-RPC id, so the state is
 * purely server-held: minted locally before the call, verified locally when
 * the value is consumed. In the MRTR model the state will instead be carried
 * by the client — the verify path here is already the single place that
 * change lands.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const REQUEST_STATE_VERSION = "v1";

/** Default validity window for a minted requestState. */
export const DEFAULT_REQUEST_STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Default property key for the single elicited field. */
const DEFAULT_FIELD_NAME = "value";

// --- Errors -----------------------------------------------------------------

/** Why a requestState failed verification, or why elicitation couldn't run. */
export type ElicitationFailureCode =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "principal_mismatch"
  | "replayed"
  | "missing_secret"
  | "empty_value";

/**
 * Raised when a requestState fails verification or the masked field comes
 * back empty. Carries a discriminating `code` so a caller maps it to an
 * envelope without string-matching the message.
 */
export class ElicitationError extends Error {
  override readonly name = "ElicitationError";
  readonly code: ElicitationFailureCode;
  constructor(code: ElicitationFailureCode, message?: string) {
    super(message ?? `elicitation failed: ${code}`);
    this.code = code;
  }
}

// --- requestState: HMAC-signed, principal-bound, TTL'd, single-use ----------

/** Decoded requestState body. `nonce` is the anti-replay token. */
export interface RequestStatePayload {
  readonly v: 1;
  /** Principal (e.g. workspace/actor id) the state is bound to. */
  readonly principal: string;
  /** What the state authorizes (e.g. `elicit:apiKey`) — namespacing only. */
  readonly purpose: string;
  /** Single-use anti-replay nonce. */
  readonly nonce: string;
  /** Issued-at (epoch ms). */
  readonly iat: number;
  /** Expiry (epoch ms). */
  readonly exp: number;
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function hmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/**
 * Derive a dedicated elicitation signing key from `BETTER_AUTH_SECRET` so the
 * raw auth secret is never used directly. Throws {@link ElicitationError}
 * (`missing_secret`) when the deployment has no auth secret configured —
 * elicitation is only reachable on hosted/governed deployments, which always
 * set it.
 */
export function resolveElicitationSecret(): string {
  const base = process.env.BETTER_AUTH_SECRET;
  if (!base) throw new ElicitationError("missing_secret");
  return createHmac("sha256", base)
    .update("atlas:mcp:elicitation:requestState")
    .digest("hex");
}

/**
 * Mint a signed requestState. Token shape: `v1.<payloadB64url>.<sigB64url>`.
 * `nonce` / `now` are injectable for tests; production leaves them unset.
 */
export function signRequestState(
  input: {
    principal: string;
    purpose: string;
    ttlMs?: number;
    now?: number;
    nonce?: string;
  },
  secret: string,
): string {
  const iat = input.now ?? Date.now();
  const payload: RequestStatePayload = {
    v: 1,
    principal: input.principal,
    purpose: input.purpose,
    nonce: input.nonce ?? randomBytes(16).toString("hex"),
    iat,
    exp: iat + (input.ttlMs ?? DEFAULT_REQUEST_STATE_TTL_MS),
  };
  const body = b64url(JSON.stringify(payload));
  return `${REQUEST_STATE_VERSION}.${body}.${hmac(body, secret)}`;
}

export type VerifyRequestStateResult =
  | { readonly ok: true; readonly payload: RequestStatePayload }
  | { readonly ok: false; readonly reason: ElicitationFailureCode };

/**
 * Verify a requestState: signature (constant-time), principal binding, TTL,
 * and — when a {@link NonceStore} is supplied — single-use (anti-replay).
 * The nonce is consumed on the first successful verify, so a second verify of
 * the same token against the same store fails with `replayed`.
 */
export function verifyRequestState(
  token: string,
  opts: {
    principal: string;
    secret: string;
    now?: number;
    nonceStore?: NonceStore;
  },
): VerifyRequestStateResult {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== REQUEST_STATE_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  const [, body, sig] = parts;

  const expectedSig = hmac(body, opts.secret);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: RequestStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as RequestStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.v !== 1 || typeof payload.nonce !== "string") {
    return { ok: false, reason: "malformed" };
  }

  if (payload.principal !== opts.principal) {
    return { ok: false, reason: "principal_mismatch" };
  }

  const now = opts.now ?? Date.now();
  if (now >= payload.exp) {
    return { ok: false, reason: "expired" };
  }

  // Anti-replay last: only burn the nonce once everything else checks out, so
  // a tampered/expired token can be retried with a fresh state.
  if (opts.nonceStore && !opts.nonceStore.consume(payload.nonce, payload.exp, now)) {
    return { ok: false, reason: "replayed" };
  }

  return { ok: true, payload };
}

/**
 * In-memory single-use nonce ledger for requestState anti-replay. Process-
 * local — sufficient for the in-session model where a session is pinned to
 * one process. The MRTR migration will swap this for a shared store; the
 * `consume` contract is the seam.
 */
export class NonceStore {
  private readonly seen = new Map<string, number>();

  /**
   * Record `nonce`, returning `true` if it was unseen (proceed) or `false`
   * if it's a replay. Expired entries are pruned opportunistically so the
   * map can't grow without bound.
   */
  consume(nonce: string, exp: number, now: number = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, exp);
    return true;
  }

  private prune(now: number): void {
    for (const [nonce, exp] of this.seen) {
      if (exp <= now) this.seen.delete(nonce);
    }
  }

  /** Test-only: drop all recorded nonces. */
  clear(): void {
    this.seen.clear();
  }
}

/** Process-wide default nonce ledger used when a caller doesn't inject one. */
const defaultNonceStore = new NonceStore();

// --- The masked-field elicitation call --------------------------------------

export interface MaskedFieldSpec {
  /** Property key on the returned form object. Defaults to `"value"`. */
  readonly name?: string;
  /** Human-facing field label shown by the client. */
  readonly title: string;
  /** Optional field help text (e.g. "entered securely; never shared with the agent"). */
  readonly description?: string;
}

export type ElicitMaskedOutcome =
  | { readonly action: "accept"; readonly value: string }
  | { readonly action: "decline" | "cancel" };

export interface ElicitMaskedArgs {
  /** Principal the elicitation is bound to (workspace/actor id). */
  readonly principal: string;
  /** Prompt shown to the user. */
  readonly message: string;
  /** The single field to collect. */
  readonly field: MaskedFieldSpec;
  /** Validity window for the minted requestState. */
  readonly ttlMs?: number;
  /** Signing secret. Defaults to {@link resolveElicitationSecret}. Injectable for tests. */
  readonly secret?: string;
  /** Anti-replay ledger. Defaults to the process-wide store. Injectable for tests. */
  readonly nonceStore?: NonceStore;
  /** Abort signal so a long-pending elicitation can be cancelled. */
  readonly signal?: AbortSignal;
}

/**
 * Ask the client for a single masked field mid-call.
 *
 * Flow: mint a server-held requestState (principal-bound, TTL'd) → send a
 * form-mode `elicitInput` for one string field → on `accept`, verify+consume
 * the requestState (binding the value-consumption to the principal, the
 * window, and a single use) → return the entered value to the caller.
 *
 * The returned value is NEVER logged or placed in a tool result by this
 * adapter — keeping it out of the agent/LLM context is the whole point.
 */
export async function elicitMaskedField(
  server: McpServer,
  args: ElicitMaskedArgs,
): Promise<ElicitMaskedOutcome> {
  // Thin wrapper over the multi-field {@link elicitMaskedForm} (a single
  // required field) — the mint → elicit → verify → single-use-consume sequence
  // lives in ONE place, so the MRTR-migration hardening this seam exists for
  // can't drift between a single- and multi-field copy.
  const fieldName = args.field.name ?? DEFAULT_FIELD_NAME;
  const outcome = await elicitMaskedForm(server, {
    principal: args.principal,
    message: args.message,
    fields: [
      {
        name: fieldName,
        title: args.field.title,
        ...(args.field.description ? { description: args.field.description } : {}),
        required: true,
        secret: true,
      },
    ],
    ...(args.ttlMs != null ? { ttlMs: args.ttlMs } : {}),
    ...(args.secret ? { secret: args.secret } : {}),
    ...(args.nonceStore ? { nonceStore: args.nonceStore } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });

  if (outcome.action !== "accept") {
    return { action: outcome.action };
  }
  // elicitMaskedForm drops empty values, so a missing key means the client
  // returned an empty value for this required field — preserve the original
  // single-field contract of failing closed on empty.
  const value = outcome.values[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    throw new ElicitationError("empty_value");
  }
  return { action: "accept", value };
}

// --- Multi-field masked form elicitation ------------------------------------

/** One field in a masked elicitation form. */
export interface MaskedFormField {
  /** Property key on the returned form object + in the built schema. */
  readonly name: string;
  /** Human-facing label shown by the client. */
  readonly title: string;
  /** Optional help text. */
  readonly description?: string;
  /** Whether the client must collect this field (drives the schema `required` list). */
  readonly required?: boolean;
  /**
   * Marks the field as a credential. The 2025-11-25 form schema has no
   * "password" primitive, so this is a hint the client SHOULD render masked;
   * the structural guarantee is the out-of-band delivery, identical for every
   * field. Recorded so a caller can know which returned values are secrets.
   */
  readonly secret?: boolean;
}

export type ElicitMaskedFormOutcome =
  | { readonly action: "accept"; readonly values: Record<string, string> }
  | { readonly action: "decline" | "cancel" };

export interface ElicitMaskedFormArgs {
  readonly principal: string;
  readonly message: string;
  /** The fields to collect in one form. At least one required field is expected. */
  readonly fields: readonly MaskedFormField[];
  readonly ttlMs?: number;
  readonly secret?: string;
  readonly nonceStore?: NonceStore;
  readonly signal?: AbortSignal;
}

/**
 * Ask the client for SEVERAL fields in one masked form mid-call — the
 * multi-field sibling of {@link elicitMaskedField}, for credentials whose shape
 * isn't a single `url` (e.g. Elasticsearch `apiKey` + `url`, BigQuery
 * `service_account_json` + `project_id`).
 *
 * Same security contract as the single-field call: the entered values travel
 * client→server out of band and NEVER enter the agent/LLM context, and a single
 * principal-bound, TTL'd, single-use requestState authorizes consuming the whole
 * form. The returned values are the caller's to use for connect/persist only —
 * never to echo into a tool result. Empty optional fields are omitted; the
 * caller validates required-field presence against its own schema.
 */
export async function elicitMaskedForm(
  server: McpServer,
  args: ElicitMaskedFormArgs,
): Promise<ElicitMaskedFormOutcome> {
  const secret = args.secret ?? resolveElicitationSecret();
  const nonceStore = args.nonceStore ?? defaultNonceStore;

  const requestState = signRequestState(
    {
      principal: args.principal,
      purpose: "elicit:form",
      ...(args.ttlMs != null ? { ttlMs: args.ttlMs } : {}),
    },
    secret,
  );

  const properties: Record<string, { type: "string"; title: string; description?: string }> = {};
  const required: string[] = [];
  for (const field of args.fields) {
    properties[field.name] = {
      type: "string",
      title: field.title,
      ...(field.description ? { description: field.description } : {}),
    };
    if (field.required) required.push(field.name);
  }

  const result = await server.server.elicitInput(
    {
      mode: "form",
      message: args.message,
      requestedSchema: { type: "object", properties, required },
    },
    args.signal ? { signal: args.signal } : undefined,
  );

  if (result.action !== "accept") {
    return { action: result.action };
  }

  // Bind value-consumption to the issued state: principal + TTL + single use.
  const verified = verifyRequestState(requestState, {
    principal: args.principal,
    secret,
    nonceStore,
  });
  if (!verified.ok) {
    throw new ElicitationError(verified.reason);
  }

  // Collect every non-blank string value. Empty/omitted/whitespace-only optionals
  // are dropped so a blank field never persists as an empty credential (and the
  // caller's required-field check, which tests key presence, then catches a
  // blank required field instead of probing it as a present-but-empty value).
  // The original (untrimmed) value is preserved when non-blank — a credential may
  // legitimately carry internal whitespace; only the emptiness test trims.
  const values: Record<string, string> = {};
  for (const field of args.fields) {
    const raw = result.content?.[field.name];
    if (typeof raw === "string" && raw.trim().length > 0) values[field.name] = raw;
  }
  return { action: "accept", values };
}
