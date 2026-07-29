#!/usr/bin/env bun
/**
 * Converts `bun.lock` into a GitHub dependency snapshot and submits it through
 * the Dependency Submission API.
 *
 * Why this exists: the GitHub dependency graph does not parse `bun.lock`. It
 * parses package-lock.json, yarn.lock and pnpm-lock.yaml only, so on this repo
 * the graph held 150 unique packages — read off the 53 `package.json` manifests
 * as unresolved caret RANGES — against 2133 resolved packages in the lockfile.
 * Every transitive-only package (undici, tar, axios, sharp, form-data,
 * shell-quote, postcss, brace-expansion, uuid, protobufjs, fast-uri) was
 * therefore invisible to Dependabot, which is why `image-scan.yml` could hand
 * npm advisories to Dependabot and have nothing whatsoever happen. See #4878.
 *
 * Because the graph stored RANGES rather than resolved versions, it also could
 * not tell a vulnerable build from a fixed one: `next: ^16.2.9` reads as
 * already-satisfiable even when the lockfile pins a vulnerable 16.2.9.
 *
 * Submitting the resolved closure fixes visibility — alerts do fire on
 * submitted dependencies. It does NOT buy automatic fix PRs: `bun` is a
 * separate Dependabot ecosystem from `npm` and does not support security
 * updates. Remediation stays with Trivy-on-image plus root `overrides`.
 *
 * The snapshot is generated from the committed lockfile on every run and never
 * itself committed, so it cannot drift the way a checked-in package-lock.json
 * would — a second lockfile would also invite Dependabot to "fix" a file bun
 * never reads.
 *
 * Usage:
 *   bun run scripts/submit-dependency-snapshot.ts --out snapshot.json   # local, no network
 *   bun run scripts/submit-dependency-snapshot.ts                       # submit (CI)
 */

type LockEntry = [id: string, registry: unknown, meta?: unknown, hash?: string];
type DepMap = Record<string, string>;
type WorkspaceEntry = {
  name?: string;
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
  peerDependencies?: DepMap;
};
type Lockfile = {
  lockfileVersion?: number;
  workspaces?: Record<string, WorkspaceEntry>;
  packages?: Record<string, LockEntry>;
};

type Scope = "runtime" | "development";
type Relationship = "direct" | "indirect";

const RUNTIME_DEP_KINDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * bun.lock is JSON with `//` comments and trailing commas permitted. Strip both
 * rather than pulling in a JSON5 dependency for one file.
 */
function parseLockfile(text: string): Lockfile {
  const stripped = text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as Lockfile;
}

/**
 * Split a lock path into package-name segments. Scoped names contain a `/`
 * themselves, so `@discordjs/rest/undici` is TWO segments
 * (`@discordjs/rest`, `undici`), not three — a naive split corrupts every
 * scoped nesting in the tree.
 */
function pathSegments(key: string): string[] {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const next = parts[i + 1];
    if (part.startsWith("@") && next !== undefined) {
      out.push(`${part}/${next}`);
      i++;
    } else {
      out.push(part);
    }
  }
  return out;
}

/** Split a lock entry id (`name@version`) on the LAST `@` so scopes survive. */
function splitId(id: string): { name: string; version: string } | undefined {
  const at = id.lastIndexOf("@");
  if (at <= 0) return undefined;
  return { name: id.slice(0, at), version: id.slice(at + 1) };
}

