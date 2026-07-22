/**
 * BackupStorage driver tests (#4457).
 *
 * Local driver: exercised against a real temp directory (the pre-#4457
 * behaviour it preserves). S3 driver: exercised against an injected
 * `S3ClientLike` fake — no network; the Bun-native client itself is
 * runtime-provided. Selection: env-driven, cached per process.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { Readable } from "stream";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createEEMock } from "../__mocks__/internal";

const ee = createEEMock();
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

const {
  createLocalBackupStorage,
  createS3BackupStorage,
  getBackupStorage,
  isS3BackupStorageConfigured,
  _resetBackupStorage,
} = await import("./storage");
type S3ClientLike = import("./storage").S3ClientLike;

const { S3MultipartUnsupportedError } = await import("./s3-multipart");
type S3MultipartOps = import("./s3-multipart").S3MultipartOps;
type InProgressUpload = import("./s3-multipart").InProgressUpload;

// ── Local driver ───────────────────────────────────────────────────

describe("local backup storage", () => {
  const tmp = mkdtempSync(join(tmpdir(), "atlas-backup-storage-"));

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("put streams to the path (creating parent dirs) and reports bytes written", async () => {
    const storage = createLocalBackupStorage();
    const path = join(tmp, "nested", "a.sql.gz");
    const { sizeBytes } = await storage.put(path, Readable.from([Buffer.from("hello "), Buffer.from("world")]));
    expect(sizeBytes).toBe(11);
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("getStream round-trips the artifact", async () => {
    const storage = createLocalBackupStorage();
    const path = join(tmp, "b.sql.gz");
    writeFileSync(path, "dump-bytes");
    const stream = await storage.getStream(path);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("dump-bytes");
  });

  it("list returns only .sql.gz basenames and [] for a missing directory", async () => {
    const storage = createLocalBackupStorage();
    writeFileSync(join(tmp, "keep.sql.gz"), "x");
    writeFileSync(join(tmp, "skip.txt"), "x");
    const files = await storage.list(tmp);
    expect(files).toContain("keep.sql.gz");
    expect(files).not.toContain("skip.txt");

    expect(await storage.list(join(tmp, "does-not-exist"))).toEqual([]);
  });

  it("remove deletes the artifact and tolerates already-gone", async () => {
    const storage = createLocalBackupStorage();
    const path = join(tmp, "c.sql.gz");
    writeFileSync(path, "x");
    await storage.remove(path);
    expect(existsSync(path)).toBe(false);
    // Second remove: already gone — resolves, no throw.
    await storage.remove(path);
  });

  it("abortStaleUploads is a no-op — the filesystem has no multipart concept (#4727)", async () => {
    const storage = createLocalBackupStorage();
    expect(await storage.abortStaleUploads(tmp, 7 * 24 * 60 * 60 * 1000)).toBe(0);
  });
});

// ── S3 driver (injected fake client) ───────────────────────────────

type FakeObject = { chunks: Uint8Array[]; finalized: boolean };

function createFakeS3() {
  const objects = new Map<string, FakeObject>();
  const deleted: string[] = [];
  let failWriteAt: number | null = null;

  const client = {
    file(key: string) {
      return {
        writer() {
          const obj: FakeObject = { chunks: [], finalized: false };
          let writes = 0;
          return {
            write(chunk: Uint8Array) {
              writes++;
              if (failWriteAt !== null && writes >= failWriteAt) {
                throw new Error("simulated part-upload failure");
              }
              obj.chunks.push(chunk);
              return chunk.byteLength;
            },
            flush() {
              return 0;
            },
            end() {
              obj.finalized = true;
              objects.set(key, obj);
              return 0;
            },
          };
        },
        stream() {
          const stored = objects.get(key);
          if (!stored) throw new Error(`NoSuchKey: ${key}`);
          return (async function* () {
            for (const chunk of stored.chunks) yield chunk;
          })();
        },
        async delete() {
          // S3 semantics: deleting a missing key succeeds.
          objects.delete(key);
          deleted.push(key);
        },
      };
    },
    async list({ prefix }: { prefix: string; maxKeys?: number; startAfter?: string }) {      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).toSorted();
      return { contents: keys.map((key) => ({ key })), isTruncated: false };
    },
  };

  return {
    client,
    objects,
    deleted,
    setFailWriteAt(n: number | null) {
      failWriteAt = n;
    },
  };
}

describe("s3 backup storage", () => {
  it("put streams chunks through the multipart writer, normalizing the ./ key prefix", async () => {
    const fake = createFakeS3();
    const storage = createS3BackupStorage({ bucket: "b" }, () => fake.client);

    const { sizeBytes } = await storage.put(
      "./backups/a.sql.gz",
      Readable.from([Buffer.from("part1-"), Buffer.from("part2")]),
    );
    expect(sizeBytes).toBe(11);
    const stored = fake.objects.get("backups/a.sql.gz");
    expect(stored).toBeDefined();
    expect(stored!.finalized).toBe(true);
    expect(Buffer.concat(stored!.chunks.map((c) => Buffer.from(c))).toString()).toBe("part1-part2");
  });

  it("put rejects (artifact not finalized) when a part upload fails", async () => {
    const fake = createFakeS3();
    fake.setFailWriteAt(1);
    const storage = createS3BackupStorage({ bucket: "b" }, () => fake.client);

    await expect(
      storage.put("./backups/fail.sql.gz", Readable.from([Buffer.from("x")])),
    ).rejects.toThrow("simulated part-upload failure");
    expect(fake.objects.has("backups/fail.sql.gz")).toBe(false);
  });

  it("getStream reads back what put wrote", async () => {
    const fake = createFakeS3();
    const storage = createS3BackupStorage({ bucket: "b" }, () => fake.client);
    await storage.put("./backups/rt.sql.gz", Readable.from([Buffer.from("round-trip")]));

    const stream = await storage.getStream("./backups/rt.sql.gz");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe("round-trip");
  });

  it("list returns .sql.gz basenames under the prefix", async () => {
    const fake = createFakeS3();
    const storage = createS3BackupStorage({ bucket: "b" }, () => fake.client);
    await storage.put("./backups/one.sql.gz", Readable.from([Buffer.from("1")]));
    await storage.put("./backups/two.sql.gz", Readable.from([Buffer.from("2")]));

    const files = await storage.list("./backups");
    expect(files.toSorted()).toEqual(["one.sql.gz", "two.sql.gz"]);
  });

  it("list pages through truncated results and terminates on the final page", async () => {
    const pages = [
      { contents: [{ key: "backups/a.sql.gz" }, { key: "backups/b.sql.gz" }], isTruncated: true },
      { contents: [{ key: "backups/c.sql.gz" }, { key: "backups/skip.txt" }], isTruncated: false },
    ];
    const listCalls: { prefix: string; startAfter?: string }[] = [];
    let page = 0;
    const pagingClient: S3ClientLike = {
      file: () => {
        throw new Error("not used in this test");
      },
      list: async (options) => {
        listCalls.push({ prefix: options.prefix, startAfter: options.startAfter });
        return pages[Math.min(page++, pages.length - 1)];
      },
    };
    const storage = createS3BackupStorage({ bucket: "b" }, () => pagingClient);

    const files = await storage.list("./backups");
    expect(files).toEqual(["a.sql.gz", "b.sql.gz", "c.sql.gz"]);
    expect(listCalls).toHaveLength(2);
    // The second page continues after the first page's last key.
    expect(listCalls[1].startAfter).toBe("backups/b.sql.gz");
  });

  it("remove deletes and tolerates a missing key (S3 delete semantics)", async () => {
    const fake = createFakeS3();
    const storage = createS3BackupStorage({ bucket: "b" }, () => fake.client);
    await storage.put("./backups/gone.sql.gz", Readable.from([Buffer.from("x")]));

    await storage.remove("./backups/gone.sql.gz");
    expect(fake.objects.has("backups/gone.sql.gz")).toBe(false);
    // Missing key — still resolves.
    await storage.remove("./backups/gone.sql.gz");
    expect(fake.deleted.filter((k) => k === "backups/gone.sql.gz")).toHaveLength(2);
  });
});

// ── Stale incomplete multipart uploads (#4727) ─────────────────────

describe("s3 backup storage — abortStaleUploads", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const WEEK = 7 * DAY;

  function createFakeMultipart(
    uploads: InProgressUpload[],
    abortImpl?: (key: string) => void,
    truncated = false,
  ) {
    const listedPrefixes: string[] = [];
    const aborted: { key: string; uploadId: string }[] = [];
    const ops: S3MultipartOps = {
      async listInProgress(prefix) {
        listedPrefixes.push(prefix);
        return { uploads, truncated };
      },
      async abort(key, uploadId) {
        abortImpl?.(key);
        aborted.push({ key, uploadId });
      },
    };
    return { ops, listedPrefixes, aborted };
  }

  it("aborts only uploads older than the threshold, under the normalized key prefix", async () => {
    const now = Date.now();
    const fake = createFakeMultipart([
      { key: "backups/stale.sql.gz", uploadId: "u-old", initiatedAt: now - 8 * DAY },
      { key: "backups/fresh.sql.gz", uploadId: "u-new", initiatedAt: now - 1 * DAY },
    ]);
    const storage = createS3BackupStorage({ bucket: "b" }, undefined, () => fake.ops);

    expect(await storage.abortStaleUploads("./backups", WEEK)).toBe(1);
    // Leading `./` stripped and a trailing `/` appended, exactly as `list` does.
    expect(fake.listedPrefixes).toEqual(["backups/"]);
    expect(fake.aborted).toEqual([{ key: "backups/stale.sql.gz", uploadId: "u-old" }]);
  });

  it("no-ops when the endpoint does not support ListMultipartUploads", async () => {
    const storage = createS3BackupStorage({ bucket: "b" }, undefined, () => ({
      listInProgress: () => Promise.reject(new S3MultipartUnsupportedError("nope", 501)),
      abort: () => Promise.reject(new Error("should not be reached")),
    }));

    expect(await storage.abortStaleUploads("./backups", WEEK)).toBe(0);
  });

  it("no-ops when no static credentials are available to sign the request", async () => {
    const storage = createS3BackupStorage({ bucket: "b" }, undefined, () => null);
    expect(await storage.abortStaleUploads("./backups", WEEK)).toBe(0);
  });

  it("propagates a genuine listing failure so the caller can log it", async () => {
    const storage = createS3BackupStorage({ bucket: "b" }, undefined, () => ({
      listInProgress: () => Promise.reject(new Error("connection reset")),
      abort: () => Promise.resolve(),
    }));

    await expect(storage.abortStaleUploads("./backups", WEEK)).rejects.toThrow("connection reset");
  });

  it("one un-abortable upload does not strand the rest", async () => {
    const now = Date.now();
    const fake = createFakeMultipart(
      [
        { key: "backups/a.sql.gz", uploadId: "u-a", initiatedAt: now - 8 * DAY },
        { key: "backups/b.sql.gz", uploadId: "u-b", initiatedAt: now - 9 * DAY },
      ],
      (key) => {
        if (key === "backups/a.sql.gz") throw new Error("AccessDenied");
      },
    );
    const storage = createS3BackupStorage({ bucket: "b" }, undefined, () => fake.ops);

    expect(await storage.abortStaleUploads("./backups", WEEK)).toBe(1);
    expect(fake.aborted).toEqual([{ key: "backups/b.sql.gz", uploadId: "u-b" }]);
  });

  it("still sweeps the batch it got when the listing was page-capped", async () => {
    const now = Date.now();
    const fake = createFakeMultipart(
      [{ key: "backups/a.sql.gz", uploadId: "u-a", initiatedAt: now - 8 * DAY }],
      undefined,
      /* truncated */ true,
    );
    const storage = createS3BackupStorage({ bucket: "b" }, undefined, () => fake.ops);

    // Partial progress, not a refusal — successive cycles converge.
    expect(await storage.abortStaleUploads("./backups", WEEK)).toBe(1);
  });

  it("resolves the multipart factory once and caches a null result", async () => {
    let calls = 0;
    const storage = createS3BackupStorage({ bucket: "b" }, undefined, () => {
      calls++;
      return null;
    });

    await storage.abortStaleUploads("./backups", WEEK);
    await storage.abortStaleUploads("./backups", WEEK);
    expect(calls).toBe(1);
  });
});

