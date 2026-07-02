/**
 * `atlas okf import|export` — OKF (Open Knowledge Format) interop spike (#4140).
 *
 * OKF v0.1 (GoogleCloudPlatform/knowledge-catalog) is a vendor-neutral bundle
 * of markdown files with YAML frontmatter. This command group is the
 * file-to-file prototype of both mapping directions:
 *
 * - `okf import`  — OKF bundle directory -> first-draft semantic layer
 *   (entities/glossary/metrics YAML); the scan -> enrich -> edit flow takes
 *   over from there. One-shot draft generator, NOT a maintained sync.
 * - `okf export`  — semantic layer directory -> conformant OKF bundle, with
 *   an `atlas:` frontmatter extension that makes re-import lossless for
 *   entity/glossary objects and metric fields (metric SQL is re-stamped
 *   unverified on import — authority never travels through a bundle).
 *
 * Named `okf` (subcommand group) because bare `import` already means
 * "sync on-disk semantic YAML -> internal DB" (import.ts) and `migrate-import`
 * means "import an Atlas export bundle" — see the #4140 triage note.
 *
 * Pure file <-> file: no REST, no DB, so it lives in the published `atlas`
 * binary (per ADR-0025 §Sequencing / #4045, only tenant-destructive
 * direct-DB tooling is operator-only). The mapping engine is
 * `@atlas/api/lib/semantic/okf`; this file only walks and writes
 * directories. Findings: docs/research/okf-interop-spike.md.
 */

import * as fs from "fs";
import * as path from "path";
import {
  exportToOkf,
  importOkfBundle,
  type InteropFile,
  type MappingReport,
} from "@atlas/api/lib/semantic/okf";
import { getFlag } from "../../lib/cli-utils";

const USAGE = `OKF (Open Knowledge Format) interop - import a bundle as a draft semantic layer, or export the semantic layer as an OKF bundle.

Usage: atlas okf <command> [options]

Commands:
  import              OKF bundle directory -> first-draft semantic layer YAML
  export              Semantic layer directory -> OKF v0.1 bundle

Options (import):
  --bundle <dir>      OKF bundle to read (required)
  --out <dir>         Semantic layer output directory (default: ./semantic)
  --name <name>       Catalog name for the draft (default: bundle directory name)
  --force             Overwrite existing files in --out

Options (export):
  --semantic <dir>    Semantic layer to read (default: ./semantic)
  --out <dir>         Bundle output directory (required)
  --force             Write into a non-empty --out directory

Examples:
  atlas okf import --bundle ./ga4-bundle --out ./semantic
  atlas okf export --semantic ./semantic --out ./okf-bundle

Import produces DRAFTS: imported metric SQL is unverified prose until a human
reviews it, and entity type/grain/measures are left for enrich/edit. Export
notes what OKF cannot express (whitelist enforcement, pinned-metric authority,
glossary ambiguity gating) - the data survives under the \`atlas:\` frontmatter
extension, the runtime semantics do not.`;

