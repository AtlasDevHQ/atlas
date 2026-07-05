/**
 * Deterministic USTAR + gzip packing.
 *
 * The KB ingest side magic-byte-detects the container and hand-parses USTAR
 * (`packages/api/src/lib/knowledge/bundle-archive.ts`), so this writer emits
 * plain POSIX ustar: regular files only, `name`(100)/`prefix`(155) split for
 * long paths, no PAX/GNU extensions.
 *
 * Determinism is a feature: entries are sorted by path, every header stamps
 * mtime 0 / uid 0 / gid 0 / mode 0644, and the gzip layer writes mtime 0 — so
 * the same content produces the same bytes on every build, and an unchanged
 * site produces an unchanged artifact (nice for content-addressed hosting and
 * honest diffs; the bundle-sync path diff itself keys on paths, not bytes).
 */

import { gzipSync } from "fflate";

import { InvalidPagePathError } from "./errors";

const BLOCK = 512;
const NAME_FIELD = 100;
const PREFIX_FIELD = 155;

const encoder = new TextEncoder();

/** Write an ASCII string into a fixed field (NUL-padded). Caller guarantees fit. */
function writeString(block: Uint8Array, offset: number, value: string): void {
  const bytes = encoder.encode(value);
  block.set(bytes, offset);
}

/** Write a tar octal numeric field: zero-padded octal + trailing NUL. */
function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const octal = value.toString(8).padStart(length - 1, "0");
  writeString(block, offset, octal); // leaves the final byte NUL
}

/**
 * Split an archive path into ustar `name`/`prefix` fields at a `/` boundary.
 * Throws when no valid split exists (a single segment over 100 bytes, or a
 * path whose prefix side exceeds 155) — loud beats a silently-truncated path
 * that would corrupt the bundle-sync diff.
 */
export function splitUstarPath(path: string): { name: string; prefix: string } {
  const bytes = encoder.encode(path);
  if (bytes.length <= NAME_FIELD) return { name: path, prefix: "" };

  // Scan left to right and take the FIRST '/' whose right side fits the
  // 100-byte name field (longest name, shortest prefix).
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (
      encoder.encode(name).length <= NAME_FIELD &&
      encoder.encode(prefix).length <= PREFIX_FIELD
    ) {
      return { name, prefix };
    }
  }
  throw new InvalidPagePathError(
    path,
    `cannot be stored in a ustar header (a segment exceeds 100 bytes ` +
      `or the path exceeds 255 bytes) — shorten the page path or prefix`,
  );
}

function headerFor(path: string, size: number): Uint8Array {
  const { name, prefix } = splitUstarPath(path);
  const header = new Uint8Array(BLOCK);

  writeString(header, 0, name);
  writeOctal(header, 100, 8, 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime — fixed for determinism
  header[156] = "0".charCodeAt(0); // typeflag: regular file
  writeString(header, 257, "ustar"); // magic (POSIX: "ustar\0", version "00")
  header[262] = 0;
  writeString(header, 263, "00");
  writeString(header, 345, prefix);

  // Checksum: computed with the checksum field itself read as spaces, then
  // stored as six octal digits + NUL + space.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, sum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

/** One file to pack. Content is UTF-8 text (OKF markdown documents). */
export interface TarEntry {
  readonly path: string;
  readonly content: string;
}

/** Build a deterministic uncompressed USTAR archive from the entries (sorted by path). */
export function createDeterministicTar(entries: readonly TarEntry[]): Uint8Array {
  const sorted = entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const parts: Uint8Array[] = [];
  let total = 0;
  for (const entry of sorted) {
    const data = encoder.encode(entry.content);
    const header = headerFor(entry.path, data.length);
    const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    padded.set(data, 0);
    parts.push(header, padded);
    total += header.length + padded.length;
  }
  // End-of-archive marker: two zero blocks.
  const terminator = new Uint8Array(BLOCK * 2);
  parts.push(terminator);
  total += terminator.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Pack entries into a deterministic `.tar.gz` (gzip mtime 0, max compression). */
export function createDeterministicTarGz(entries: readonly TarEntry[]): Uint8Array {
  return gzipSync(createDeterministicTar(entries), { level: 9, mtime: 0 });
}
