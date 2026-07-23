/**
 * BackupStorage — the storage seam behind every backup artifact operation
 * (#4457, option ii of the maintainer decision).
 *
 * Before this module the engine/verify/restore/purge paths hit the local
 * filesystem directly (`createWriteStream`, `createReadStream`, `unlink`,
 * `readdir`), so backups died with the host: SaaS API containers have no
 * volume behind `./backups`, and a redeploy discarded every artifact. The
 * driver interface moves those call sites behind one seam with two
 * implementations:
 *
 *  - **local** (default): the pre-#4457 behaviour — artifacts under the
 *    configured `storage_path` directory. Self-hosted deployments keep
 *    exactly what they had.
 *  - **s3**: any S3-compatible object store (Railway buckets in prod),
 *    selected by setting `ATLAS_BACKUP_S3_BUCKET`. Uses Bun's native
 *    `Bun.S3Client` (the API runs on Bun everywhere — no new dependency).
 *    Artifacts survive redeploys and host loss, which is the state the
 *    pricing/DPA backup promises actually require.
 *
 * The `storage_path` recorded on each `backups` row is driver-agnostic: a
 * filesystem path for the local driver, an object key for S3 (the driver
 * normalizes a leading `./` off keys). Switching drivers does not migrate
 * previously written artifacts — rows created under the old driver will
 * fail verification/restore until re-created, and purge removes their DB
 * rows without touching the stranded files (S3 deletes of missing keys
 * succeed by protocol; local deletes tolerate ENOENT). Documented in
 * `apps/docs/content/docs/platform-ops/backups.mdx`.
 *
 * Selection is env-driven, read once on first use, and cached for the
 * process lifetime (restart to change drivers):
 *   ATLAS_BACKUP_S3_BUCKET             — selects the s3 driver when set
 *   ATLAS_BACKUP_S3_ENDPOINT           — S3-compatible endpoint URL
 *   ATLAS_BACKUP_S3_REGION             — optional region
 *   ATLAS_BACKUP_S3_ACCESS_KEY_ID      — credential (env secret)
 *   ATLAS_BACKUP_S3_SECRET_ACCESS_KEY  — credential (env secret)
 */

import { createReadStream, createWriteStream } from "fs";
import { mkdir, readdir, stat, unlink } from "fs/promises";
import { basename, dirname } from "path";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import { createLogger } from "@atlas/api/lib/logger";
import { createS3MultipartOps, S3MultipartUnsupportedError, type S3MultipartOps } from "./s3-multipart";

const log = createLogger("ee:backups-storage");

