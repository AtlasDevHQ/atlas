/**
 * OKF bundle archive extraction — turn an uploaded `.tar` / `.tar.gz` / `.zip`
 * into the in-memory `{ path, content }` file list the #4140 spike parser
 * consumes (ADR-0028 §5, "the spike's fs-free parser"). No filesystem, no temp
 * files: the bytes arrive on the admin ingest request and are walked in memory.
 *
 * The bundle is UNTRUSTED third-party input (a customer's knowledge tree), so
 * every structural hazard is handled explicitly rather than trusted:
 *   - **Path traversal** — an entry whose normalized path escapes the bundle
 *     root (`..` segment, absolute path, Windows drive/UNC) is REJECTED with a
 *     per-entry error, never written under the collection's path space.
 *   - **Oversized documents** — an entry larger than `maxDocBytes` is rejected
 *     with a per-entry error, never silently truncated or skipped (AC #2).
 *   - **Decompression bombs** — decompression is STREAMED (fflate `Gunzip` /
 *     `Unzip`) and aborted the moment cumulative decoded bytes exceed
 *     `maxTotalBytes`, so a highly-compressible archive within the raw upload
 *     cap can't expand without bound in memory. The raw upload-size cap
 *     (enforced by the caller before buffering) is the first line of defense;
 *     this streaming abort is the second and bounds the actual heap use.
 *
 * Format is auto-detected by magic bytes, not the filename — the request body
 * carries no reliable name. gzip (`1f 8b`) is streamed-gunzipped then parsed as
 * tar; zip (`PK\x03\x04` / `PK\x05\x06`) is streamed-inflated; everything else
 * is attempted as an uncompressed tar (USTAR / GNU).
 */

import { Gunzip, Unzip, UnzipInflate, strFromU8 } from "fflate";
import type { KnowledgeBundleFormat } from "@useatlas/types";
import type { InteropFile } from "@atlas/api/lib/semantic/okf";

/** A per-entry extraction failure — surfaced to the admin, never swallowed. */
export interface BundleEntryError {
  readonly path: string;
  readonly reason: string;
}

export interface ExtractedBundle {
  readonly files: readonly InteropFile[];
  /** Per-entry rejections (traversal, oversize). The bundle still yields its good files. */
  readonly errors: readonly BundleEntryError[];
  /** Detected container format, for logging / audit breadcrumbs. */
  readonly format: KnowledgeBundleFormat;
}

export interface ExtractBundleOptions {
  /** Reject any single entry whose decoded content exceeds this many bytes. */
  readonly maxDocBytes: number;
  /** Abort the whole bundle once cumulative decoded bytes exceed this (bomb guard). */
  readonly maxTotalBytes: number;
}

/**
 * A malformed / unrecognized / bomb bundle — a whole-bundle failure (distinct
 * from a per-entry {@link BundleEntryError}). The route maps it to an actionable
 * 400 by `instanceof`, never a generic 500. A plain `Error` subclass (not
 * `Data.TaggedError`): it is thrown and caught across an ordinary function
 * boundary, never through Effect's typed-error channel, so it carries no `_tag`.
 */
export class BundleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleFormatError";
  }
}

/**
 * Normalize a POSIX bundle path and reject traversal / absolute / drive-qualified
 * paths. Returns the cleaned relative path, or `null` when the entry must be
 * rejected. Backslashes are folded to `/` (zip entries from Windows tools),
 * `.`/empty segments are dropped, and any `..` segment or leading `/` rejects.
 */
export function normalizeBundlePath(raw: string): string | null {
  const unified = raw.replace(/\\/g, "/").trim();
  if (unified === "") return null;
  // Absolute POSIX path or Windows drive (`C:/…`) / UNC — never allowed under a
  // collection's relative tree.
  if (unified.startsWith("/") || /^[A-Za-z]:\//.test(unified)) return null;
  const out: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    // Any parent-traversal segment escapes the root — reject the whole entry
    // rather than clamping (a clamped `../../etc/x` would land somewhere real).
    if (segment === "..") return null;
    out.push(segment);
  }
  return out.length === 0 ? null : out.join("/");
}

