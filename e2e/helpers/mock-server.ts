/**
 * Mock HTTP server factory for E2E tests.
 *
 * Uses Bun.serve() on a random port. Returns a handle with the URL,
 * a call log, and a close() method for cleanup.
 */

export interface MockCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timestamp: number;
}

export type MockHandler = (req: Request) => Response | Promise<Response>;

export interface MockServer {
  url: string;
  port: number;
  calls: MockCall[];
  /** Handler errors captured instead of silently swallowed by Bun.serve. */
  errors: Error[];
  close: () => void;
}

/**
 * Start a mock HTTP server on a random port.
 *
 * @param handler - Request handler function. If not provided, returns 200 with `{ ok: true }`.
 */
export function createMockServer(handler?: MockHandler): MockServer {
  const calls: MockCall[] = [];
  const errors: Error[] = [];

  const defaultHandler: MockHandler = () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });

  const server = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);
      const cloned = req.clone();
      const body = await cloned.text();
      calls.push({
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(req.headers.entries()),
        body,
        timestamp: Date.now(),
      });
      try {
        return await (handler ?? defaultHandler)(req);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        errors.push(e);
        return new Response(
          JSON.stringify({ error: "Mock handler threw", detail: e.message }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port!,
    calls,
    errors,
    close: () => server.stop(true),
  };
}

/**
 * Create a mock server that returns different responses for different routes.
 */
export function createRoutedMockServer(routes: Record<string, MockHandler>): MockServer {
  return createMockServer((req) => {
    const url = new URL(req.url);
    const handler = routes[url.pathname];
    if (handler) return handler(req);
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
}
