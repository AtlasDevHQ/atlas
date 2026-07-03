// RFC 9728 — OAuth Protected Resource Metadata. Atlas API uses bearer
// API keys (issued at app.useatlas.dev/admin/api-keys) plus Better Auth
// sessions; the resource server is api.useatlas.dev.
//
// The body is NOT defined here — it's imported from a generated artifact so
// this route and the apex mirror (`useatlas.dev/.well-known/oauth-protected-
// resource`) serve byte-identical metadata. Regenerate with
// `cd packages/api && bun scripts/generate-apex-discovery.ts`; a CI drift gate
// (scripts/check-apex-discovery-drift.sh) fails if the generated JSON is
// edited by hand (it guards the artifact, not this route file).
import BODY from "./resource-metadata.generated.json";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(JSON.stringify(BODY, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
