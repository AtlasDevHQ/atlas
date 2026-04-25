// RFC 9728 — OAuth Protected Resource Metadata. Atlas API uses bearer
// API keys (issued at app.useatlas.dev/admin/api-keys) plus Better Auth
// sessions; the resource server is api.useatlas.dev.
export const dynamic = "force-static";

const BODY = {
  resource: "https://api.useatlas.dev",
  authorization_servers: ["https://api.useatlas.dev"],
  bearer_methods_supported: ["header"],
  resource_documentation: "https://docs.useatlas.dev/api-reference",
  resource_name: "Atlas API",
  resource_policy_uri: "https://www.useatlas.dev/privacy",
  resource_tos_uri: "https://www.useatlas.dev/terms",
} as const;

export function GET(): Response {
  return new Response(JSON.stringify(BODY, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
