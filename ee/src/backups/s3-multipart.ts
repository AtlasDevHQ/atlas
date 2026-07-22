/**
 * S3 multipart-upload housekeeping (#4727).
 *
 * A failed backup upload deliberately never calls `end()` (finalizing would
 * produce a truncated object that could pass a header-only verify — see
 * `storage.ts`), so the parts already uploaded stay behind as an *incomplete
 * multipart upload*: billable storage that never appears in a `ListObjects`
 * listing. The standard remedy is a bucket lifecycle rule expiring incomplete
 * multipart uploads — but **Railway buckets do not support lifecycle
 * configuration** (create/delete/info/credentials/rename only), so on the
 * hosted SaaS the platform cannot do this for us. Atlas therefore self-heals:
 * the retention purge lists in-progress uploads under the backup prefix and
 * aborts the stale ones.
 *
 * Why raw SigV4 instead of `Bun.S3Client`: Bun's client covers object-level
 * operations (`file`/`list`/`delete`) and exposes neither
 * `ListMultipartUploads` nor `AbortMultipartUpload`. Those are two plain
 * signed HTTP requests, so this module signs them directly with the same
 * credentials the driver already holds — no new dependency, no client fork.
 *
 * Degradation is deliberate and total: no credentials, an endpoint that
 * doesn't implement the multipart-listing API, or any other refusal must
 * never fail a backup cycle. `listInProgress` reports "unsupported" via
 * {@link S3MultipartUnsupportedError} and the caller no-ops at debug level.
 */

import { createHash, createHmac } from "crypto";

/** An in-progress (unfinalized) multipart upload. */
export interface InProgressUpload {
  key: string;
  uploadId: string;
  /** Epoch ms the upload was initiated. `NaN` is never produced — unparseable dates are dropped. */
  initiatedAt: number;
}

/**
 * Raised when the endpoint does not implement the multipart housekeeping
 * APIs (some S3-compatible stores answer `501 NotImplemented`, `405`, or an
 * `AccessDenied` for the bucket-level `?uploads` query). Callers treat this
 * as "nothing to do", never as a failure.
 */
export class S3MultipartUnsupportedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "S3MultipartUnsupportedError";
    this.status = status;
  }
}

export interface S3MultipartOps {
  /** In-progress multipart uploads whose key starts with `prefix` (paged to exhaustion). */
  listInProgress(prefix: string): Promise<InProgressUpload[]>;
  /** Abort one upload, discarding its parts. */
  abort(key: string, uploadId: string): Promise<void>;
}

export interface S3MultipartConfig {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/** SigV4 requires a region even for endpoints that ignore it. */
const DEFAULT_REGION = "us-east-1";
/** One page of `ListMultipartUploads`; the caller pages until `IsTruncated` clears. */
const MAX_UPLOADS_PER_PAGE = 1000;
/** Defensive bound so a pathological listing can't spin the purge forever. */
const MAX_PAGES = 50;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>;

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` unescaped, which AWS
 * requires escaped in canonical requests — a key containing one of them would
 * otherwise produce a signature mismatch.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `YYYYMMDDTHHMMSSZ` — the `x-amz-date` format. */
function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[:-]/g, "").split(".")[0]}Z`;
}

/**
 * Build a SigV4-signed request. Body is always empty (both operations are
 * bodyless), so the payload hash is the constant empty-string digest.
 */
