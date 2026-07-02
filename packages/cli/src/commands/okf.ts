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
 *   an `atlas:` frontmatter extension that makes re-import lossless.
 *
 * Named `okf` (subcommand group) because bare `import` already means
 * "sync on-disk semantic YAML -> internal DB" (import.ts) and `migrate-import`
 * means "import an Atlas export bundle" — see the #4140 triage note.
 *
 * Pure file <-> file: no REST, no DB, so it lives in the published `atlas`
 * binary (per ADR-0025/0026 only direct-DB tenant tooling is operator-only).
 * The mapping engine is `@atlas/api/lib/semantic/okf`; this file only walks
 * and writes directories. Findings: docs/research/okf-interop-spike.md.
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

function writeFiles(outDir: string, files: InteropFile[]): void {
  for (const file of files) {
    const target = path.join(outDir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
  }
}

function printReport(io: OkfIO, report: MappingReport): void {
  if (report.lossy.length > 0) {
    io.out("");
    io.out(`Lossy mappings (${report.lossy.length}):`);
    for (const l of report.lossy) io.out(`  ! ${l}`);
  }
  if (report.unmapped.length > 0) {
    io.out("");
    io.out(`Unmapped (${report.unmapped.length}):`);
    for (const u of report.unmapped) io.out(`  x ${u}`);
  }
  if (report.notes.length > 0) {
    io.out("");
    io.out(`Notes (${report.notes.length}):`);
    for (const n of report.notes) io.out(`  - ${n}`);
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
    const collisions = files.filter((f) =>
      fs.existsSync(path.join(outDir, ...f.path.split("/"))),
    );
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

/** Testable core — dispatches subcommands, returns the exit code. */
export function runOkf(args: string[], io: OkfIO = defaultIO): number {
  // args[0] is the command name ("okf"); the subcommand follows.
  const sub = args[1];
  if (sub === "import") return runImport(args, io);
  if (sub === "export") return runExport(args, io);
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
