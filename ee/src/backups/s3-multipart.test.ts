/**
 * S3 multipart housekeeping tests (#4727).
 *
 * Exercised against an injected `fetch` — no network. The assertions pin the
 * three things that would silently break in production: the request shape
 * (path/virtual-hosted addressing, `?uploads` canonical query, SigV4 header
 * set), the paging loop's termination, and the unsupported-endpoint
 * degradation that keeps a purge cycle green on stores without the API.
 */

import { describe, it, expect } from "bun:test";

import {
  createS3MultipartOps,
  parseListMultipartUploads,
  S3MultipartUnsupportedError,
} from "./s3-multipart";

type Call = { url: string; method: string; headers: Record<string, string> };

function fakeFetch(responses: { status: number; body: string }[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const res = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve(new Response(res.body, { status: res.status }));
  };
  return { impl, calls };
}

function uploadsXml(
  uploads: { key: string; uploadId: string; initiated: string }[],
  extra: { isTruncated?: boolean; nextKeyMarker?: string; nextUploadIdMarker?: string } = {},
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult>
  <Bucket>atlas-backups</Bucket>
  <IsTruncated>${extra.isTruncated ? "true" : "false"}</IsTruncated>
  ${extra.nextKeyMarker ? `<NextKeyMarker>${extra.nextKeyMarker}</NextKeyMarker>` : ""}
  ${extra.nextUploadIdMarker ? `<NextUploadIdMarker>${extra.nextUploadIdMarker}</NextUploadIdMarker>` : ""}
  ${uploads
    .map(
      (u) =>
        `<Upload><Key>${u.key}</Key><UploadId>${u.uploadId}</UploadId><Initiated>${u.initiated}</Initiated></Upload>`,
    )
    .join("\n  ")}
</ListMultipartUploadsResult>`;
}

const CREDS = { bucket: "atlas-backups", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" };

// ── XML parsing ────────────────────────────────────────────────────

describe("parseListMultipartUploads", () => {
  it("extracts key / uploadId / initiated epoch ms", () => {
    const parsed = parseListMultipartUploads(
      uploadsXml([{ key: "backups/a.sql.gz", uploadId: "u1", initiated: "2026-07-01T00:00:00.000Z" }]),
    );
    expect(parsed.uploads).toEqual([
      { key: "backups/a.sql.gz", uploadId: "u1", initiatedAt: Date.parse("2026-07-01T00:00:00.000Z") },
    ]);
    expect(parsed.isTruncated).toBe(false);
  });

  it("decodes XML entities in keys", () => {
    const parsed = parseListMultipartUploads(
      uploadsXml([{ key: "backups/a&amp;b.sql.gz", uploadId: "u1", initiated: "2026-07-01T00:00:00.000Z" }]),
    );
    expect(parsed.uploads[0].key).toBe("backups/a&b.sql.gz");
  });

  it("drops uploads with an unparseable Initiated rather than guessing their age", () => {
    const parsed = parseListMultipartUploads(
      uploadsXml([
        { key: "backups/bad.sql.gz", uploadId: "u1", initiated: "not-a-date" },
        { key: "backups/good.sql.gz", uploadId: "u2", initiated: "2026-07-01T00:00:00.000Z" },
      ]),
    );
    expect(parsed.uploads.map((u) => u.key)).toEqual(["backups/good.sql.gz"]);
  });

  it("reads the truncation markers", () => {
    const parsed = parseListMultipartUploads(
      uploadsXml([{ key: "k", uploadId: "u", initiated: "2026-07-01T00:00:00.000Z" }], {
        isTruncated: true,
        nextKeyMarker: "k",
        nextUploadIdMarker: "u",
      }),
    );
    expect(parsed.isTruncated).toBe(true);
    expect(parsed.nextKeyMarker).toBe("k");
    expect(parsed.nextUploadIdMarker).toBe("u");
  });

  it("returns an empty page for a result with no uploads", () => {
    const parsed = parseListMultipartUploads(uploadsXml([]));
    expect(parsed.uploads).toEqual([]);
    expect(parsed.isTruncated).toBe(false);
  });
});

// ── Construction ───────────────────────────────────────────────────

describe("createS3MultipartOps", () => {
  it("returns null without static credentials (a clean no-op, not an error)", () => {
    expect(createS3MultipartOps({ bucket: "b" })).toBeNull();
    expect(createS3MultipartOps({ bucket: "b", accessKeyId: "a" })).toBeNull();
    expect(createS3MultipartOps({ bucket: "b", secretAccessKey: "s" })).toBeNull();
  });

  it("addresses an explicit endpoint path-style and real AWS virtual-hosted", async () => {
    const pathStyle = fakeFetch([{ status: 200, body: uploadsXml([]) }]);
    await createS3MultipartOps(
      { ...CREDS, endpoint: "https://bucket.railway.app/" },
      pathStyle.impl,
    )!.listInProgress("backups/");
    expect(pathStyle.calls[0].url.startsWith("https://bucket.railway.app/atlas-backups?")).toBe(true);

    const virtualHosted = fakeFetch([{ status: 200, body: uploadsXml([]) }]);
    await createS3MultipartOps({ ...CREDS, region: "eu-west-1" }, virtualHosted.impl)!.listInProgress("backups/");
    expect(
      virtualHosted.calls[0].url.startsWith("https://atlas-backups.s3.eu-west-1.amazonaws.com/?"),
    ).toBe(true);
  });

  it("keeps an endpoint's own path prefix ahead of the bucket", async () => {
    const fake = fakeFetch([{ status: 200, body: uploadsXml([]) }]);
    await createS3MultipartOps({ ...CREDS, endpoint: "https://gw.example.com/s3/" }, fake.impl)!.listInProgress(
      "backups/",
    );
    expect(fake.calls[0].url.startsWith("https://gw.example.com/s3/atlas-backups?")).toBe(true);
  });
});

// ── listInProgress ─────────────────────────────────────────────────

describe("listInProgress", () => {
  it("signs the request with SigV4 and queries ?uploads with the prefix", async () => {
    const fake = fakeFetch([{ status: 200, body: uploadsXml([]) }]);
    const ops = createS3MultipartOps({ ...CREDS, endpoint: "https://s3.example.com" }, fake.impl)!;

    await ops.listInProgress("backups/");

    const call = fake.calls[0];
    expect(call.method).toBe("GET");
    expect(call.url).toContain("prefix=backups%2F");
    // `uploads` is a valueless subresource — canonically `uploads=`.
    expect(call.url).toContain("uploads=");
    expect(call.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(call.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    // Empty-body SHA-256 — the constant every bodyless SigV4 request uses.
    expect(call.headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("includes a session token in the signed header set when configured", async () => {
    const fake = fakeFetch([{ status: 200, body: uploadsXml([]) }]);
    const ops = createS3MultipartOps({ ...CREDS, sessionToken: "tok" }, fake.impl)!;

    await ops.listInProgress("backups/");
    expect(fake.calls[0].headers["x-amz-security-token"]).toBe("tok");
    expect(fake.calls[0].headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });

  it("pages until IsTruncated clears, carrying both markers forward", async () => {
    const fake = fakeFetch([
      {
        status: 200,
        body: uploadsXml([{ key: "backups/a.sql.gz", uploadId: "u1", initiated: "2026-07-01T00:00:00.000Z" }], {
          isTruncated: true,
          nextKeyMarker: "backups/a.sql.gz",
          nextUploadIdMarker: "u1",
        }),
      },
      {
        status: 200,
        body: uploadsXml([{ key: "backups/b.sql.gz", uploadId: "u2", initiated: "2026-07-02T00:00:00.000Z" }]),
      },
    ]);
    const ops = createS3MultipartOps(CREDS, fake.impl)!;

    const listing = await ops.listInProgress("backups/");
    expect(listing.uploads.map((u) => u.uploadId)).toEqual(["u1", "u2"]);
    expect(listing.truncated).toBe(false);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].url).toContain("key-marker=backups%2Fa.sql.gz");
    expect(fake.calls[1].url).toContain("upload-id-marker=u1");
  });

  it("terminates when a truncated page carries no markers", async () => {
    const fake = fakeFetch([{ status: 200, body: uploadsXml([], { isTruncated: true }) }]);
    const ops = createS3MultipartOps(CREDS, fake.impl)!;

    expect(await ops.listInProgress("backups/")).toEqual({ uploads: [], truncated: false });
    expect(fake.calls).toHaveLength(1);
  });

  it("reports truncated:true rather than looping forever when the page cap is hit", async () => {
    // Every page claims more to come — the cap is the only thing that stops it.
    const fake = fakeFetch([
      {
        status: 200,
        body: uploadsXml([{ key: "backups/a.sql.gz", uploadId: "u1", initiated: "2026-07-01T00:00:00.000Z" }], {
          isTruncated: true,
          nextKeyMarker: "backups/a.sql.gz",
          nextUploadIdMarker: "u1",
        }),
      },
    ]);
    const ops = createS3MultipartOps(CREDS, fake.impl)!;

    const listing = await ops.listInProgress("backups/");
    expect(listing.truncated).toBe(true);
    expect(fake.calls).toHaveLength(50);
    // The batch is still returned so the caller can make partial progress.
    expect(listing.uploads).toHaveLength(50);
  });

  it("signs a key containing % / ? / # without mangling it", async () => {
    const fake = fakeFetch([{ status: 204, body: "" }]);
    const ops = createS3MultipartOps({ ...CREDS, endpoint: "https://s3.example.com" }, fake.impl)!;

    // A literal `%` used to blow up the old decodeURIComponent round-trip;
    // `?`/`#` used to be swallowed by URL parsing.
    await ops.abort("backups/od%d?x#y.sql.gz", "u1");

    // `/` stays a separator (S3 canonical-URI rule); everything else escapes.
    expect(fake.calls[0].url).toBe(
      "https://s3.example.com/atlas-backups/backups/od%25d%3Fx%23y.sql.gz?uploadId=u1",
    );
  });

  it.each([400, 403, 404, 405, 501])(
    "reports HTTP %i as unsupported so the purge cycle degrades to a no-op",
    async (status) => {
      const fake = fakeFetch([{ status, body: "<Error><Code>NotImplemented</Code></Error>" }]);
      const ops = createS3MultipartOps(CREDS, fake.impl)!;

      await expect(ops.listInProgress("backups/")).rejects.toBeInstanceOf(S3MultipartUnsupportedError);
    },
  );

  it("surfaces a server-side failure as a plain error (retried next cycle)", async () => {
    const fake = fakeFetch([{ status: 500, body: "<Error/>" }]);
    const ops = createS3MultipartOps(CREDS, fake.impl)!;

    await expect(ops.listInProgress("backups/")).rejects.toThrow("HTTP 500");
  });
});

