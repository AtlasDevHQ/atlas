/**
 * Best-effort host extraction for install-log breadcrumbs — never
 * throws, never leaks the URL's path/query/userinfo into logs. One
 * definition for every install handler (Webhook / Obsidian / Twenty /
 * the OpenAPI core) so a change to the redaction policy lands once.
 */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // intentionally ignored: log breadcrumb only — the URL was already
    // validated by the caller's Zod refine, so reaching this branch
    // implies a malformed log entry, not malformed user input.
    return "<unparseable>";
  }
}
