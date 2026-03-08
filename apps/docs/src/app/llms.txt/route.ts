import { source } from "@/lib/source";
import { llms } from "fumadocs-core/source";

const BASE_URL = "https://docs.useatlas.dev";

export const revalidate = false;

export function GET() {
  const content = llms(source).index();
  // Convert relative URLs to absolute for LLM agent consumption
  const withAbsoluteUrls = content.replace(
    /\]\(\//g,
    `](${BASE_URL}/`,
  );

  return new Response(withAbsoluteUrls, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
