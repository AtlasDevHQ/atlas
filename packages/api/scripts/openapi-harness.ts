/**
 * Throwaway demo harness for the slice-0 OpenAPI primitive (issue #2923).
 *
 * NOT part of the shipped surface — it is a manual smoke vehicle for the two
 * deep modules under `src/lib/openapi/`. It fetches a spec, normalizes it, lists
 * the operations, and optionally runs ONE `executeOperation` call.
 *
 * Usage:
 *   ATLAS_OPENAPI_SPEC_URL=https://crm.useatlas.dev/rest/open-api/core \
 *   ATLAS_OPENAPI_TOKEN=<bearer> \
 *   bun packages/api/scripts/openapi-harness.ts
 *
 *   # optionally execute one operation:
 *   ATLAS_OPENAPI_OP=findManyPeople \
 *   ATLAS_OPENAPI_PARAMS='{"query":{"limit":3}}' \
 *   bun packages/api/scripts/openapi-harness.ts
 *
 * Acceptance vehicle: pointed at Twenty's /rest/open-api/core it prints every
 * Person operation (findManyPeople / findOnePerson / createOnePerson / …).
 */
import { buildOperationGraph } from "../src/lib/openapi/spec";
import { executeOperation } from "../src/lib/openapi/client";
import type { OperationParams, ResolvedAuth } from "../src/lib/openapi/types";

const specUrl = process.env.ATLAS_OPENAPI_SPEC_URL;
const token = process.env.ATLAS_OPENAPI_TOKEN;
const opId = process.env.ATLAS_OPENAPI_OP;
const baseUrlOverride = process.env.ATLAS_OPENAPI_BASE_URL;

if (!specUrl) {
  console.error("Set ATLAS_OPENAPI_SPEC_URL to the OpenAPI document URL.");
  process.exit(1);
}

const auth: ResolvedAuth = token ? { kind: "bearer", token } : { kind: "none" };

const specResponse = await fetch(specUrl, {
  headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" },
});
if (!specResponse.ok) {
  console.error(`Failed to fetch spec: HTTP ${specResponse.status}`);
  process.exit(1);
}

const doc: unknown = await specResponse.json();
const graph = buildOperationGraph(doc);

console.log(`\n${graph.info.title} (OpenAPI ${graph.info.openapiVersion})`);
console.log(`servers: ${graph.servers.map((s) => s.url).join(", ") || "(none)"}`);
console.log(`schemas: ${graph.schemas.size}, security schemes: ${[...graph.security.keys()].join(", ") || "(none)"}`);
console.log(`\noperations (${graph.operations.size}):`);
for (const op of graph.operations.values()) {
  console.log(`  ${op.method.padEnd(6)} ${op.path}  →  ${op.operationId}`);
}

if (opId) {
  let params: OperationParams = {};
  if (process.env.ATLAS_OPENAPI_PARAMS) {
    params = JSON.parse(process.env.ATLAS_OPENAPI_PARAMS) as OperationParams;
  }
  console.log(`\nexecuting ${opId} …`);
  const result = await executeOperation(graph, opId, params, auth, {
    ...(baseUrlOverride ? { baseUrl: baseUrlOverride } : {}),
  });
  console.log(`status: ${result.status}`);
  if (result.retryAfterMs !== undefined) console.log(`retry-after: ${result.retryAfterMs}ms`);
  console.log(JSON.stringify(result.body, null, 2));
}
