import { defineConfig } from "tsup";

export default defineConfig([
  // Library build — peer deps externalized for host-app bundlers
  {
    entry: { index: "src/index.ts", hooks: "src/hooks/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@ai-sdk/react",
      "ai",
      "lucide-react",
      "recharts",
      "react-syntax-highlighter",
      "react-syntax-highlighter/dist/esm/styles/prism",
      "xlsx",
    ],
    treeshake: true,
    splitting: true,
  },
  // Widget bundle — self-contained ESM with all runtime deps bundled.
  // Only react-syntax-highlighter and xlsx are external (dynamically
  // imported; they degrade gracefully if unavailable in the widget).
  {
    entry: { widget: "src/widget-entry.ts" },
    format: ["esm"],
    noExternal: [/.*/],
    platform: "browser",
    minify: true,
    treeshake: true,
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
    external: [
      "react-syntax-highlighter",
      "react-syntax-highlighter/dist/esm/styles/prism",
      "xlsx",
    ],
  },
]);
