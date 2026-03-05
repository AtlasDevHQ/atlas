"use client";

/**
 * Catches errors thrown in the root layout.
 * Must provide its own <html> and <body> tags since the layout itself may have failed.
 * Uses inline styles because Tailwind CSS may not load if the layout errored.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          backgroundColor: "#09090b",
          color: "#f4f4f5",
          fontFamily: "system-ui, sans-serif",
          padding: "1rem",
        }}
      >
        <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>
          Something went wrong
        </h2>
        <p
          style={{
            maxWidth: "28rem",
            textAlign: "center",
            fontSize: "0.875rem",
            color: "#a1a1aa",
          }}
        >
          {error.message || "An unexpected error occurred."}
        </p>
        {error.digest && (
          <p style={{ fontSize: "0.75rem", color: "#71717a" }}>
            Reference: {error.digest}
          </p>
        )}
        <button
          onClick={reset}
          style={{
            borderRadius: "0.5rem",
            backgroundColor: "#2563eb",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            color: "white",
            border: "none",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
