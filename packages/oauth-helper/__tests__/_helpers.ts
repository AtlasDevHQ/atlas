/**
 * Test-shared captureFetch + JSON helpers. Mirrors the SDK's
 * `mcp.test.ts` shape so primitive tests look the same as integration
 * tests at the consumer layer.
 */

export interface CapturedRequest {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

export type FetchStub = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function captureFetch(
  handlers: Record<string, () => Response>,
): { fetchImpl: FetchStub; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: FetchStub = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => (headers[k.toLowerCase()] = v));
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    calls.push({ url, method, body, headers });
    for (const [key, handler] of Object.entries(handlers)) {
      if (url.includes(key)) return handler();
    }
    throw new Error(`captureFetch: no handler for ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

/** Deterministic PRNG seam — every byte is its own index modulo 256. */
export function deterministicRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i & 0xff;
  return bytes;
}

/** Encode `payload` as the (unsigned) middle segment of a JWT-shaped string. */
export function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.sig`;
}