/** stdout/stderr sink — injected so tests can capture output. */
export interface OkfIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIO: OkfIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Recursively collect files under `root` (relative POSIX paths) with an extension filter. */
function collectFiles(root: string, extensions: RegExp): InteropFile[] {
  const files: InteropFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip dotfiles/dirs (.git, .orgs mirrors) — never part of a bundle or layer.
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      // Symlinks fail both isDirectory() and isFile() and are intentionally
      // excluded: a bundle should be self-contained, and following links
      // would let it read outside its own tree.
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && extensions.test(entry.name)) {
        files.push({
          path: path.relative(root, full).split(path.sep).join("/"),
          content: fs.readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Resolve a bundle-relative POSIX path under `outDir`, refusing anything
 * that escapes it. The mapping engine validates names on its side; this is
 * the defense-in-depth sink guard (CLAUDE.md path-traversal rule) so no
 * future engine bug can turn an import into an arbitrary file write.
 * Exported for direct tests — this layer only matters when the engine gate
 * has regressed, a scenario end-to-end tests can't reach.
 */
export function resolveInside(outDir: string, relPath: string): string {
  const root = path.resolve(outDir);
  const target = path.resolve(root, ...relPath.split("/"));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`refusing to write outside ${outDir}: ${relPath}`);
  }
  return target;
}

function writeFiles(outDir: string, files: InteropFile[]): void {
  for (const file of files) {
    const target = resolveInside(outDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
  }
}

/** Warnings go to stderr so stdout stays pipeable. */
function printReport(io: OkfIO, report: MappingReport): void {
  if (report.lossy.length > 0) {
    io.err("");
    io.err(`Lossy mappings (${report.lossy.length}):`);
    for (const l of report.lossy) io.err(`  ! ${l}`);
  }
  if (report.unmapped.length > 0) {
    io.err("");
    io.err(`Unmapped (${report.unmapped.length}):`);
    for (const u of report.unmapped) io.err(`  x ${u}`);
  }
  if (report.notes.length > 0) {
    io.err("");
    io.err(`Notes (${report.notes.length}):`);
    for (const n of report.notes) io.err(`  - ${n}`);
  }
}

function runImport(args: string[], io: OkfIO): number {
  const bundleDir = getFlag(args, "--bundle");
  if (!bundleDir) {
    io.err("Missing required --bundle <dir> (the OKF bundle to import).");
    return 1;
  }
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    io.err(`Bundle directory not found: ${bundleDir}`);
    return 1;
  }
  const outDir = getFlag(args, "--out") ?? "./semantic";
  const force = args.includes("--force");
  const bundleName = getFlag(args, "--name") ?? path.basename(path.resolve(bundleDir));

  const bundleFiles = collectFiles(bundleDir, /\.md$/);
  if (bundleFiles.length === 0) {
    io.err(`No markdown files found in ${bundleDir} - not an OKF bundle.`);
    return 1;
  }

  const { files, report } = importOkfBundle(bundleFiles, { bundleName });

  if (!force) {
    const collisions = files.filter((f) => fs.existsSync(resolveInside(outDir, f.path)));
    if (collisions.length > 0) {
      io.err(
        `Refusing to overwrite ${collisions.length} existing file(s) in ${outDir} ` +
          `(first: ${collisions[0].path}). Re-run with --force to overwrite.`,
      );
      return 1;
    }
  }

  writeFiles(outDir, files);
  const entityCount = files.filter((f) => f.path.startsWith("entities/")).length;
  io.out(`Imported OKF bundle ${bundleDir} -> ${outDir}`);
  io.out(
    `  ${entityCount} entities, ${files.length} files total. ` +
      "Drafts only - review via scan -> enrich -> edit before publishing.",
  );
  if (entityCount === 0) {
    io.err(
      "Warning: no entities were imported - every table concept was unmapped or the bundle has none. See the report below.",
    );
  }
  printReport(io, report);
  return 0;
}

function runExport(args: string[], io: OkfIO): number {
  const outDir = getFlag(args, "--out");
  if (!outDir) {
    io.err("Missing required --out <dir> (where to write the OKF bundle).");
    return 1;
  }
  const semanticDir = getFlag(args, "--semantic") ?? "./semantic";
  if (!fs.existsSync(semanticDir) || !fs.statSync(semanticDir).isDirectory()) {
    io.err(`Semantic layer directory not found: ${semanticDir}`);
    return 1;
  }
  const force = args.includes("--force");
  if (!force && fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    io.err(`Output directory ${outDir} is not empty. Re-run with --force to write anyway.`);
    return 1;
  }

  const layerFiles = collectFiles(semanticDir, /\.ya?ml$/);
  if (layerFiles.length === 0) {
    io.err(`No YAML files found in ${semanticDir} - nothing to export.`);
    return 1;
  }

  const { files, report } = exportToOkf(layerFiles, {
    timestamp: new Date().toISOString(),
  });
  writeFiles(outDir, files);
  const conceptCount = files.filter((f) => !f.path.endsWith("index.md")).length;
  io.out(`Exported ${semanticDir} -> OKF bundle at ${outDir}`);
  io.out(`  ${conceptCount} concept docs, ${files.length} files total.`);
  printReport(io, report);
  return 0;
}

/** Run a subcommand with foreseeable fs failures turned into actionable messages. */
function guarded(label: string, io: OkfIO, fn: () => number): number {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(
      `okf ${label} failed: ${msg}. Check that the input path is a readable directory and the output path is writable, then re-run.`,
    );
    return 1;
  }
}

/** Testable core — dispatches subcommands, returns the exit code. */
export function runOkf(args: string[], io: OkfIO = defaultIO): number {
  // args[0] is the command name ("okf"); the subcommand follows.
  const sub = args[1];
  if (sub === "import") return guarded("import", io, () => runImport(args, io));
  if (sub === "export") return guarded("export", io, () => runExport(args, io));
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.out(USAGE);
    return sub === undefined ? 1 : 0;
  }
  io.err(`Unknown okf subcommand: ${sub}\n`);
  io.err(USAGE);
  return 1;
}

/** Thin shell for bin/atlas.ts. */
export async function handleOkf(args: string[]): Promise<void> {
  const code = runOkf(args);
  if (code !== 0) process.exit(code);
}
