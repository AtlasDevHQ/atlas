import * as fs from "fs";
import * as path from "path";
import { source } from "./source";
import type { InferPageType } from "fumadocs-core/source";

export function getLLMText(page: InferPageType<typeof source>): string {
  // page.path is relative to content dir, e.g. "docs/page.mdx"
  // page.absolutePath is the absolute path when available
  const filePath = page.absolutePath
    ?? path.join(process.cwd(), "content", page.path);
  const raw = fs.readFileSync(filePath, "utf-8");
  const content = raw.replace(/^---[\s\S]*?---\n*/, "");

  return `# ${page.data.title} (${page.url})\n\n${content}`;
}
