/**
 * Build-time assertion: every bare import in the api image's shipped source
 * resolves against the image's shipped `node_modules`.
 *
 * Why this exists (#4880): the runtime stage installs a SCOPED, production-only
 * dependency closure (`--filter=@atlas/api …  --production`, see the prod-deps
 * stage in deploy/api/Dockerfile) instead of the whole monorepo. `--production`
 * drops the filtered workspace's OWN devDependencies — so any package that is
 * declared in `devDependencies` but imported from runtime source disappears
 * from the image. Three already were when this landed: `@effect/sql` and
 * `@effect/sql-pg` (imported by `lib/db/internal.ts`, the internal-DB spine)
 * and `drizzle-orm` (imported by `lib/db/schema.ts`).
 *
 * That class of breakage is invisible without this check. Bun resolves lazily,
 * so a missing package is not a boot failure — it is a module-not-found thrown
 * the first time some route or scheduler tick reaches the import, which is the
 * same failure shape the `@atlas/mcp/hosted` and plugin-sdk symlink comments in
 * the Dockerfile were written about. Fail the BUILD instead.
 *
 * Import extraction goes through `Bun.Transpiler.scanImports`, not a regex:
 * the source is full of prose like `from "sent"` inside strings and comments,
 * and a regex reports those as missing packages.
 *
 * Usage: bun deploy/api/scripts/assert-runtime-imports.ts [appRoot]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const appRoot = process.argv[2] ?? "/app";

/**
 * Source trees the image ships AND can load. Keep in lockstep with the
 * COPY lines in the runner stage and with `plugins[]` in atlas.config.ts —
 * a shipped-and-loaded workspace missing here is simply unchecked.
 */
const SHIPPED = [
  "packages/api/src",
  "packages/mcp/src",
  "packages/okf-bundle/src",
  "packages/schemas/src",
  "packages/webhook-publisher/src",
  "ee/src",
  "plugins/chat/src",
  "plugins/clickhouse/src",
  "plugins/snowflake/src",
  "plugins/bigquery/src",
  "plugins/elasticsearch/src",
  "plugins/e2b/src",
  "plugins/daytona/src",
  "plugins/twenty/src",
  "plugins/mcp/src",
];

const SKIP_PATH = /(__tests__|__mocks__|__test-utils__|\.test\.tsx?$|\.bench\.ts$)/;

/**
 * Imports that are expected NOT to resolve in the image. Every entry is a hole
 * in this assertion — keep it short, and give each one a reason.
 */
const ALLOWED_MISSING = new Map<string, string>([
  [
    "@playwright/test",
    // lib/dashboard-screenshot.ts lazy-imports it behind a try/catch that
    // degrades to `browser_unavailable`. The image has never provisioned
    // Chromium (no `playwright install`, no browser package), so the feature
    // was already non-functional here; dropping the package only moves the
    // failure from launch-time to import-time, into that same handler.
    "lazy, try/caught, degrades to browser_unavailable; image ships no Chromium",
  ],
  [
    "@google-cloud/bigquery",
    // Declared as a PEER of @useatlas/bigquery, deliberately not bundled:
    // BigQuery customers bring their own SDK. Absent before this change too.
    "unbundled peer of @useatlas/bigquery — customer-supplied, absent pre-#4880",
  ],
]);

const BUILTIN = /^(node:|bun:)/;
const NODE_CORE = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      yield* walk(p);
    } else if (/\.tsx?$/.test(p) && !SKIP_PATH.test(p)) {
      yield p;
    }
  }
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function pkgOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const tsx = new Bun.Transpiler({ loader: "tsx" });
const ts = new Bun.Transpiler({ loader: "ts" });

/**
 * A workspace importing its OWN package name (`@atlas/api/lib/logger` from
 * inside packages/api) resolves through that package's `exports` map — the
 * self-reference feature — and has no node_modules entry. Skip those.
 */
function selfName(wsRoot: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(wsRoot, "package.json"), "utf8")) as { name?: string })
      .name ?? null;
  } catch {
    return null; // no manifest — nothing to self-reference
  }
}

/** pkg -> the files that import it, and the dir each import resolves FROM. */
const wanted = new Map<string, { files: Set<string>; fromDirs: Set<string> }>();
let scanned = 0;

