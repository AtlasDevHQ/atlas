/**
 * Lightweight typed fetch wrapper for Atlas API calls.
 * Centralizes URL construction, header injection, credential handling,
 * and error behavior so callers don't repeat the same 6-line pattern.
 */

export interface AtlasFetchOptions {
  apiUrl: string;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
}

export interface AtlasFetch {
  /** Raw fetch with URL/header/credential wiring but no error handling. */
  raw: (method: string, path: string, body?: unknown) => Promise<Response>;
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  patch: <T>(path: string, body?: unknown) => Promise<T>;
  del: (path: string) => Promise<void>;
}

export function createAtlasFetch(opts: AtlasFetchOptions): AtlasFetch {
  async function raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${opts.apiUrl}${path}`, {
      method,
      headers: {
        ...opts.getHeaders(),
        ...(body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      credentials: opts.getCredentials(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await raw(method, path, body);

    if (!res.ok) {
      console.warn(`fetch ${method} ${path}: HTTP ${res.status}`);
      throw new Error(`Failed to ${method} ${path} (HTTP ${res.status})`);
    }

    // Handle 204 No Content
    if (res.status === 204) return undefined as T;

    return res.json() as Promise<T>;
  }

  return {
    raw,
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
    patch: <T>(path: string, body?: unknown) =>
      request<T>("PATCH", path, body),
    del: (path: string) => request<void>("DELETE", path),
  };
}
