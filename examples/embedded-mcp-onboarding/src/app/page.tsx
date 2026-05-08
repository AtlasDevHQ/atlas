"use client";

import { useMcpConnect } from "@useatlas/react/hooks";
import { buildConfig } from "@useatlas/sdk";
import { useState } from "react";

const ATLAS_API_URL =
  process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "https://mcp.useatlas.dev";

/**
 * Worked example for #2079 — embedders show their own users a
 * "Connect your AI agent" button. The popup OAuth flow lands on
 * `/oauth/callback`, which posts the auth code back to this window.
 * The hook completes the exchange and surfaces `accessToken` +
 * `workspaceId`. We then render `buildConfig` output the user can
 * copy into Claude Desktop / Cursor / Continue.
 */
export default function Page() {
  const redirectUri =
    typeof window !== "undefined"
      ? `${window.location.origin}/oauth/callback`
      : "http://localhost:3000/oauth/callback";

  const { connect, status, error, accessToken, workspaceId, reset } = useMcpConnect({
    apiUrl: ATLAS_API_URL,
    clientName: "Atlas Embedded Demo",
    redirectUri,
    mode: "popup",
  });

  const [client, setClient] = useState<"claude-desktop" | "cursor" | "continue" | "chatgpt" | "generic">(
    "claude-desktop",
  );

  const config =
    accessToken && workspaceId
      ? buildConfig({ client, apiUrl: ATLAS_API_URL, accessToken, workspaceId })
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
            onClick={reset}
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

      {error && (
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
          {error.message}
        </pre>
      )}

      {accessToken && workspaceId && config && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Paste-ready config</h2>
          <p style={{ color: "#a1a1aa", marginTop: 0 }}>
            Workspace ID: <code>{workspaceId}</code>
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["claude-desktop", "cursor", "continue", "chatgpt", "generic"] as const).map((id) => (
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
            {JSON.stringify(config, null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}