for (const root of SHIPPED) {
  const abs = join(appRoot, root);
  // The workspace root (…/packages/api), not …/src — that is where the
  // node_modules walk starts for anything under it.
  const wsRoot = join(appRoot, root.replace(/\/src$/, ""));
  const own = selfName(wsRoot);
  for (const file of walk(abs)) {
    scanned++;
    let specs: string[];
    try {
      const src = readFileSync(file, "utf8");
      specs = (file.endsWith(".tsx") ? tsx : ts)
        .scanImports(src)
        // The transpiler emits the JSX runtime it would inject as synthetic
        // `require-call`s — and it emits React's (`react`, plus
        // `react/jsx-dev-runtime`) even for a file whose `@jsxImportSource` is
        // something else, as plugins/chat's cards' is (`chat`). Real require()
        // calls do exist in this source (mysql2/promise, pg), so filter by
        // whether the file actually writes the call rather than by specifier.
        .filter(
          (i) =>
            i.kind !== "require-call" ||
            src.includes(`require("${i.path}")`) ||
            src.includes(`require('${i.path}')`),
        )
        .map((i) => i.path);
    } catch (err) {
      console.warn(
        `warn: could not scan ${relative(appRoot, file)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const spec of specs) {
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (BUILTIN.test(spec)) continue;
      const pkg = pkgOf(spec);
      if (NODE_CORE.has(pkg)) continue;
      if (pkg === own) continue;
      let e = wanted.get(pkg);
      if (!e) wanted.set(pkg, (e = { files: new Set(), fromDirs: new Set() }));
      e.files.add(relative(appRoot, file));
      e.fromDirs.add(wsRoot);
    }
  }
}

/** Node/bun resolution: walk node_modules up from `fromDir` to `appRoot`. */
function resolvesFrom(fromDir: string, pkg: string): boolean {
  let dir = fromDir;
  for (;;) {
    const cand = join(dir, "node_modules", pkg);
    try {
      // statSync follows symlinks — a dangling workspace link is NOT resolved,
      // which is exactly the verdict we want.
      if (existsSync(cand) && statSync(cand).isDirectory()) return true;
    } catch {
      // intentionally ignored: unreadable/dangling candidate is a miss
    }
    if (dir === appRoot) return false;
    const parent = join(dir, "..");
    if (parent === dir || !parent.startsWith(appRoot)) return false;
    dir = parent;
  }
}

const missing: { pkg: string; files: string[] }[] = [];
const waived: string[] = [];

for (const [pkg, { files, fromDirs }] of [...wanted].sort((a, b) => a[0].localeCompare(b[0]))) {
  // A package is satisfied if it resolves from every workspace that imports it.
  const unresolved = [...fromDirs].filter((d) => !resolvesFrom(d, pkg));
  if (unresolved.length === 0) continue;
  if (ALLOWED_MISSING.has(pkg)) {
    waived.push(`${pkg} — ${ALLOWED_MISSING.get(pkg)}`);
    continue;
  }
  missing.push({ pkg, files: [...files].sort() });
}

console.log(
  `runtime-imports: scanned ${scanned} file(s) across ${SHIPPED.length} shipped workspace(s); ` +
    `${wanted.size} distinct bare import(s)`,
);
for (const w of waived.sort()) console.log(`runtime-imports: waived ${w}`);

if (missing.length > 0) {
  console.error(
    `\nERROR: ${missing.length} package(s) imported by shipped source do not resolve in the image:`,
  );
  for (const m of missing) {
    console.error(`  - ${m.pkg}`);
    for (const f of m.files.slice(0, 4)) console.error(`      ${f}`);
    if (m.files.length > 4) console.error(`      … +${m.files.length - 4} more file(s)`);
  }
  console.error(
    "\nThe prod-deps stage installs @atlas/api's PRODUCTION closure, so a package\n" +
      "imported from runtime source but declared in devDependencies is not shipped.\n" +
      "Move it to `dependencies` in the owning workspace's package.json — or, if the\n" +
      "import is lazy and its absence is handled, add it to ALLOWED_MISSING above\n" +
      "with the reason.",
  );
  process.exit(1);
}
console.log("runtime-imports: OK — every bare import in shipped source resolves.");