/** purl for an npm package; the scope's `@` must be percent-encoded. */
function packageUrl(name: string, version: string): string {
  const encoded = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

function declaredDeps(meta: unknown, kinds: readonly string[]): DepMap {
  if (!meta || typeof meta !== "object") return {};
  const record = meta as Record<string, unknown>;
  const out: DepMap = {};
  for (const kind of kinds) {
    const group = record[kind];
    if (!group || typeof group !== "object") continue;
    for (const [name, range] of Object.entries(group as Record<string, unknown>)) {
      if (typeof range === "string") out[name] = range;
    }
  }
  return out;
}

export function buildSnapshotManifest(lock: Lockfile) {
  const packages = lock.packages ?? {};
  const workspaces = lock.workspaces ?? {};

  /**
   * Resolve a dependency edge the way bun's hoisting does: prefer the most
   * deeply nested entry, then walk up toward the bare (hoisted) name.
   */
  const resolveFrom = (fromKey: string, depName: string): string | undefined => {
    const segs = fromKey === "" ? [] : pathSegments(fromKey);
    for (let i = segs.length; i >= 0; i--) {
      const candidate = [...segs.slice(0, i), depName].join("/");
      if (packages[candidate]) return candidate;
    }
    return undefined;
  };

  // Workspace packages are first-party and carry no registry version; they are
  // edges into the graph, not nodes of it.
  const workspaceNames = new Set(
    Object.values(workspaces)
      .map((w) => w.name)
      .filter((n): n is string => typeof n === "string"),
  );

  const directKeys = new Set<string>();
  const runtimeRoots: string[] = [];
  const devRoots: string[] = [];
  for (const ws of Object.values(workspaces)) {
    for (const [name] of Object.entries(declaredDeps(ws, RUNTIME_DEP_KINDS))) {
      const key = resolveFrom("", name);
      if (key) { directKeys.add(key); runtimeRoots.push(key); }
    }
    for (const [name] of Object.entries(declaredDeps(ws, ["devDependencies"]))) {
      const key = resolveFrom("", name);
      if (key) { directKeys.add(key); devRoots.push(key); }
    }
  }

  // Reachability decides scope: a package is `development` only if nothing in
  // the runtime closure reaches it. Marking every transitive package "runtime"
  // would overstate the production surface.
  const scopeOf = new Map<string, Scope>();
  const walk = (roots: string[], scope: Scope) => {
    const queue = [...roots];
    while (queue.length > 0) {
      const key = queue.pop();
      if (key === undefined) continue;
      if (scopeOf.get(key) === "runtime") continue;
      if (scopeOf.get(key) === scope) continue;
      scopeOf.set(key, scope);
      const entry = packages[key];
      if (!entry) continue;
      for (const depName of Object.keys(declaredDeps(entry[2], RUNTIME_DEP_KINDS))) {
        const next = resolveFrom(key, depName);
        if (next) queue.push(next);
      }
    }
  };
  walk(runtimeRoots, "runtime");
  walk(devRoots, "development");

  const resolved: Record<string, {
    package_url: string;
    relationship: Relationship;
    scope: Scope;
    dependencies?: string[];
  }> = {};

  let skipped = 0;
  for (const [key, entry] of Object.entries(packages)) {
    const id = typeof entry?.[0] === "string" ? entry[0] : "";
    const split = splitId(id);
    if (!split) { skipped++; continue; }
    const { name, version } = split;
    // `workspace:`-versioned and first-party entries are not registry packages.
    if (version.startsWith("workspace:") || version === "" || workspaceNames.has(name)) {
      skipped++;
      continue;
    }
    const deps: string[] = [];
    for (const depName of Object.keys(declaredDeps(entry[2], RUNTIME_DEP_KINDS))) {
      const target = resolveFrom(key, depName);
      if (target && target !== key) deps.push(target);
    }
    resolved[key] = {
      package_url: packageUrl(name, version),
      relationship: directKeys.has(key) ? "direct" : "indirect",
      scope: scopeOf.get(key) ?? "runtime",
      ...(deps.length > 0 ? { dependencies: deps } : {}),
    };
  }

  return { resolved, skipped };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to submit a snapshot (set --out to run offline)`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined;

  const lockPath = "bun.lock";
  const lock = parseLockfile(await Bun.file(lockPath).text());
  const { resolved, skipped } = buildSnapshotManifest(lock);
  const count = Object.keys(resolved).length;

  // A snapshot that silently resolved almost nothing would replace real graph
  // data with an empty picture, which reads as "no vulnerabilities" — the exact
  // failure this script exists to end. Refuse instead.
  if (count < 500) {
    throw new Error(
      `refusing to submit: only ${count} packages resolved from ${lockPath} ` +
        `(expected >500). Lockfile format may have changed.`,
    );
  }

  const snapshot = {
    version: 0,
    job: {
      correlator: `${process.env.GITHUB_WORKFLOW ?? "local"}-${process.env.GITHUB_JOB ?? "local"}`,
      id: process.env.GITHUB_RUN_ID ?? "local",
    },
    sha: process.env.GITHUB_SHA ?? "0000000000000000000000000000000000000000",
    ref: process.env.GITHUB_REF ?? "refs/heads/main",
    detector: {
      name: "atlas-bun-lock-to-snapshot",
      version: "1.0.0",
      url: "https://github.com/AtlasDevHQ/atlas/blob/main/scripts/submit-dependency-snapshot.ts",
    },
    scanned: new Date().toISOString(),
    manifests: {
      [lockPath]: {
        name: lockPath,
        file: { source_location: lockPath },
        resolved,
      },
    },
  };

  console.log(
    `bun.lock -> snapshot: ${count} packages ` +
      `(${Object.values(resolved).filter((r) => r.relationship === "direct").length} direct, ` +
      `${Object.values(resolved).filter((r) => r.scope === "development").length} development-scoped; ` +
      `${skipped} non-registry entries skipped)`,
  );

  if (outFile) {
    await Bun.write(outFile, JSON.stringify(snapshot, null, 2));
    console.log(`wrote ${outFile} (not submitted)`);
    return;
  }

  const repository = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("GITHUB_TOKEN");
  const response = await fetch(
    `https://api.github.com/repos/${repository}/dependency-graph/snapshots`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(snapshot),
    },
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`snapshot submission failed: ${response.status} ${response.statusText} — ${body}`);
  }
  console.log(`submitted: ${response.status} ${body}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
