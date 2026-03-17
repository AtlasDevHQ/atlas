import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock logger — getRequestContext returns a controllable value
let mockRequestId: string | undefined;
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  getRequestContext: () =>
    mockRequestId ? { requestId: mockRequestId } : undefined,
}));

const {
  setStreamWriter,
  clearStreamWriter,
  getStreamWriter,
} = await import("@atlas/api/lib/tools/python-stream");

describe("python-stream writer store", () => {
  beforeEach(() => {
    mockRequestId = undefined;
    // Clean up any leftover writers from previous tests
    clearStreamWriter("test-req-1");
    clearStreamWriter("test-req-2");
  });

  it("round-trips: set then get returns the writer", () => {
    const fakeWriter = { write: () => {}, merge: () => {} } as never;
    mockRequestId = "test-req-1";
    setStreamWriter("test-req-1", fakeWriter);
    expect(getStreamWriter()).toBe(fakeWriter);
    clearStreamWriter("test-req-1");
  });

  it("returns undefined when no request context exists", () => {
    mockRequestId = undefined;
    expect(getStreamWriter()).toBeUndefined();
  });

  it("returns undefined when context exists but no writer registered", () => {
    mockRequestId = "unregistered-request";
    expect(getStreamWriter()).toBeUndefined();
  });

  it("clearStreamWriter removes the writer", () => {
    const fakeWriter = { write: () => {}, merge: () => {} } as never;
    mockRequestId = "test-req-1";
    setStreamWriter("test-req-1", fakeWriter);
    expect(getStreamWriter()).toBe(fakeWriter);
    clearStreamWriter("test-req-1");
    expect(getStreamWriter()).toBeUndefined();
  });

  it("isolates writers by request ID", () => {
    const writer1 = { write: () => {}, merge: () => {}, id: 1 } as never;
    const writer2 = { write: () => {}, merge: () => {}, id: 2 } as never;
    setStreamWriter("test-req-1", writer1);
    setStreamWriter("test-req-2", writer2);

    mockRequestId = "test-req-1";
    expect(getStreamWriter()).toBe(writer1);

    mockRequestId = "test-req-2";
    expect(getStreamWriter()).toBe(writer2);

    clearStreamWriter("test-req-1");
    clearStreamWriter("test-req-2");
  });

  it("clearing one request does not affect another", () => {
    const writer1 = { write: () => {}, merge: () => {} } as never;
    const writer2 = { write: () => {}, merge: () => {} } as never;
    setStreamWriter("test-req-1", writer1);
    setStreamWriter("test-req-2", writer2);

    clearStreamWriter("test-req-1");

    mockRequestId = "test-req-2";
    expect(getStreamWriter()).toBe(writer2);

    clearStreamWriter("test-req-2");
  });
});