// ── abort ──────────────────────────────────────────────────────────

describe("abort", () => {
  it("issues a signed DELETE against the key with the uploadId", async () => {
    const fake = fakeFetch([{ status: 204, body: "" }]);
    const ops = createS3MultipartOps({ ...CREDS, endpoint: "https://s3.example.com" }, fake.impl)!;

    await ops.abort("backups/a.sql.gz", "u1");

    expect(fake.calls[0].method).toBe("DELETE");
    expect(fake.calls[0].url).toBe("https://s3.example.com/atlas-backups/backups/a.sql.gz?uploadId=u1");
    expect(fake.calls[0].headers.authorization).toContain("AWS4-HMAC-SHA256");
  });

  it("treats 404 as success — another replica already aborted it", async () => {
    const fake = fakeFetch([{ status: 404, body: "<Error><Code>NoSuchUpload</Code></Error>" }]);
    const ops = createS3MultipartOps(CREDS, fake.impl)!;
    await ops.abort("backups/a.sql.gz", "u1");
  });

  it("rejects on any other failure status", async () => {
    const fake = fakeFetch([{ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" }]);
    const ops = createS3MultipartOps(CREDS, fake.impl)!;

    await expect(ops.abort("backups/a.sql.gz", "u1")).rejects.toThrow("HTTP 403");
  });
});
