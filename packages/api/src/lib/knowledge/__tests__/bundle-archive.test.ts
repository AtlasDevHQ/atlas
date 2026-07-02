/**
 * Unit tests for the OKF bundle archive extractor (#4207).
 *
 * Covers the three container formats (tar / tar.gz / zip), magic-byte detection,
 * and the untrusted-input hazards the module defends: path traversal, oversized
 * documents, decompression bombs, and unrecognized formats.
 */

import { describe, expect, it } from "bun:test";
import { gzipSync, zipSync, strToU8 } from "fflate";
import {
  extractBundle,
  normalizeBundlePath,
  BundleFormatError,
} from "@atlas/api/lib/knowledge/bundle-archive";

const LIMITS = { maxDocBytes: 1_000_000, maxTotalBytes: 25_000_000 };

// ── Minimal USTAR tar builder (test-only) ────────────────────────────────────

interface TarEntry {
  path: string;
  content: string;
  /** typeflag override — '0' regular (default), '2' symlink, '5' dir, 'L' GNU longname. */
  typeflag?: string;
  /** USTAR magic override — "ustar\0" (POSIX, default) or "ustar  " (GNU). */
  magic?: string;
}

function makeTarHeader(name: string, size: number, typeflag = "0", magic = "ustar\0"): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (str: string, off: number) => h.set(enc.encode(str), off);
  put(name, 0);
  put("0000644\0", 100); // mode
  put("0000000\0", 108); // uid
  put("0000000\0", 116); // gid
  put(size.toString(8).padStart(11, "0") + "\0", 124); // size (octal)
  put("00000000000\0", 136); // mtime
  for (let i = 148; i < 156; i++) h[i] = 0x20; // checksum placeholder = spaces
  h[156] = typeflag.charCodeAt(0);
  put(magic, 257);
  put("00", 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function makeTar(files: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const f of files) {
    const data = enc.encode(f.content);
    blocks.push(makeTarHeader(f.path, data.length, f.typeflag ?? "0", f.magic ?? "ustar\0"));
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512 || 512);
    padded.set(data);
    if (data.length > 0) blocks.push(padded);
  }
  blocks.push(new Uint8Array(512), new Uint8Array(512)); // two zero end-blocks
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

const SAMPLE = [
  { path: "index.md", content: "# Root\n" },
  { path: "runbooks/eu-replica.md", content: "---\ntype: Runbook\n---\n# EU\n" },
];

