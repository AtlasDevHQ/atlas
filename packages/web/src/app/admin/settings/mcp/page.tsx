import { redirect } from "next/navigation";

/**
 * MCP settings folded into the main settings page (consolidation, May 2026).
 * The single MCP knob (`ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS`) renders in the
 * "MCP" section of `/admin/settings` alongside the rest of the workspace
 * settings. Old `/admin/settings/mcp` URL preserved as a redirect for any
 * bookmarks / docs that still link to it.
 */
export default function McpSettingsRedirect() {
  redirect("/admin/settings#setting-ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS");
}
