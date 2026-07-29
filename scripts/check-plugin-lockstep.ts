/**
 * Guard: the plugins the SaaS image BOOT-LOADS must be wired in every place
 * `deploy/api/Dockerfile` needs them.
 *
 * `deploy/api/atlas.config.ts` is the source of truth for what the api process
 * loads at boot. Three separate lists in the Dockerfile have to agree with it,
 * and until now all three were held in lockstep by comments alone:
 *
 *   1. the prod-deps `--filter` list — scopes the runtime dependency install
 *      (#4880). A boot-loaded plugin missing here gets no node_modules of its
 *      own, so its peers (`@useatlas/plugin-sdk`, its driver SDK) resolve only
 *      by accident, if at all.
 *   2. the symlink-rebuild loop — recreates each plugin's
 *      `@useatlas/{plugin-sdk,types}` links, because the multi-stage COPY chain
 *      does not reliably preserve them.
 *   3. the runtime-import assertion loop — actually imports each plugin at
 *      build time.
 *
 * List 3 is what makes 1 and 2 fail loudly, but it is itself hardcoded: adding
 * a sixth plugin to atlas.config.ts without touching the Dockerfile builds
 * green and then fails the way #4880 describes — a dangling peer that doesn't
 * break boot, just silently reports the adapter unavailable. This closes that.
 *
 * A plugin needs no `--filter` entry if it is already a dependency of
 * @atlas/api (the filter pulls it in transitively) — that is why
 * `@useatlas/chat` is absent from the filter list and still correct.
 *
 * Extra entries in the symlink loop are allowed: `e2b`/`daytona` are lazily
 * imported BYOC runtimes rather than boot-loaded, and `salesforce` is wired
 * defensively though atlas.config.ts excludes it.
 *
 * Usage: bun scripts/check-plugin-lockstep.ts
 *
 * PLUGIN_LOCKSTEP_ROOT repoints the gate at a scaffolded tree — that is how
 * scripts/__tests__/check-plugin-lockstep.test.sh exercises it without
 * touching the real repo.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = process.env.PLUGIN_LOCKSTEP_ROOT || join(import.meta.dir, "..");
const CONFIG = join(ROOT, "deploy/api/atlas.config.ts");
const DOCKERFILE = join(ROOT, "deploy/api/Dockerfile");

function fail(msg: string): never {
  console.error(`::error::${msg}`);
  process.exit(1);
}

for (const f of [CONFIG, DOCKERFILE]) {
  if (!existsSync(f)) fail(`missing ${f} — this guard is stale, fix the path`);
}

const config = readFileSync(CONFIG, "utf8");
const dockerfile = readFileSync(DOCKERFILE, "utf8");

// --- 1. Boot-loaded plugin set, from atlas.config.ts -----------------------
// `import { clickhousePlugin } from "./plugins/clickhouse/src/index";`
const identToDir = new Map<string, string>();
for (const m of config.matchAll(
  /import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*["']\.\/plugins\/([a-z0-9-]+)\/src\/index["']/g,
)) {
  identToDir.set(m[1], m[2]);
}
if (identToDir.size === 0) {
  fail("parsed no plugin imports out of atlas.config.ts — the import shape changed, update this guard");
}

// An import alone doesn't mean it's loaded; it has to be invoked in `plugins: [ … ]`.
const open = config.indexOf("plugins: [");
if (open === -1) fail("no `plugins: [` array found in atlas.config.ts — update this guard");
let depth = 0;
let close = -1;
for (let i = config.indexOf("[", open); i < config.length; i++) {
  if (config[i] === "[") depth++;
  else if (config[i] === "]" && --depth === 0) {
    close = i;
    break;
  }
}
if (close === -1) fail("could not find the end of the `plugins: [` array in atlas.config.ts");
const pluginsArray = config.slice(open, close);

const bootLoaded = new Set<string>();
for (const [ident, dir] of identToDir) {
  if (new RegExp(`\\b${ident}\\s*\\(`).test(pluginsArray)) bootLoaded.add(dir);
}
if (bootLoaded.size === 0) fail("no plugin factory calls found inside `plugins: [ … ]` — update this guard");

// --- 2. The three Dockerfile lists ----------------------------------------
const filters = new Set(
  [...dockerfile.matchAll(/--filter=(?:'|")([^'"]+)(?:'|")/g)].map((m) => m[1]),
);
if (filters.size === 0) fail("no --filter entries found in the Dockerfile — the prod-deps stage changed, update this guard");

/** Both wiring loops are `for p in <names>; do …`; tell them apart by body. */
function loopEntries(marker: string, label: string): Set<string> {
  for (const m of dockerfile.matchAll(/for p in ([a-z0-9 -]+);\s*do([\s\S]*?)done/g)) {
    if (m[2].includes(marker)) return new Set(m[1].trim().split(/\s+/));
  }
  return fail(`could not locate the ${label} loop (looked for ${marker}) — update this guard`);
}
const symlinked = loopEntries("plugin-sdk", "symlink-rebuild");
const asserted = loopEntries("await import('/app/plugins/", "runtime-import assertion");

