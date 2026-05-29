import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { buildOperationGraph } from "../spec";
import { buildRestClientPreamble } from "../python-preamble";

const SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "twenty-acceptance", "spec.json"), "utf8"),
);
const graph = buildOperationGraph(SPEC);

const PREAMBLE = buildRestClientPreamble(graph, {
  baseUrlEnv: "ATLAS_REST_BASE_URL",
  authEnv: "ATLAS_REST_TOKEN",
});

/** Compile a Python snippet via `python3 -c` (ast.parse). Returns null if python3 is absent. */
async function pythonCompiles(source: string): Promise<{ ok: boolean; stderr: string } | null> {
  let proc;
  try {
    proc = Bun.spawn(["python3", "-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null; // python3 not installed
  }
  proc.stdin.write(source);
  proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stderr };
}

describe("buildRestClientPreamble", () => {
  it("bakes every operationId into the OPERATIONS dispatch table", () => {
    for (const op of graph.operations.values()) {
      expect(PREAMBLE).toContain(`"${op.operationId}": {"method": "${op.method}", "path": "${op.path}"}`);
    }
  });

  it("reads credentials from env by NAME — never inlines a token", () => {
    expect(PREAMBLE).toContain('os.environ["ATLAS_REST_BASE_URL"]');
    expect(PREAMBLE).toContain('os.environ.get("ATLAS_REST_TOKEN"');
    expect(PREAMBLE).toContain('"Bearer " + self.token');
  });

  it("exposes a generic call(operationId, path_params, query, body) dispatcher", () => {
    expect(PREAMBLE).toContain("class AtlasRestClient");
    expect(PREAMBLE).toContain("def call(self, operation_id, path_params=None, query=None, body=None)");
    expect(PREAMBLE).toContain("atlas_rest = AtlasRestClient()");
  });

  it("only sends a body on non-GET/HEAD methods", () => {
    expect(PREAMBLE).toContain('op["method"] not in ("GET", "HEAD")');
  });

  it("compiles as valid Python 3 (preamble + a representative agent body)", async () => {
    const agentBody = [
      PREAMBLE,
      "",
      "# representative agent emission: Matt's notes via the $ref chain",
      'people = atlas_rest.call("findManyPeople", query={"filter": "emails.primaryEmail[eq]:matt@example.com", "limit": 1})',
      'person = people["data"]["people"][0]',
      'targets = atlas_rest.call("findManyNoteTargets", query={"filter": "targetPersonId[eq]:" + person["id"]})',
      'for t in targets["data"]["noteTargets"]:',
      '    note = atlas_rest.call("findOneNote", path_params={"id": t["noteId"]})',
      '    print(note["data"]["note"]["title"])',
      "",
    ].join("\n");

    const result = await pythonCompiles(agentBody);
    if (result === null) {
      // No silent cap (CLAUDE.md): make the skip visible rather than passing mutely.
      console.warn("[python-preamble.test] python3 not available — skipped the compile check");
      return;
    }
    expect(result.ok, `python compile failed:\n${result.stderr}`).toBe(true);
  });
});
