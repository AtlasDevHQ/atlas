import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as http from "http";
import { type AddressInfo } from "net";
import * as path from "path";

import {
  resolveTwentyDatasource,
  __resetTwentyDatasourceCacheForTests,
} from "../datasource";

const SPEC_TEXT = fs.readFileSync(
  path.join(import.meta.dir, "twenty-acceptance", "spec.json"),
  "utf8",
);

/** Env keys this suite owns — saved + restored so it stays hermetic. */
const ENV_KEYS = [
  "ATLAS_OPENAPI_TWENTY",
  "ATLAS_OPENAPI_TWENTY_TOKEN",
  "ATLAS_OPENAPI_TWENTY_BASE_URL",
  "ATLAS_OPENAPI_REPRESENTATION",
] as const;

let server: http.Server;
let baseUrl: string;
let specRequests: Array<{ url: string; auth: string | undefined }> = [];
/** Override the spec endpoint's behavior per-test. */
let specHandler: (res: http.ServerResponse) => void;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  __resetTwentyDatasourceCacheForTests();
  specRequests = [];
  specHandler = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(SPEC_TEXT);
  };

  server = http.createServer((req, res) => {
    if ((req.url ?? "").startsWith("/rest/open-api/core")) {
      specRequests.push({ url: req.url ?? "", auth: req.headers["authorization"] });
      specHandler(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetTwentyDatasourceCacheForTests();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function enable(): void {
  process.env.ATLAS_OPENAPI_TWENTY = "true";
  process.env.ATLAS_OPENAPI_TWENTY_TOKEN = "test-bearer-token";
  process.env.ATLAS_OPENAPI_TWENTY_BASE_URL = baseUrl;
}

describe("resolveTwentyDatasource", () => {
  it("returns null when the flag is off", async () => {
    process.env.ATLAS_OPENAPI_TWENTY = "false";
    process.env.ATLAS_OPENAPI_TWENTY_TOKEN = "x";
    process.env.ATLAS_OPENAPI_TWENTY_BASE_URL = baseUrl;
    expect(await resolveTwentyDatasource()).toBeNull();
  });

  it("returns null (fail-soft) when the flag is on but creds are missing", async () => {
    process.env.ATLAS_OPENAPI_TWENTY = "true";
    delete process.env.ATLAS_OPENAPI_TWENTY_TOKEN;
    delete process.env.ATLAS_OPENAPI_TWENTY_BASE_URL;
    expect(await resolveTwentyDatasource()).toBeNull();
  });

  it("probes /rest/open-api/core with a bearer header and resolves the graph", async () => {
    enable();
    const ds = await resolveTwentyDatasource();
    expect(ds).not.toBeNull();
    expect(ds!.id).toBe("twenty");
    expect(ds!.auth).toEqual({ kind: "bearer", token: "test-bearer-token" });
    // Operations execute against {base}/rest, not the bare base.
    expect(ds!.baseUrl).toBe(`${baseUrl}/rest`);
    expect(ds!.graph.operations.has("findManyPeople")).toBe(true);
    // The probe was authenticated.
    expect(specRequests).toHaveLength(1);
    expect(specRequests[0].auth).toBe("Bearer test-bearer-token");
  });

  it("caches the probe — a second call does not re-fetch the spec", async () => {
    enable();
    await resolveTwentyDatasource();
    await resolveTwentyDatasource();
    expect(specRequests).toHaveLength(1);
  });

  it("re-probes when reload is requested", async () => {
    enable();
    await resolveTwentyDatasource();
    await resolveTwentyDatasource({ reload: true });
    expect(specRequests).toHaveLength(2);
  });

  it("applies a rotated token immediately without re-probing the spec", async () => {
    enable();
    const first = await resolveTwentyDatasource();
    expect(first!.auth).toEqual({ kind: "bearer", token: "test-bearer-token" });

    // Rotate the token, keep the base URL. The cached graph is reused (no new
    // probe), but the CURRENT token must be applied — not the stale cached one.
    process.env.ATLAS_OPENAPI_TWENTY_TOKEN = "rotated-token";
    const second = await resolveTwentyDatasource();
    expect(second!.auth).toEqual({ kind: "bearer", token: "rotated-token" });
    expect(specRequests).toHaveLength(1);
  });

  it("returns null (fail-soft) on a non-2xx spec probe", async () => {
    enable();
    specHandler = (res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    };
    expect(await resolveTwentyDatasource()).toBeNull();
  });

  it("returns null (fail-soft) on an unparseable spec", async () => {
    enable();
    specHandler = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ not: "an openapi document" }));
    };
    expect(await resolveTwentyDatasource()).toBeNull();
  });

  // ── Representation-mode knob (#2931 bake-off selector) ─────────────────
  it("defaults to operation-graph (Path A) when ATLAS_OPENAPI_REPRESENTATION is unset", async () => {
    enable();
    delete process.env.ATLAS_OPENAPI_REPRESENTATION;
    const ds = await resolveTwentyDatasource();
    expect(ds!.representationMode).toBe("operation-graph");
  });

  it("selects semantic-yaml (Path B) when configured", async () => {
    enable();
    process.env.ATLAS_OPENAPI_REPRESENTATION = "semantic-yaml";
    const ds = await resolveTwentyDatasource();
    expect(ds!.representationMode).toBe("semantic-yaml");
  });

  it("falls back to the default (fail-soft) on an unknown representation value", async () => {
    enable();
    process.env.ATLAS_OPENAPI_REPRESENTATION = "not-a-real-mode";
    const ds = await resolveTwentyDatasource();
    expect(ds!.representationMode).toBe("operation-graph");
  });

  it("applies a changed representation mode without re-probing the cached spec", async () => {
    enable();
    process.env.ATLAS_OPENAPI_REPRESENTATION = "operation-graph";
    const first = await resolveTwentyDatasource();
    expect(first!.representationMode).toBe("operation-graph");
    // Flip the knob; the graph stays cached but the mode is rebuilt per call.
    process.env.ATLAS_OPENAPI_REPRESENTATION = "semantic-yaml";
    const second = await resolveTwentyDatasource();
    expect(second!.representationMode).toBe("semantic-yaml");
    expect(specRequests).toHaveLength(1);
  });

  it("negative-caches a failed probe — repeated calls do NOT re-probe (#2975)", async () => {
    // A failed probe is never graph-cached, so without the negative cache every
    // call would re-run the (up to 30s) probe — hanging unrelated executePython
    // analysis when the REST datasource is misconfigured.
    enable();
    specHandler = (res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream down" }));
    };
    expect(await resolveTwentyDatasource()).toBeNull();
    expect(await resolveTwentyDatasource()).toBeNull();
    expect(await resolveTwentyDatasource()).toBeNull();
    // Only the first call probed; the next two were short-circuited by the cache.
    expect(specRequests).toHaveLength(1);
  });

  it("reload bypasses the negative cache (forces a fresh probe after a failure)", async () => {
    enable();
    specHandler = (res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream down" }));
    };
    expect(await resolveTwentyDatasource()).toBeNull(); // probe #1 (fails, negative-cached)
    expect(await resolveTwentyDatasource({ reload: true })).toBeNull(); // probe #2 (reload bypasses)
    expect(specRequests).toHaveLength(2);
  });

  it("a successful probe clears the negative cache (recovered datasource resolves)", async () => {
    enable();
    // First the spec is down → negative-cached.
    specHandler = (res) => {
      res.writeHead(503, {});
      res.end("down");
    };
    expect(await resolveTwentyDatasource()).toBeNull();
    // It recovers; `reload` forces a real probe past the negative window, which
    // succeeds and clears the negative entry…
    specHandler = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(SPEC_TEXT);
    };
    expect(await resolveTwentyDatasource({ reload: true })).not.toBeNull();
    // …so a subsequent normal call serves the now-cached graph (no re-probe, and
    // crucially not a stale negative-cache null).
    expect(await resolveTwentyDatasource()).not.toBeNull();
    expect(specRequests).toHaveLength(2);
  });
});
