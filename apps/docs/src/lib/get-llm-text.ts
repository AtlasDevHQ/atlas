import * as fs from "fs/promises";
import { source } from "./source";
import type { InferPageType } from "fumadocs-core/source";

export async function getLLMText(
  page: InferPageType<typeof source>,
): Promise<string> {
  const filePath = page.absolutePath;
  if (!filePath) {
    throw new Error(
      `No absolutePath for "${page.data.title}" (${page.url})`,
    );
  }

  const raw = await fs.readFile(filePath, "utf-8");
  const content = raw.replace(/^---[\s\S]*?---\n*/, "");

  return `# ${page.data.title} (${page.url})\n\n${content}`;
}
