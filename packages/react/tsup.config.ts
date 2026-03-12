import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
});
