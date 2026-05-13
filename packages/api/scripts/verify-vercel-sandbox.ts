#!/usr/bin/env bun
/**
 * Verify the Vercel Sandbox integration end-to-end:
 *  1. Loads creds (explicit access-token path preferred — that's what Railway
 *     uses in SaaS — falls back to VERCEL_OIDC_TOKEN from `vercel env pull`
 *     for local development).
 *  2. Creates an ephemeral Node sandbox with `networkPolicy: "deny-all"`,
 *     matching what `packages/api/src/lib/tools/explore-sandbox.ts` does at
 *     runtime.
 *  3. Runs `echo hello-atlas` inside the sandbox and prints the captured
 *     stdout.
 *  4. Stops the sandbox.
 *
 * Run with:  bun run packages/api/scripts/verify-vercel-sandbox.ts
 *
 * For the Railway code path (explicit creds), set:
 *   VERCEL_TEAM_ID=team_xxx VERCEL_PROJECT_ID=prj_xxx VERCEL_TOKEN=xxx \
 *     bun run packages/api/scripts/verify-vercel-sandbox.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "@vercel/sandbox";

// Source .env.local from the repo root (bun doesn't auto-load it for scripts).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envLocal = resolve(repoRoot, ".env.local");
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

const teamId = process.env.VERCEL_TEAM_ID;
const projectId = process.env.VERCEL_PROJECT_ID;
const token = process.env.VERCEL_TOKEN;
const hasAccessTokenPath = !!(teamId && projectId && token);
const hasOidcPath = !!process.env.VERCEL_OIDC_TOKEN;

if (!hasAccessTokenPath && !hasOidcPath) {
  console.error(
    "No Vercel credentials found. Either set VERCEL_TEAM_ID/VERCEL_PROJECT_ID/VERCEL_TOKEN, " +
      "or run `vercel link && vercel env pull` to populate VERCEL_OIDC_TOKEN in .env.local.",
  );
  process.exit(1);
}

console.log(
  hasAccessTokenPath
    ? `[verify] using explicit access-token path (team=${teamId}, project=${projectId}) — same path Railway uses in SaaS`
    : "[verify] using VERCEL_OIDC_TOKEN from .env.local (Vercel-platform path)",
);

const createOpts = hasAccessTokenPath
  ? {
      runtime: "node24" as const,
      networkPolicy: "deny-all" as const,
      teamId: teamId!,
      projectId: projectId!,
      token: token!,
    }
  : {
      runtime: "node24" as const,
      networkPolicy: "deny-all" as const,
    };

const t0 = Date.now();
const sandbox = await Sandbox.create(createOpts);
console.log(`[verify] Sandbox.create() ok in ${Date.now() - t0}ms`);

try {
  const result = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", "echo hello-atlas"],
  });
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  console.log(`[verify] exitCode=${result.exitCode}`);
  console.log(`[verify] stdout: ${stdout.trim()}`);
  if (stderr.trim()) console.log(`[verify] stderr: ${stderr.trim()}`);

  if (result.exitCode !== 0 || stdout.trim() !== "hello-atlas") {
    console.error("[verify] FAILED — unexpected output");
    process.exit(1);
  }
  console.log("[verify] OK");
} finally {
  await sandbox.stop();
  console.log("[verify] sandbox stopped");
}
