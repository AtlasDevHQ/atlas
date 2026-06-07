/**
 * Minimal pure-JS AWS Signature Version 4 signer for the Elasticsearch /
 * OpenSearch datasource plugin (#3265 — Amazon OpenSearch Service / IAM-protected
 * domains).
 *
 * Why hand-rolled, not the AWS SDK: the connector talks to the cluster over a
 * thin `fetch` client with no vendor SDK, and the full `@aws-sdk/*` signer pulls
 * a large dependency tree into a published plugin. SigV4 is a small, well-specced
 * HMAC-SHA256 chain, so this module implements exactly the surface the client
 * needs — sign a single `fetch` request — using only `node:crypto`.
 *
 * The three pieces are exported independently so each is unit-testable in
 * isolation against AWS's documented test vectors:
 *   1. {@link deriveSigningKey} — the four-stage HMAC key derivation. Verified
 *      against the canonical AWS "derive a signing key" example.
 *   2. {@link buildCanonicalRequest} — the canonical request string (PURE).
 *   3. {@link sigV4SignHeaders} — composes 1+2 into the signed request headers.
 *
 * Scope: signs the minimal header set AWS requires — `host`, `x-amz-date`,
 * `x-amz-content-sha256` (+ `x-amz-security-token` when a session token is
 * present). Other headers (`Accept`, `Content-Type`) ride along unsigned, which
 * Amazon OpenSearch Service accepts. The signer is deliberately request-scoped:
 * every health/query/mapping request is signed fresh with its own method, path,
 * query, and body.
 */

import { createHash, createHmac } from "node:crypto";

/** SHA-256 of `""` — the payload hash for a body-less (GET) request. */
export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ALGORITHM = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";

/** Hex-encoded SHA-256 of `data`. */
function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Raw HMAC-SHA256 of `data` keyed by `key` (string or Buffer). */
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 percent-encoding used for the canonical query string. Encodes every
 * character outside the unreserved set; AWS requires this (stricter than
 * `encodeURIComponent`, which leaves `!*'()` unescaped).
 */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Format a {@link Date} into the SigV4 `amzDate` (`YYYYMMDDTHHMMSSZ`) and
 * `dateStamp` (`YYYYMMDD`, the credential-scope day). UTC, no separators.
 */
export function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  // "2015-08-30T12:36:00.000Z" → "20150830T123600Z"
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Canonical query string: each `key=value` RFC-3986 encoded and sorted by
 * encoded key (ties broken by encoded value). Returns `""` for no params.
 */
function canonicalQueryString(searchParams: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of searchParams) {
    pairs.push([rfc3986Encode(key), rfc3986Encode(value)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** The headers SigV4 signs here, with their values. Always lowercase keys. */
export interface SignedHeaderInput {
  host: string;
  amzDate: string;
  payloadHash: string;
  sessionToken?: string;
}

/**
 * PURE: build the SigV4 canonical request string.
 *
 * ```
 * <METHOD>\n
 * <CanonicalURI>\n
 * <CanonicalQueryString>\n
 * <CanonicalHeaders>\n      (each "name:value\n", sorted, lowercased)
 * <SignedHeaders>\n         (";"-joined sorted header names)
 * <HashedPayload>
 * ```
 *
 * The canonical URI is the request path used verbatim (our paths — `/`,
 * `/_sql`, `/_plugins/_sql`, `/<index>/_mapping` — are already in the encoded
 * form they travel on the wire), defaulting to `/` when empty. Returns the
 * canonical request plus the computed `signedHeaders` list so the caller's
 * Authorization header and this string can't disagree on which headers were
 * signed.
 */
export function buildCanonicalRequest(
  method: string,
  path: string,
  searchParams: URLSearchParams,
  headers: SignedHeaderInput,
): { canonicalRequest: string; signedHeaders: string } {
  const canonicalUri = path && path.length > 0 ? path : "/";

  // Header name → value for the headers we sign. Sorted by name for both the
  // canonical-headers block and the signed-headers list.
  const headerMap: Record<string, string> = {
    host: headers.host,
    "x-amz-content-sha256": headers.payloadHash,
    "x-amz-date": headers.amzDate,
  };
  if (headers.sessionToken) {
    headerMap["x-amz-security-token"] = headers.sessionToken;
  }

  const sortedNames = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headerMap[n].trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString(searchParams),
    canonicalHeaders,
    signedHeaders,
    headers.payloadHash,
  ].join("\n");

  return { canonicalRequest, signedHeaders };
}

/**
 * The four-stage SigV4 signing-key derivation:
 * `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`.
 *
 * Verified against AWS's documented example (secret
 * `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`, `20120215`, `us-east-1`, `iam`).
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, TERMINATOR);
}

/** Inputs for a single request signature. */
export interface SigV4SignInput {
  method: string;
  /** Full request URL (scheme://host[:port]/path?query). */
  url: string;
  /** Request body as it will be sent (`""` for a GET). */
  body: string;
  region: string;
  /** AWS service code — `es` (managed Elasticsearch) or `aoss`/`es` for OpenSearch. */
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Injectable clock for deterministic tests. Defaults to the current time. */
  date?: Date;
}

/**
 * Sign a single request and return the headers to add to it: `Authorization`,
 * `X-Amz-Date`, `X-Amz-Content-Sha256`, and `X-Amz-Security-Token` when a
 * session token is configured. The caller merges these with its own
 * `Accept` / `Content-Type` (which are sent unsigned).
 */
export function sigV4SignHeaders(input: SigV4SignInput): Record<string, string> {
  const parsed = new URL(input.url);
  const date = input.date ?? new Date();
  const { amzDate, dateStamp } = formatAmzDate(date);
  const payloadHash = input.body.length === 0 ? EMPTY_PAYLOAD_SHA256 : sha256Hex(input.body);

  const { canonicalRequest, signedHeaders } = buildCanonicalRequest(
    input.method,
    parsed.pathname,
    parsed.searchParams,
    {
      host: parsed.host,
      amzDate,
      payloadHash,
      sessionToken: input.sessionToken,
    },
  );

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/${TERMINATOR}`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    input.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization =
    `${ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: Record<string, string> = {
    Authorization: authorization,
    "X-Amz-Date": amzDate,
    "X-Amz-Content-Sha256": payloadHash,
  };
  if (input.sessionToken) {
    out["X-Amz-Security-Token"] = input.sessionToken;
  }
  return out;
}