// ── Env-driven selection ───────────────────────────────────────────

describe("getBackupStorage selection", () => {
  const priorBucket = process.env.ATLAS_BACKUP_S3_BUCKET;

  beforeEach(() => {
    _resetBackupStorage();
    delete process.env.ATLAS_BACKUP_S3_BUCKET;
  });

  afterAll(() => {
    _resetBackupStorage();
    if (priorBucket === undefined) delete process.env.ATLAS_BACKUP_S3_BUCKET;
    else process.env.ATLAS_BACKUP_S3_BUCKET = priorBucket;
  });

  it("defaults to the local driver when no bucket is configured", () => {
    expect(isS3BackupStorageConfigured()).toBe(false);
    expect(getBackupStorage().kind).toBe("local");
  });

  it("selects the s3 driver when ATLAS_BACKUP_S3_BUCKET is set (client built lazily)", () => {
    process.env.ATLAS_BACKUP_S3_BUCKET = "atlas-backups-test";
    expect(isS3BackupStorageConfigured()).toBe(true);
    // Driver construction must not touch the network / Bun client — the
    // client is built lazily on first operation.
    expect(getBackupStorage().kind).toBe("s3");
  });

  it("caches the selection until reset", () => {
    const first = getBackupStorage();
    expect(getBackupStorage()).toBe(first);
    _resetBackupStorage();
    expect(getBackupStorage()).not.toBe(first);
  });
});
