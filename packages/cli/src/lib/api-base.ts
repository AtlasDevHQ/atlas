/**
 * Resolve the Atlas API base URL the CLI talks to. Mirrors the inline default
 * used by `atlas query` (`ATLAS_API_URL`, default local dev API), centralized
 * so `login` / `logout` / `entities` and the credential store key all agree on
 * one normalized base. (#4043 / ADR-0026.)
 */
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ATLAS_API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}