const GZIP_MAGIC = [0x1f, 0x8b];
const ZIP_MAGIC_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_MAGIC_EMPTY = [0x50, 0x4b, 0x05, 0x06];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Extract a bundle buffer into an in-memory file list. Regular files only;
 * directories, symlinks, and archive metadata entries are skipped. Throws
 * {@link BundleFormatError} on an unrecognized / corrupt / bomb bundle;
 * per-entry hazards accumulate in the returned `errors`.
 */
export function extractBundle(
  bytes: Uint8Array,
  options: ExtractBundleOptions,
): ExtractedBundle {
  if (bytes.length === 0) {
    throw new BundleFormatError("Bundle is empty.");
  }

  if (startsWith(bytes, ZIP_MAGIC_LOCAL) || startsWith(bytes, ZIP_MAGIC_EMPTY)) {
    return extractZip(bytes, options);
  }
  if (startsWith(bytes, GZIP_MAGIC)) {
    return { ...extractTar(boundedGunzip(bytes, options.maxTotalBytes), options), format: "tar.gz" };
  }
  // Fall through: assume an uncompressed tar. `extractTar` validates the USTAR
  // structure and throws BundleFormatError if it isn't one.
  return { ...extractTar(bytes, options), format: "tar" };
}

// ---------------------------------------------------------------------------
// Streaming decompression (fflate) — bounded so a bomb can't expand unbounded
// ---------------------------------------------------------------------------

/** Concatenate accumulated chunks into one buffer. */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Stream-gunzip with a running decoded-byte cap — aborts before a bomb fully expands. */
function boundedGunzip(bytes: Uint8Array, maxTotalBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const gunzip = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > maxTotalBytes) {
      throw new BundleFormatError(`Bundle expands past the ${maxTotalBytes}-byte limit.`);
    }
    chunks.push(chunk);
  });
  try {
    gunzip.push(bytes, true);
  } catch (err) {
    if (err instanceof BundleFormatError) throw err;
    throw new BundleFormatError(
      `Could not gunzip the bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return concat(chunks, total);
}

function extractZip(bytes: Uint8Array, options: ExtractBundleOptions): ExtractedBundle {
  const files: InteropFile[] = [];
  const errors: BundleEntryError[] = [];
  let total = 0;

  const unzip = new Unzip((file) => {
    // fflate keys directory entries with a trailing slash and empty content.
    if (file.name.endsWith("/")) {
      file.ondata = () => {};
      file.start();
      return;
    }
    const chunks: Uint8Array[] = [];
    let flen = 0;
    let oversize = false;
    file.ondata = (err, chunk, final) => {
      if (err) throw new BundleFormatError(`Could not read zip entry "${file.name}": ${err.message}`);
      total += chunk.length;
      if (total > options.maxTotalBytes) {
        throw new BundleFormatError(`Bundle expands past the ${options.maxTotalBytes}-byte limit.`);
      }
      flen += chunk.length;
      if (flen > options.maxDocBytes) {
        // Stop retaining this entry's bytes — it will be rejected — but keep
        // consuming the stream so the total (bomb) guard still counts it.
        oversize = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
      if (!final) return;
      const path = normalizeBundlePath(file.name);
      if (path === null) {
        errors.push({ path: file.name, reason: "unsafe path (traversal or absolute) — rejected" });
      } else if (oversize) {
        errors.push({
          path,
          reason: `file is ${flen} bytes, over the ${options.maxDocBytes}-byte per-document limit`,
        });
      } else {
        files.push({ path, content: strFromU8(concat(chunks, flen)) });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch (err) {
    if (err instanceof BundleFormatError) throw err;
    throw new BundleFormatError(
      `Could not read the zip bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { files, errors, format: "zip" };
}

// ---------------------------------------------------------------------------
// tar (USTAR / GNU) — hand-rolled 512-byte-block reader
// ---------------------------------------------------------------------------

const BLOCK = 512;

/** Read a NUL-terminated ASCII field from a header block. */
function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end++;
  return strFromU8(block.subarray(offset, end));
}