/** Driver-agnostic artifact operations. Paths are fs paths (local) or object keys (s3). */
export interface BackupStorage {
  readonly kind: "local" | "s3";
  /** Stream `source` to `path`, replacing any existing artifact. Resolves with bytes written. */
  put(path: string, source: Readable): Promise<{ sizeBytes: number }>;
  /**
   * Node Readable over the stored artifact. A missing artifact surfaces as
   * an `'error'` event on the returned stream (both drivers open lazily) —
   * always consume via `pipeline` or attach an error handler immediately.
   */
  getStream(path: string): Promise<Readable>;
  /** Artifact basenames under `prefix` (a directory for local, a key prefix for s3). */
  list(prefix: string): Promise<string[]>;
  /** Delete the artifact. Resolves (does not reject) when it is already gone. */
  remove(path: string): Promise<void>;
  /**
   * Abort in-progress multipart uploads under `prefix` that were initiated
   * more than `olderThanMs` ago, returning how many were aborted (#4727).
   *
   * A failed S3 upload deliberately never finalizes, so its parts linger as
   * billable-but-invisible storage. Resolves with `0` — never rejects — when
   * the driver has no multipart concept (local), when the endpoint does not
   * implement the API, or when static credentials aren't available to sign
   * the request. Genuine failures reject so the caller can log them.
   */
  abortStaleUploads(prefix: string, olderThanMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Local filesystem driver — the pre-#4457 behaviour, verbatim.
// ---------------------------------------------------------------------------

export function createLocalBackupStorage(): BackupStorage {
  return {
    kind: "local",
    async put(path, source) {
      await mkdir(dirname(path), { recursive: true });
      await pipeline(source, createWriteStream(path));
      const fileStat = await stat(path);
      return { sizeBytes: fileStat.size };
    },
    async getStream(path) {
      return createReadStream(path);
    },
    async list(prefix) {
      try {
        return (await readdir(prefix)).filter((f) => f.endsWith(".sql.gz"));
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async remove(path) {
      try {
        await unlink(path);
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return; // already gone — the purge outcome is the same
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    async abortStaleUploads() {
      // The filesystem has no multipart concept: a failed `put` leaves a
      // partial file at a known path, which the next attempt overwrites.
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// S3-compatible driver — Bun-native client, Railway buckets in prod.
// ---------------------------------------------------------------------------

/**
 * Structural slice of `Bun.S3Client` the driver uses — kept minimal so unit
 * tests can inject a fake without network access, and so the module
 * type-checks without depending on Bun-global type availability at every
 * consumer.
 */
export interface S3ClientLike {
  file(key: string): {
    writer(options?: { retry?: number; partSize?: number; queueSize?: number }): {
      write(chunk: Uint8Array): number | Promise<number>;
      flush(): number | Promise<number>;
      end(): number | Promise<number>;
    };
    stream(): AsyncIterable<Uint8Array>;
    delete(): Promise<void>;
  };
  list(options: { prefix: string; maxKeys?: number; startAfter?: string }): Promise<{
    contents?: { key: string }[];
    isTruncated?: boolean;
  }>;
}

export interface S3BackupStorageConfig {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Object keys never carry the local-path `./` prefix the default config uses. */
function toKey(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}

export function createS3BackupStorage(
  config: S3BackupStorageConfig,
  clientFactory?: (config: S3BackupStorageConfig) => S3ClientLike,
  multipartFactory: (config: S3BackupStorageConfig) => S3MultipartOps | null = createS3MultipartOps,
): BackupStorage {
  const makeClient =
    clientFactory ??
    ((cfg: S3BackupStorageConfig): S3ClientLike => {
      // Bun-native S3 client — the API runs on Bun in every deploy target.
      // Guarded so a non-Bun embedding fails with an actionable message
      // instead of a bare ReferenceError.
      const bunGlobal = (globalThis as { Bun?: { S3Client?: new (options: S3BackupStorageConfig) => S3ClientLike } }).Bun;
      if (!bunGlobal?.S3Client) {
        throw new Error(
          "ATLAS_BACKUP_S3_BUCKET is set but Bun.S3Client is unavailable — the S3 backup driver requires the Bun runtime",
        );
      }
      return new bunGlobal.S3Client(cfg);
    });

  // Lazy so misconfiguration surfaces on first use (inside the backup
  // Effect's typed error channel), not at module import.
  let client: S3ClientLike | null = null;
  const getClient = (): S3ClientLike => {
    client ??= makeClient(config);
    return client;
  };

  // Multipart housekeeping is a separate, optional seam: `null` (no static
  // credentials) is a legitimate steady state, so the resolution is cached in
  // its own flag rather than folded into `client`.
  let multipartOps: S3MultipartOps | null = null;
  let multipartResolved = false;
  const getMultipartOps = (): S3MultipartOps | null => {
    if (!multipartResolved) {
      multipartOps = multipartFactory(config);
      multipartResolved = true;
    }
    return multipartOps;
  };

  return {
    kind: "s3",
    async put(path, source) {
      const writer = getClient()
        .file(toKey(path))
        .writer({ retry: 3, partSize: 8 * 1024 * 1024 });
      let sizeBytes = 0;
      try {
        for await (const chunk of source as AsyncIterable<Buffer | string>) {
          // Byte-stream contract: pg_dump→gzip yields Buffers (strings are
          // tolerated for tests); an object-mode stream is a caller bug and
          // must fail loud rather than corrupt the byte count.
          const bytes: Uint8Array = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
          if (!(bytes instanceof Uint8Array)) {
            throw new Error("BackupStorage.put requires a byte stream (Buffer/Uint8Array chunks)");
          }
          sizeBytes += bytes.byteLength;
          // Await both (write may return a promise): a stray rejected write
          // promise would otherwise surface as a context-free
          // unhandledRejection instead of failing the put.
          await writer.write(bytes);
          // Flush per chunk: bounds process memory to the writer's part
          // buffer regardless of how far pg_dump outpaces the upload.
          await writer.flush();
        }
        await writer.end();
      } catch (err) {
        // Deliberately do NOT end() after a failed part: finalizing would
        // produce a truncated object that could pass a header-only verify.
        // The multipart upload is left unfinalized (Bun's writer has no abort
        // API today) — the retention purge's `abortStaleUploads` sweeps those
        // parts a week later, so they can't accrue invisible storage even on
        // buckets with no lifecycle-rule support (#4727). Log + rethrow so
        // the backup row is stamped failed.
        log.error(
          { err: err instanceof Error ? err.message : String(err), key: toKey(path) },
          "S3 backup upload failed — artifact not finalized",
        );
        throw err instanceof Error ? err : new Error(String(err));
      }
      return { sizeBytes };
    },
    async getStream(path) {
      const { Readable } = await import("stream");
      return Readable.from(getClient().file(toKey(path)).stream());
    },
    async list(prefix) {
      const keyPrefix = toKey(prefix.endsWith("/") ? prefix : `${prefix}/`);
      const names: string[] = [];
      let startAfter: string | undefined;
      // Page through — retention windows can exceed one 1000-key page.
      for (;;) {
        const page = await getClient().list({ prefix: keyPrefix, maxKeys: 1000, startAfter });
        const contents = page.contents ?? [];
        for (const obj of contents) {
          if (obj.key.endsWith(".sql.gz")) names.push(basename(obj.key));
        }
        if (!page.isTruncated || contents.length === 0) break;
        startAfter = contents[contents.length - 1].key;
      }
      return names;
    },
    async remove(path) {
      // S3 DeleteObject succeeds for missing keys by protocol — the
      // ENOENT-tolerant contract holds without a special case.
      await getClient().file(toKey(path)).delete();
    },
    async abortStaleUploads(prefix, olderThanMs) {
      const ops = getMultipartOps();
      if (!ops) {
        log.debug(
          { bucket: config.bucket },
          "Skipping stale multipart-upload cleanup — no static S3 credentials to sign the request",
        );
        return 0;
      }

      const keyPrefix = toKey(prefix.endsWith("/") ? prefix : `${prefix}/`);
      let stale: { key: string; uploadId: string }[];
      try {
        const cutoff = Date.now() - olderThanMs;
        const listing = await ops.listInProgress(keyPrefix);
        if (listing.truncated) {
          // Not fatal — aborting this batch shrinks the population so later
          // cycles converge — but a capped sweep must not read as complete.
          log.warn(
            { bucket: config.bucket, prefix: keyPrefix, listed: listing.uploads.length },
            "Multipart-upload listing hit its page cap — sweeping this batch, remainder next cycle",
          );
        }
        stale = listing.uploads.filter((u) => u.initiatedAt < cutoff);
      } catch (err) {
        if (err instanceof S3MultipartUnsupportedError) {
          // Documented degradation: some S3-compatible stores don't expose
          // bucket-level `?uploads`. A 403 is the one status here that is
          // just as likely a *fixable* permission gap (the credential lacks
          // `s3:ListBucketMultipartUploads`), so it gets an actionable warn
          // rather than a debug line nobody will ever read.
          const detail = {
            bucket: config.bucket,
            status: err.status,
            endpoint: err.endpoint,
          };
          if (err.status === 403) {
            log.warn(
              detail,
              "Skipping stale multipart-upload cleanup — the bucket credential was denied ListMultipartUploads. " +
                "Grant s3:ListBucketMultipartUploads + s3:AbortMultipartUpload, or expect abandoned upload parts to accrue.",
            );
          } else if (err.status === 400 || err.status === 404) {
            // #4751 — 400/404 are AMBIGUOUS, unlike 405/501. `s3-multipart.ts`
            // derives its own path-style URL independently of `Bun.S3Client`,
            // so a mis-derived bucket path (wrong endpoint path prefix,
            // path-style vs virtual-hosted mismatch) answers exactly like a
            // store with no multipart API — forever, while abandoned parts
            // accrue and bill. Warn with the address actually tried so an
            // operator can tell the two apart.
            log.warn(
              detail,
              "Skipping stale multipart-upload cleanup — the bucket-level ?uploads request was rejected. " +
                "Either this store has no multipart API, or the derived endpoint path is wrong (check `endpoint` above " +
                "against the bucket's real address). Abandoned upload parts will accrue until this resolves.",
            );
          } else {
            // 405 / 501 — an unambiguous "not implemented here" capability
            // signal. Nothing for an operator to act on; stays at debug.
            log.debug(
              detail,
              "Skipping stale multipart-upload cleanup — endpoint does not support ListMultipartUploads",
            );
          }
          return 0;
        }
        throw err instanceof Error ? err : new Error(String(err));
      }

      let aborted = 0;
      for (const upload of stale) {
        try {
          await ops.abort(upload.key, upload.uploadId);
          aborted++;
        } catch (err) {
          // One un-abortable upload must not strand the rest.
          log.warn(
            { err: err instanceof Error ? err.message : String(err), key: upload.key },
            "Failed to abort a stale multipart upload — will retry next cycle",
          );
        }
      }
      if (aborted > 0) {
        log.info({ bucket: config.bucket, prefix: keyPrefix, aborted }, "Aborted stale incomplete multipart uploads");
      }
      return aborted;
    },
  };
}

// ---------------------------------------------------------------------------
// Env-driven selection — one driver per process.
// ---------------------------------------------------------------------------

let _storage: BackupStorage | null = null;

/** Read the env-driven driver selection. Exported for tests (storage.test.ts + the engine test's storage mock). */
export function isS3BackupStorageConfigured(): boolean {
  return !!process.env.ATLAS_BACKUP_S3_BUCKET;
}

/**
 * The process-wide backup storage driver. S3 when `ATLAS_BACKUP_S3_BUCKET`
 * is set, local filesystem otherwise. Read once on first use and cached for
 * the process lifetime — a restart is required to change drivers.
 */
export function getBackupStorage(): BackupStorage {
  if (_storage) return _storage;
  const bucket = process.env.ATLAS_BACKUP_S3_BUCKET;
  if (bucket) {
    _storage = createS3BackupStorage({
      bucket,
      ...(process.env.ATLAS_BACKUP_S3_ENDPOINT && { endpoint: process.env.ATLAS_BACKUP_S3_ENDPOINT }),
      ...(process.env.ATLAS_BACKUP_S3_REGION && { region: process.env.ATLAS_BACKUP_S3_REGION }),
      ...(process.env.ATLAS_BACKUP_S3_ACCESS_KEY_ID && { accessKeyId: process.env.ATLAS_BACKUP_S3_ACCESS_KEY_ID }),
      ...(process.env.ATLAS_BACKUP_S3_SECRET_ACCESS_KEY && {
        secretAccessKey: process.env.ATLAS_BACKUP_S3_SECRET_ACCESS_KEY,
      }),
    });
    log.info(
      { bucket, endpoint: process.env.ATLAS_BACKUP_S3_ENDPOINT },
      "Backup storage driver: s3 (durable object storage)",
    );
  } else {
    _storage = createLocalBackupStorage();
  }
  return _storage;
}

/** @internal Reset the cached driver — for testing only. */
export function _resetBackupStorage(): void {
  _storage = null;
}
