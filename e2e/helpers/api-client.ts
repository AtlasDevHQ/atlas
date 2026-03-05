/**
 * Typed HTTP client for Atlas API E2E tests.
 *
 * Wraps fetch with typed methods for health, query, and generic HTTP.
 * Targets a running API server by base URL.
 */

export interface HealthResponse {
  status: string;
  warnings?: string[];
  checks: {
    datasource: { status: string; latencyMs?: number; error?: string };
    provider: { status: string; provider: string; model: string; error?: string };
    semanticLayer: { status: string; entityCount: number; error?: string };
    internalDb: { status: string; latencyMs?: number; error?: string };
    explore: { backend: string; isolated: boolean };
    auth: { mode: string; enabled: boolean; error?: string };
    slack: { enabled: boolean; mode: string };
  };
  sources?: Record<string, { status: string; latencyMs?: number; dbType: string }>;
}

export interface QueryResponse {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  durationMs: number;
}

export interface AtlasClientOptions {
  /** Base URL for the API (e.g. "http://localhost:3099") */
  baseUrl: string;
  /** Optional API key for Authorization header */
  apiKey?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
}

function parseJsonBody<T>(text: string, method: string, url: string, status: number): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${method} ${url} returned non-JSON response (status ${status}): ${text.slice(0, 200)}`,
    );
  }
}

export class AtlasClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(opts: AtlasClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.headers = {};
    if (opts.apiKey) {
      this.headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }
  }

  async health(): Promise<ApiResponse<HealthResponse>> {
    return this.get<HealthResponse>("/api/health");
  }

  async query(question: string, opts?: { conversationId?: string }): Promise<ApiResponse<QueryResponse>> {
    return this.post<QueryResponse>("/api/v1/query", {
      question,
      ...(opts?.conversationId && { conversationId: opts.conversationId }),
    });
  }

  async get<T = unknown>(path: string, extraHeaders?: Record<string, string>): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`GET ${url} timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const start = performance.now();

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { ...this.headers, ...extraHeaders },
        signal: controller.signal,
      });
      const text = await res.text();
      const body = parseJsonBody<T>(text, "GET", url, res.status);
      return {
        status: res.status,
        body,
        headers: res.headers,
        durationMs: Math.round(performance.now() - start),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async post<T = unknown>(path: string, payload: unknown, extraHeaders?: Record<string, string>): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`POST ${url} timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const start = performance.now();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers, ...extraHeaders },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      const body = parseJsonBody<T>(text, "POST", url, res.status);
      return {
        status: res.status,
        body,
        headers: res.headers,
        durationMs: Math.round(performance.now() - start),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async delete(path: string, extraHeaders?: Record<string, string>): Promise<ApiResponse> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`DELETE ${url} timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const start = performance.now();

    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: { ...this.headers, ...extraHeaders },
        signal: controller.signal,
      });
      const text = await res.text();
      // DELETE endpoints may return empty or non-JSON responses (e.g., 204 No Content)
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text || null;
      }
      return {
        status: res.status,
        body,
        headers: res.headers,
        durationMs: Math.round(performance.now() - start),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