/** Parse a tar octal numeric field (size / mtime). Tolerates spaces + NULs. */
function readOctal(block: Uint8Array, offset: number, length: number): number {
  const raw = readString(block, offset, length).trim();
  if (raw === "") return 0;
  const parsed = Number.parseInt(raw, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function extractTar(
  bytes: Uint8Array,
  options: ExtractBundleOptions,
): { files: InteropFile[]; errors: BundleEntryError[] } {
  if (bytes.length < BLOCK || bytes.length % BLOCK !== 0) {
    throw new BundleFormatError(
      "Unrecognized bundle format — expected a .tar, .tar.gz, or .zip archive.",
    );
  }
  // The magic field at offset 257 confirms this is a tar. POSIX writes
  // "ustar\0"; GNU writes "ustar  " (trailing spaces, no NUL). Both share the
  // first five bytes "ustar" — read exactly those five so either format is
  // accepted (a bare 5-byte read side-steps the NUL-vs-space difference).
  if (readString(bytes, 257, 5) !== "ustar") {
    throw new BundleFormatError(
      "Unrecognized bundle format — expected a .tar, .tar.gz, or .zip archive.",
    );
  }

  const files: InteropFile[] = [];
  const errors: BundleEntryError[] = [];
  let total = 0;
  let offset = 0;
  // A pending GNU long name ('L' entry) overrides the next header's name field.
  let longName: string | null = null;

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break; // end-of-archive marker
    offset += BLOCK;

    const size = readOctal(header, 124, 12);
    if (Number.isNaN(size)) {
      throw new BundleFormatError("Corrupt tar bundle — unreadable entry size.");
    }
    const dataBlocks = Math.ceil(size / BLOCK);
    const dataStart = offset;
    const dataEnd = offset + size;
    if (dataEnd > bytes.length) {
      throw new BundleFormatError("Corrupt tar bundle — entry runs past end of archive.");
    }
    offset += dataBlocks * BLOCK;

    const typeflag = header[156];
    const typeChar = typeflag === 0 ? "0" : String.fromCharCode(typeflag);

    // GNU long-name extension: this entry's data IS the next entry's full name.
    if (typeChar === "L") {
      // oxlint-disable-next-line no-control-regex -- tar long-name fields are NUL-padded; matching \u0000 to strip the padding is intended.
      longName = readString(bytes, dataStart, size).replace(/\u0000+$/, "");
      continue;
    }
    // pax extended headers ('x'/'g') and directories ('5') carry no concept file.
    if (typeChar === "x" || typeChar === "g" || typeChar === "5") {
      longName = null;
      continue;
    }
    // Regular files are typeflag '0' or NUL. Anything else (symlinks '1'/'2',
    // devices, fifos) is skipped — a knowledge bundle has no use for them.
    if (typeChar !== "0") {
      longName = null;
      continue;
    }

    const prefix = readString(header, 345, 155);
    const name = longName ?? readString(header, 0, 100);
    longName = null;
    const rawPath = prefix ? `${prefix}/${name}` : name;

    const path = normalizeBundlePath(rawPath);
    if (path === null) {
      errors.push({ path: rawPath, reason: "unsafe path (traversal or absolute) — rejected" });
      continue;
    }
    if (size > options.maxDocBytes) {
      errors.push({
        path,
        reason: `file is ${size} bytes, over the ${options.maxDocBytes}-byte per-document limit`,
      });
      continue;
    }
    total += size;
    if (total > options.maxTotalBytes) {
      throw new BundleFormatError(
        `Bundle exceeds the ${options.maxTotalBytes}-byte total-size limit.`,
      );
    }
    files.push({ path, content: strFromU8(bytes.subarray(dataStart, dataEnd)) });
  }

  return { files, errors };
}
