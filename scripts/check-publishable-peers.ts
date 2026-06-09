#!/usr/bin/env bun
// Pre-publish ordering guard: verify every `@useatlas/*` peerDependency of the
// package about to be published is satisfiable on the npm registry RIGHT NOW.
//
// Why: workspace packages publish independently via tag-triggered steps in
// .github/workflows/publish.yml with no `needs:` ordering. A plugin whose peer
// range was bumped to a not-yet-published SDK version (e.g.
// `@useatlas/plugin-sdk: ">=0.0.8"` while npm has 0.0.7) installs cleanly
// in-repo (workspace resolution) but ERESOLVEs for every npm consumer the
// moment it ships. This guard turns that consumer-facing breakage into a
// publish-step failure with a "publish the dependency first" message.
//
// Usage: bun scripts/check-publishable-peers.ts <package-dir>
//   e.g. bun scripts/check-publishable-peers.ts plugins/salesforce

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun scripts/check-publishable-peers.ts <package-dir>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
  name?: string;
  peerDependencies?: Record<string, string>;
};

const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) =>
  name.startsWith("@useatlas/"),
);

if (peers.length === 0) {
  console.log(`${pkg.name ?? dir}: no @useatlas/* peerDependencies — nothing to check.`);
  process.exit(0);
}

let failed = false;
for (const [name, range] of peers) {
  let versions: string[];
  try {
    const raw = execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(raw) as string[] | string;
    versions = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error(
      `${name}: failed to read published versions from the registry (${err instanceof Error ? err.message : String(err)}).`,
    );
    failed = true;
    continue;
  }

  const satisfied = versions.some((v) => Bun.semver.satisfies(v, range));
  if (satisfied) {
    console.log(`${name}: range "${range}" satisfiable (published: ${versions.at(-1)}).`);
  } else {
    console.error(
      `::error::${pkg.name ?? dir} requires peer ${name} "${range}", but no published version satisfies it (latest: ${versions.at(-1) ?? "none"}). Publish ${name} first, then re-tag this package.`,
    );
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