// --- 3. @atlas/api's own dependencies satisfy the filter requirement -------
const apiPkg = JSON.parse(readFileSync(join(ROOT, "packages/api/package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const apiDeps = new Set(Object.keys(apiPkg.dependencies ?? {}));

/** plugins/<dir> -> its package name. */
function pluginName(dir: string): string | null {
  const f = join(ROOT, "plugins", dir, "package.json");
  if (!existsSync(f)) return null;
  return (JSON.parse(readFileSync(f, "utf8")) as { name?: string }).name ?? null;
}

// --- 4. Assert -------------------------------------------------------------
const problems: string[] = [];

for (const dir of [...bootLoaded].sort()) {
  const name = pluginName(dir);
  if (!name) {
    problems.push(`plugins/${dir} is boot-loaded by atlas.config.ts but has no readable package.json`);
    continue;
  }
  if (!asserted.has(dir)) {
    problems.push(
      `plugins/${dir} is boot-loaded but missing from the Dockerfile's runtime-import assertion loop — ` +
        `nothing would prove it still imports in the image`,
    );
  }
  if (!symlinked.has(dir)) {
    problems.push(
      `plugins/${dir} is boot-loaded but missing from the Dockerfile's symlink-rebuild loop — ` +
        `its @useatlas/plugin-sdk peer may dangle at boot`,
    );
  }
  if (!filters.has(name) && !apiDeps.has(name)) {
    problems.push(
      `plugins/${dir} (${name}) is boot-loaded but is neither in the prod-deps --filter list nor a ` +
        `dependency of @atlas/api — the scoped install would not populate its node_modules`,
    );
  }
}

// Reverse direction: a list entry for a plugin that is no longer boot-loaded
// is stale. Only checked for the assertion loop — the symlink loop
// deliberately carries lazily-loaded extras (e2b, daytona, salesforce).
for (const dir of [...asserted].sort()) {
  if (!bootLoaded.has(dir)) {
    problems.push(
      `plugins/${dir} is in the Dockerfile's runtime-import assertion loop but atlas.config.ts no ` +
        `longer boot-loads it — drop it from the loop (and from --filter if it is there)`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `Plugin lockstep check FAILED — deploy/api/atlas.config.ts and deploy/api/Dockerfile disagree:\n`,
  );
  for (const p of problems) console.error(`::error::${p}`);
  console.error(
    `\nBoot-loaded per atlas.config.ts: ${[...bootLoaded].sort().join(", ")}\n` +
      `Dockerfile --filter:            ${[...filters].sort().join(", ")}\n` +
      `Dockerfile symlink loop:        ${[...symlinked].sort().join(", ")}\n` +
      `Dockerfile assertion loop:      ${[...asserted].sort().join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `Plugin lockstep check passed — ${bootLoaded.size} boot-loaded plugin(s) ` +
    `(${[...bootLoaded].sort().join(", ")}) wired in all three Dockerfile lists.`,
);
