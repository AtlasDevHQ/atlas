/** Auto-served by Next.js at /shared/[token]/opengraph-image — generates the OG preview card. */
import { ImageResponse } from "next/og";

export const alt = "Atlas — Shared Conversation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          background: "linear-gradient(145deg, #09090b 0%, #18181b 50%, #27272a 100%)",
          color: "white",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            marginBottom: "24px",
          }}
        >
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "14px",
              background: "linear-gradient(135deg, #0d9488, #0f766e)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "28px",
              fontWeight: 700,
            }}
          >
            A
          </div>
          <span style={{ fontSize: "56px", fontWeight: 700, letterSpacing: "-1px" }}>
            Atlas
          </span>
        </div>
        <div style={{ fontSize: "24px", color: "#a1a1aa" }}>
          Shared Conversation
        </div>
      </div>
    ),
    { ...size },
  );
}
