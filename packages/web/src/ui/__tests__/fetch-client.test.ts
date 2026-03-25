import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { createAtlasFetch } from "../lib/fetch-client";

function mockResponse(
  status: number,
  body?: unknown,
  headers?: Record<string, string>,
): Response {
  const init: ResponseInit = { status, headers };
  if (body === undefined) {
    return new Response(null, init);
  }
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...headers },
  });
}

const defaultOpts = {
  apiUrl: "https://api.test",
  getHeaders: () => ({ Authorization: "Bearer tok" }),
  getCredentials: () => "include" as RequestCredentials,
};

const fetchSpy = spyOn(globalThis, "fetch");

beforeEach(() => {
  fetchSpy.mockReset();
});

afterAll(() => {
  fetchSpy.mockRestore();
});

describe("createAtlasFetch", () => {
  describe("GET", () => {
    it("returns parsed JSON on success", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { id: "1" }));
      const api = createAtlasFetch(defaultOpts);
      const data = await api.get<{ id: string }>("/items");
      expect(data).toEqual({ id: "1" });
    });

    it("builds the correct URL from apiUrl + path", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, {}));
      const api = createAtlasFetch(defaultOpts);
      await api.get("/api/v1/conversations?limit=50");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.test/api/v1/conversations?limit=50",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("POST", () => {
    it("sends JSON body and returns parsed response", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(201, { created: true }));
      const api = createAtlasFetch(defaultOpts);
      const data = await api.post<{ created: boolean }>("/items", {
        name: "test",
      });
      expect(data).toEqual({ created: true });
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe(JSON.stringify({ name: "test" }));
    });

    it("omits Content-Type and body when body is undefined", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, {}));
      const api = createAtlasFetch(defaultOpts);
      await api.post("/items");
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBeUndefined();
      expect(
        (init.headers as Record<string, string>)["Content-Type"],
      ).toBeUndefined();
    });
  });

  describe("PATCH", () => {
    it("sends PATCH with body", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { ok: true }));
      const api = createAtlasFetch(defaultOpts);
      await api.patch("/items/1", { starred: true });
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("PATCH");
      expect(init.body).toBe(JSON.stringify({ starred: true }));
    });
  });

  describe("DELETE", () => {
    it("sends DELETE and resolves on 204", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));
      const api = createAtlasFetch(defaultOpts);
      await expect(api.del("/items/1")).resolves.toBeUndefined();
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("DELETE");
    });
  });

  describe("error handling", () => {
    it("throws on non-ok response", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(404, { error: "not_found" }),
      );
      const api = createAtlasFetch(defaultOpts);
      await expect(api.get("/missing")).rejects.toThrow(
        "Failed to GET /missing (HTTP 404)",
      );
    });

    it("warns to console on non-ok response", async () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      fetchSpy.mockResolvedValueOnce(mockResponse(500));
      const api = createAtlasFetch(defaultOpts);
      await api.get("/fail").catch(() => {});
      expect(warnSpy).toHaveBeenCalledWith("fetch GET /fail: HTTP 500");
      warnSpy.mockRestore();
    });

    it("throws on 400", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(400));
      const api = createAtlasFetch(defaultOpts);
      await expect(api.post("/bad", {})).rejects.toThrow(
        "Failed to POST /bad (HTTP 400)",
      );
    });
  });

  describe("204 No Content", () => {
    it("returns undefined for 204 responses", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(204));
      const api = createAtlasFetch(defaultOpts);
      const result = await api.patch<void>("/items/1", { done: true });
      expect(result).toBeUndefined();
    });
  });

  describe("headers and credentials", () => {
    it("passes custom headers from getHeaders", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, {}));
      const api = createAtlasFetch({
        ...defaultOpts,
        getHeaders: () => ({
          "X-Custom": "val",
          Authorization: "Bearer abc",
        }),
      });
      await api.get("/test");
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Custom"]).toBe("val");
      expect(headers["Authorization"]).toBe("Bearer abc");
    });

    it("sets Content-Type for requests with body", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, {}));
      const api = createAtlasFetch(defaultOpts);
      await api.post("/test", { data: 1 });
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("passes credentials from getCredentials", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, {}));
      const api = createAtlasFetch({
        ...defaultOpts,
        getCredentials: () => "same-origin",
      });
      await api.get("/test");
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.credentials).toBe("same-origin");
    });
  });

  describe("body serialization", () => {
    it("serializes objects to JSON", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, {}));
      const api = createAtlasFetch(defaultOpts);
      const payload = { nested: { arr: [1, 2, 3] } };
      await api.post("/test", payload);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe(JSON.stringify(payload));
    });

    it("serializes arrays to JSON", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, {}));
      const api = createAtlasFetch(defaultOpts);
      await api.post("/test", [1, 2, 3]);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe("[1,2,3]");
    });
  });

  describe("raw", () => {
    it("returns the raw Response without error checking", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(404, { code: "not_found" }),
      );
      const api = createAtlasFetch(defaultOpts);
      const res = await api.raw("GET", "/missing");
      expect(res.status).toBe(404);
      expect(res.ok).toBe(false);
      const body = await res.json();
      expect(body).toEqual({ code: "not_found" });
    });

    it("applies headers and credentials like other methods", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, {}));
      const api = createAtlasFetch(defaultOpts);
      await api.raw("POST", "/test", { key: "val" });
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.test/test");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer tok");
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });
});
