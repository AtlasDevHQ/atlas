"use client";

import { useMcpConnect } from "@useatlas/react/hooks";
import { buildConfig, type McpClientConfig, type McpClientId } from "@useatlas/sdk";
import { useState } from "react";

/** Drop the `kind` discriminator so the paste output is clean JSON. */
function stripKind(cfg: McpClientConfig): Record<string, unknown> {
  const { kind: _kind, ...rest } = cfg;
  return rest;
}

const ATLAS_API_URL =
  process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "https://mcp.useatlas.dev";

const MCP_CLIENTS: ReadonlyArray<McpClientId> = [
  "claude-desktop",
  "cursor",
  "continue",
  "chatgpt",
  "generic",
];

/**
 * Worked example — embedders show their own users a "Connect your AI
 * agent" button. The popup OAuth flow lands on `/oauth/callback`,
 * which posts the auth code back to this window. The hook completes
 * the exchange and surfaces the access token + workspace id. We then
 * render `buildConfig` output the user can copy into their MCP client.
 */
export default function Page() {
  const redirectUri =
    typeof window !== "undefined"
      ? `${window.location.origin}/oauth/callback`
      : "http://localhost:3000/oauth/callback";

  const result = useMcpConnect({
    apiUrl: ATLAS_API_URL,
    clientName: "Atlas Embedded Demo",
    redirectUri,
    mode: "popup",
  });
  const { connect, status, reset } = result;

  const [client, setClient] = useState<McpClientId>("claude-desktop");
  // Default-workspace selection (#2196). For single-workspace tokens this
  // is a no-op — the picker is hidden and we use `result.workspaceId`. For
  // multi-workspace tokens (`result.workspaces.length > 1`), the picker
  // lets the user pin a different default before copying the config.
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);

  const effectiveWorkspaceId =
    result.status === "success"
      ? selectedWorkspace ?? result.workspaceId
      : null;

  const config =
    result.status === "success" && effectiveWorkspaceId
      ? buildConfig({
          client,
          apiUrl: ATLAS_API_URL,
          accessToken: result.accessToken,
          workspaceId: effectiveWorkspaceId,
          // Opt into the multi-workspace block when the JWT carries the
          // plural claim. Empty array → single-workspace shape, byte-
          // identical to the legacy block.
          workspaces: result.workspaces,
        })
      : null;

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "64px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <header>
        <h1 style={{ margin: 0, fontSize: 24 }}>Embedded Atlas MCP onboarding</h1>
        <p style={{ color: "#a1a1aa", marginTop: 8 }}>
          Demonstrates <code>useMcpConnect</code> + <code>buildConfig</code>.
        </p>
      </header>

      <section style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={() => void connect()}
          disabled={status === "starting" || status === "awaiting_callback" || status === "exchanging"}
          style={{
            background: status === "success" ? "#10b981" : "#3b82f6",
            color: "#0a0a0a",
            border: "none",
            borderRadius: 8,
            padding: "12px 20px",
            fontSize: 16,
            fontWeight: 600,
            cursor: status === "success" ? "default" : "pointer",
          }}
        >
          {status === "success" ? "✓ Connected" : "Connect your AI agent"}
        </button>

        {status === "success" && (
          <button
            onClick={() => {
              setSelectedWorkspace(null);
              reset();
            }}
            style={{
              background: "transparent",
              color: "#a1a1aa",
              border: "1px solid #333",
              borderRadius: 8,
              padding: "12px 16px",
              cursor: "pointer",
            }}
          >
            Disconnect
          </button>
        )}

        <span style={{ color: "#a1a1aa" }}>
          status: <code>{status}</code>
        </span>
      </section>

      {result.status === "error" && (
        <pre
          style={{
            background: "#1f1f1f",
            border: "1px solid #ef4444",
            borderRadius: 8,
            padding: 16,
            color: "#fca5a5",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {result.error.message}
        </pre>
      )}

      {result.status === "success" && config && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Paste-ready config</h2>
          <p style={{ color: "#a1a1aa", marginTop: 0 }}>
            Default workspace: <code>{effectiveWorkspaceId}</code>
            {result.workspaces.length > 1 && (
              <> · {result.workspaces.length} total</>
            )}
          </p>

          {result.workspaces.length > 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ color: "#a1a1aa", fontSize: 13 }}>
                Pick a default workspace (per-request overrides happen via the{" "}
                <code>X-Atlas-Workspace</code> header):
              </span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {result.workspaces.map((ws) => (
                  <button
                    key={ws}
                    onClick={() => setSelectedWorkspace(ws)}
                    style={{
                      background: ws === effectiveWorkspaceId ? "#10b981" : "transparent",
                      color: ws === effectiveWorkspaceId ? "#0a0a0a" : "#fafafa",
                      border: "1px solid #333",
                      borderRadius: 6,
                      padding: "6px 12px",
                      cursor: "pointer",
                      fontSize: 13,
                      fontFamily: "monospace",
                    }}
                  >
                    {ws}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {MCP_CLIENTS.map((id) => (
              <button
                key={id}
                onClick={() => setClient(id)}
                style={{
                  background: client === id ? "#3b82f6" : "transparent",
                  color: client === id ? "#0a0a0a" : "#fafafa",
                  border: "1px solid #333",
                  borderRadius: 6,
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                {id}
              </button>
            ))}
          </div>

          <pre
            style={{
              background: "#1f1f1f",
              border: "1px solid #333",
              borderRadius: 8,
              padding: 16,
              fontSize: 12,
              overflow: "auto",
            }}
          >
            {JSON.stringify(stripKind(config), null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}
