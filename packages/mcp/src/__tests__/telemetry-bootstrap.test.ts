/**
 * Tests for the standalone MCP OTel bootstrap (#3199).
 *
 * Asserts the entry-point seam: OTel initializes (with service.name
 * "atlas-mcp") when OTEL_EXPORTER_OTLP_ENDPOINT is set, and no-ops cleanly
 * when it is unset — without pulling in the real @opentelemetry/sdk-node.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Shared shutdown handle the mocked initTelemetry hands back.
const mockShutdown = mock(async () => {});

// Indirection so individual tests can swap the init behaviour (success vs
// throw) without depending on mockImplementationOnce semantics.
let initImpl: (opts?: { serviceName?: string }) => Promise<() => Promise<void>> =
  async () => mockShutdown;

const mockInitTelemetry = mock((opts?: { serviceName?: string }) =>
  initImpl(opts),
);

// Sync factory (bun:test async mock.module factories deadlock the loader).
// Mock ALL exports of the real module per CLAUDE.md.
void mock.module("@atlas/api/lib/telemetry", () => ({
  initTelemetry: mockInitTelemetry,
  shutdownTelemetry: mockShutdown,
}));

const { startMcpTelemetry, MCP_OTEL_SERVICE_NAME } = await import(
  "../telemetry-bootstrap"
);

const ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
const ORIG_ENDPOINT = process.env[ENDPOINT];

describe("startMcpTelemetry", () => {
  beforeEach(() => {
    mockInitTelemetry.mockClear();
    mockShutdown.mockClear();
    initImpl = async () => mockShutdown;
  });

  afterEach(() => {
    if (ORIG_ENDPOINT === undefined) delete process.env[ENDPOINT];
    else process.env[ENDPOINT] = ORIG_ENDPOINT;
  });

  test("no-ops (returns null, never inits) when the OTLP endpoint is unset", async () => {
    delete process.env[ENDPOINT];

    const shutdown = await startMcpTelemetry();

    expect(shutdown).toBeNull();
    expect(mockInitTelemetry).not.toHaveBeenCalled();
  });

  test("initializes OTel as service 'atlas-mcp' when the endpoint is set", async () => {
    process.env[ENDPOINT] = "http://collector:4318";

    const shutdown = await startMcpTelemetry();

    expect(mockInitTelemetry).toHaveBeenCalledTimes(1);
    expect(mockInitTelemetry).toHaveBeenCalledWith({
      serviceName: "atlas-mcp",
    });
    // Returns the SDK shutdown handle so the entry point can flush on exit.
    expect(shutdown).toBe(mockShutdown);
  });

  test("returns null (best-effort) when initialization throws", async () => {
    process.env[ENDPOINT] = "http://collector:4318";
    initImpl = async () => {
      throw new Error("exporter import failed");
    };

    // Must not throw — telemetry failure can't stop the MCP server booting.
    const shutdown = await startMcpTelemetry();

    expect(shutdown).toBeNull();
    expect(mockInitTelemetry).toHaveBeenCalledTimes(1);
  });

  test("MCP service name constant is 'atlas-mcp'", () => {
    expect(MCP_OTEL_SERVICE_NAME).toBe("atlas-mcp");
  });
});