function signedRequest(
  config: S3MultipartConfig,
  method: "GET" | "DELETE",
  baseUrl: string,
  query: Record<string, string>,
  now: Date,
): { url: string; headers: Record<string, string> } {
  const { accessKeyId, secretAccessKey } = config;
  if (!accessKeyId || !secretAccessKey) {
    // Guarded by createS3MultipartOps; belt-and-braces so a future caller
    // can't produce an unsigned request that silently 403s.
    throw new Error("S3 multipart housekeeping requires accessKeyId + secretAccessKey");
  }
  const region = config.region || DEFAULT_REGION;
  const url = new URL(baseUrl);

  const canonicalQuery = Object.keys(query)
    .toSorted()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k])}`)
    .join("&");

  // The path is `/bucket[/key]`; each segment is encoded independently so `/`
  // stays a separator.
  const canonicalUri =
    url.pathname === "" ? "/" : url.pathname.split("/").map((s) => encodeRfc3986(decodeURIComponent(s))).join("/");

  const payloadHash = sha256Hex("");
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
    ...(config.sessionToken && { "x-amz-security-token": config.sessionToken }),
  };
  const signedHeaderNames = Object.keys(headers).toSorted();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${url.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    headers,
  };
}

// ---------------------------------------------------------------------------
// XML (ListMultipartUploadsResult) — regex-scoped, no parser dependency
// ---------------------------------------------------------------------------

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    // &amp; last so "&amp;lt;" decodes to "&lt;", not "<".
    .replace(/&amp;/g, "&");
}

function tagText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXmlEntities(match[1]) : null;
}

export interface ParsedUploadPage {
  uploads: InProgressUpload[];
  isTruncated: boolean;
  nextKeyMarker: string | null;
  nextUploadIdMarker: string | null;
}

/** @internal Exported for tests — parses one `ListMultipartUploadsResult` body. */
export function parseListMultipartUploads(xml: string): ParsedUploadPage {
  const uploads: InProgressUpload[] = [];
  for (const block of xml.match(/<Upload>[\s\S]*?<\/Upload>/g) ?? []) {
    const key = tagText(block, "Key");
    const uploadId = tagText(block, "UploadId");
    const initiated = tagText(block, "Initiated");
    if (!key || !uploadId || !initiated) continue;
    const initiatedAt = Date.parse(initiated);
    // An unparseable Initiated makes "older than N days" unanswerable —
    // skip rather than risk aborting an upload that is still running.
    if (Number.isNaN(initiatedAt)) continue;
    uploads.push({ key, uploadId, initiatedAt });
  }
  return {
    uploads,
    isTruncated: tagText(xml, "IsTruncated") === "true",
    nextKeyMarker: tagText(xml, "NextKeyMarker"),
    nextUploadIdMarker: tagText(xml, "NextUploadIdMarker"),
  };
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

/** Statuses that mean "this store has no multipart housekeeping", not "this call failed". */
function isUnsupportedStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 405 || status === 501;
}

/**
 * Build the multipart housekeeping ops for a bucket, or `null` when the
 * configuration cannot produce a signed request (no static credentials — e.g.
 * an IAM-role deployment where Bun's client resolves credentials itself).
 * A `null` result is a clean no-op, not an error.
 */
export function createS3MultipartOps(
  config: S3MultipartConfig,
  fetchImpl: FetchLike = ((url, init) => fetch(url, init)) as FetchLike,
): S3MultipartOps | null {
  if (!config.accessKeyId || !config.secretAccessKey) return null;

  // Path-style against an explicit endpoint (what Railway/MinIO/R2 expose);
  // virtual-hosted style against real AWS, which is the only addressing mode
  // new AWS buckets support.
  const baseUrl = config.endpoint
    ? `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}`
    : `https://${config.bucket}.s3.${config.region || DEFAULT_REGION}.amazonaws.com`;

  const send = async (
    method: "GET" | "DELETE",
    url: string,
    query: Record<string, string>,
  ): Promise<{ status: number; body: string }> => {
    const signed = signedRequest(config, method, url, query, new Date());
    const res = await fetchImpl(signed.url, { method, headers: signed.headers });
    return { status: res.status, body: await res.text() };
  };

  return {
    async listInProgress(prefix) {
      const uploads: InProgressUpload[] = [];
      let keyMarker: string | null = null;
      let uploadIdMarker: string | null = null;

      for (let page = 0; page < MAX_PAGES; page++) {
        const query: Record<string, string> = {
          uploads: "",
          "max-uploads": String(MAX_UPLOADS_PER_PAGE),
          ...(prefix && { prefix }),
          ...(keyMarker && { "key-marker": keyMarker }),
          ...(uploadIdMarker && { "upload-id-marker": uploadIdMarker }),
        };
        const { status, body } = await send("GET", baseUrl, query);
        if (isUnsupportedStatus(status)) {
          throw new S3MultipartUnsupportedError(
            `ListMultipartUploads not available on this endpoint (HTTP ${status})`,
            status,
          );
        }
        if (status < 200 || status >= 300) {
          throw new Error(`ListMultipartUploads failed with HTTP ${status}`);
        }

        const parsed = parseListMultipartUploads(body);
        uploads.push(...parsed.uploads);
        if (!parsed.isTruncated || (!parsed.nextKeyMarker && !parsed.nextUploadIdMarker)) break;
        keyMarker = parsed.nextKeyMarker;
        uploadIdMarker = parsed.nextUploadIdMarker;
      }

      return uploads;
    },

    async abort(key, uploadId) {
      const { status } = await send("DELETE", `${baseUrl}/${key}`, { uploadId });
      // 204 is the documented success; 404 means another replica already
      // aborted it — the desired end state either way.
      if (status === 404 || (status >= 200 && status < 300)) return;
      throw new Error(`AbortMultipartUpload failed with HTTP ${status}`);
    },
  } satisfies S3MultipartOps;
}
