#!/usr/bin/env bun
/**
 * Emit a CI-ready SaaS env block in `KEY=VALUE` (Docker `--env-file`) format.
 *
 * Pipeline:
 *
 *   bun run scripts/saas-env-fixture.ts \
 *     --database-url postgresql://atlas:atlas@127.0.0.1:5432/atlas \
 *     > /tmp/saas.env
 *   docker run -d --env-file /tmp/saas.env atlas-api:boot-smoke
 *
 * The single source of truth for which keys are emitted is
 * `packages/api/src/lib/effect/saas-env.ts :: makeBootSmokeFixture`.
 * Adding a new SaaS guard means appending its env var to that fixture
 * — this script (and the boot-smoke workflow that consumes its output)
 * automatically picks up the new value with no further edits.
 *
 * Usage:
 *   --database-url <url>   Postgres URL applied to internal DB,
 *                          datasource, and every region. Required.
 *   --override KEY=VALUE   Override a single key (repeatable). Useful
 *                          for failure-mode probes (e.g. drop a
 *                          required key to verify the gate fails).
 *   --omit KEY             Omit a key entirely from the output (its
 *                          fixture default is dropped). Repeatable.
 *
 * Values are emitted as raw `KEY=VALUE`. Docker's `--env-file` parser
 * is line-oriented and does NOT support quoting, so this script
 * deliberately rejects values containing newlines (newline in a SaaS
 * boot-contract value is always a misconfig). Equals signs in values
 * are fine — Docker splits on the first `=` only.
 */

// Relative import: this script lives in the repo root scripts/ dir,
// where the @atlas/api workspace alias is not resolvable (root has no
// dependency on it). Other root scripts (e.g. generate-brand-assets.tsx)
// avoid this by using only root devDependencies.
import {
  makeBootSmokeFixture,
  SAAS_ENV_KEYS,
  type SaasEnv,
} from "../packages/api/src/lib/effect/saas-env";

interface Args {
  databaseUrl?: string;
  overrides: Partial<SaasEnv>;
  omit: Set<keyof SaasEnv>;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { overrides: {}, omit: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--database-url") {
      args.databaseUrl = argv[++i];
    } else if (arg === "--override") {
      const next = argv[++i];
      if (!next || !next.includes("=")) {
        throw new Error(
          `--override expects KEY=VALUE, got ${JSON.stringify(next)}`,
        );
      }
      const eq = next.indexOf("=");
      const key = next.slice(0, eq) as keyof SaasEnv;
      const value = next.slice(eq + 1);
      if (!SAAS_ENV_KEYS.includes(key as (typeof SAAS_ENV_KEYS)[number])) {
        throw new Error(
          `--override key ${JSON.stringify(key)} is not a SaasEnv key. ` +
            `Valid keys: ${SAAS_ENV_KEYS.join(", ")}`,
        );
      }
      args.overrides[key] = value;
    } else if (arg === "--omit") {
      const key = argv[++i] as keyof SaasEnv;
      if (!SAAS_ENV_KEYS.includes(key as (typeof SAAS_ENV_KEYS)[number])) {
        throw new Error(
          `--omit key ${JSON.stringify(key)} is not a SaasEnv key. ` +
            `Valid keys: ${SAAS_ENV_KEYS.join(", ")}`,
        );
      }
      args.omit.add(key);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${JSON.stringify(arg)}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `Usage: bun run scripts/saas-env-fixture.ts [options]\n\n` +
      `Options:\n` +
      `  --database-url <url>   Postgres URL for internal DB + datasource + regions\n` +
      `  --override KEY=VALUE   Override a single key (repeatable)\n` +
      `  --omit KEY             Drop a key from output (repeatable)\n` +
      `  --help, -h             Show this help\n`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const fixture = makeBootSmokeFixture({
    ...(args.databaseUrl ? { databaseUrl: args.databaseUrl } : {}),
    overrides: args.overrides,
  });

  const lines: string[] = [];
  for (const key of SAAS_ENV_KEYS) {
    if (args.omit.has(key)) continue;
    const value = fixture[key];
    if (value === undefined) continue;
    if (value.includes("\n")) {
      throw new Error(
        `SaaS fixture value for ${key} contains a newline — Docker --env-file ` +
          `is line-oriented and cannot represent it. This indicates a misconfig in ` +
          `makeBootSmokeFixture; newlines in boot-contract values are not legitimate.`,
      );
    }
    lines.push(`${key}=${value}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`saas-env-fixture: ${message}\n`);
  process.exit(1);
}