function fileMap(files: readonly { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("extractBundle — formats", () => {
  it("extracts an uncompressed tar", () => {
    const out = extractBundle(makeTar(SAMPLE), LIMITS);
    expect(out.format).toBe("tar");
    const m = fileMap(out.files);
    expect(m.get("runbooks/eu-replica.md")).toContain("type: Runbook");
    expect(m.size).toBe(2);
  });

  it("extracts a gzipped tar (.tar.gz)", () => {
    const out = extractBundle(gzipSync(makeTar(SAMPLE)), LIMITS);
    expect(out.format).toBe("tar.gz");
    expect(fileMap(out.files).get("index.md")).toBe("# Root\n");
  });

  it("extracts a zip", () => {
    const zip = zipSync({
      "index.md": strToU8("# Root\n"),
      "runbooks/eu-replica.md": strToU8("body"),
    });
    const out = extractBundle(zip, LIMITS);
    expect(out.format).toBe("zip");
    expect(fileMap(out.files).get("runbooks/eu-replica.md")).toBe("body");
  });

  it("skips zip directory entries", () => {
    const zip = zipSync({ "dir/": strToU8(""), "dir/a.md": strToU8("x") });
    const out = extractBundle(zip, LIMITS);
    expect(out.files.map((f) => f.path)).toEqual(["dir/a.md"]);
  });

  it("rejects an empty buffer", () => {
    expect(() => extractBundle(new Uint8Array(0), LIMITS)).toThrow(BundleFormatError);
  });

  it("rejects an unrecognized format", () => {
    expect(() => extractBundle(strToU8("not an archive at all"), LIMITS)).toThrow(
      BundleFormatError,
    );
  });
});

describe("extractBundle — hazards", () => {
  it("rejects path traversal per-entry (zip)", () => {
    const zip = zipSync({ "../escape.md": strToU8("x"), "ok.md": strToU8("y") });
    const out = extractBundle(zip, LIMITS);
    expect(out.files.map((f) => f.path)).toEqual(["ok.md"]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].reason).toContain("unsafe path");
  });

  it("rejects an oversized document per-entry, keeping the rest", () => {
    const zip = zipSync({ "big.md": strToU8("x".repeat(50)), "small.md": strToU8("y") });
    const out = extractBundle(zip, { maxDocBytes: 10, maxTotalBytes: 1000 });
    expect(out.files.map((f) => f.path)).toEqual(["small.md"]);
    expect(out.errors[0].reason).toContain("per-document limit");
  });

  it("aborts the whole bundle when the uncompressed total exceeds the cap (bomb guard)", () => {
    const tar = makeTar([
      { path: "a.md", content: "x".repeat(600) },
      { path: "b.md", content: "y".repeat(600) },
    ]);
    expect(() => extractBundle(tar, { maxDocBytes: 1000, maxTotalBytes: 800 })).toThrow(
      BundleFormatError,
    );
  });

  it("aborts a gzip that expands past the total cap", () => {
    const gz = gzipSync(makeTar([{ path: "a.md", content: "x".repeat(2000) }]));
    expect(() => extractBundle(gz, { maxDocBytes: 5000, maxTotalBytes: 500 })).toThrow(
      BundleFormatError,
    );
  });

  it("aborts a zip that expands past the total cap (streaming bomb guard)", () => {
    // Each entry is within maxDocBytes, but their decoded sum exceeds maxTotalBytes.
    const zip = zipSync({ "a.md": strToU8("x".repeat(400)), "b.md": strToU8("y".repeat(400)) });
    expect(() => extractBundle(zip, { maxDocBytes: 1000, maxTotalBytes: 500 })).toThrow(
      BundleFormatError,
    );
  });

  it("rejects path traversal per-entry (tar path has its own guard)", () => {
    const tar = makeTar([
      { path: "../escape.md", content: "x" },
      { path: "ok.md", content: "y" },
    ]);
    const out = extractBundle(tar, LIMITS);
    expect(out.files.map((f) => f.path)).toEqual(["ok.md"]);
    expect(out.errors[0].reason).toContain("unsafe path");
  });

  it("rejects an oversized document per-entry (tar path), keeping the rest", () => {
    const tar = makeTar([
      { path: "big.md", content: "x".repeat(50) },
      { path: "small.md", content: "y" },
    ]);
    const out = extractBundle(tar, { maxDocBytes: 10, maxTotalBytes: 10_000 });
    expect(out.files.map((f) => f.path)).toEqual(["small.md"]);
    expect(out.errors[0].reason).toContain("per-document limit");
  });

  it("skips tar symlink / directory entries, keeping regular files", () => {
    const tar = makeTar([
      { path: "link.md", content: "target", typeflag: "2" }, // symlink
      { path: "adir", content: "", typeflag: "5" }, // directory
      { path: "real.md", content: "# real" },
    ]);
    const out = extractBundle(tar, LIMITS);
    expect(out.files.map((f) => f.path)).toEqual(["real.md"]);
  });
});

describe("extractBundle — GNU tar magic", () => {
  it("accepts a GNU-format tar (magic 'ustar  ', not POSIX 'ustar\\0')", () => {
    const tar = makeTar([{ path: "a.md", content: "# A", magic: "ustar  " }]);
    const out = extractBundle(tar, LIMITS);
    expect(out.format).toBe("tar");
    expect(fileMap(out.files).get("a.md")).toBe("# A");
  });
});

describe("normalizeBundlePath", () => {
  it("keeps a clean relative path", () => {
    expect(normalizeBundlePath("runbooks/eu.md")).toBe("runbooks/eu.md");
  });
  it("folds backslashes and drops . segments", () => {
    expect(normalizeBundlePath("a\\b\\./c.md")).toBe("a/b/c.md");
  });
  it("rejects traversal, absolute, and drive paths", () => {
    expect(normalizeBundlePath("../x")).toBeNull();
    expect(normalizeBundlePath("a/../../x")).toBeNull();
    expect(normalizeBundlePath("/etc/passwd")).toBeNull();
    expect(normalizeBundlePath("C:/win.md")).toBeNull();
    expect(normalizeBundlePath("")).toBeNull();
  });
});
