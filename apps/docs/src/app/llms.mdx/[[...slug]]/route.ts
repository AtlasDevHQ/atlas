import { source } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";
import { notFound } from "next/navigation";

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const content = await getLLMText(page);
  // Rough token estimate — most tokenizers land around 3.5–4 chars/token
  // for English markdown. Surfaced so agents can budget context windows
  // without re-tokenizing the body.
  const tokenEstimate = Math.ceil(content.length / 4);
  return new Response(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Markdown-Tokens": String(tokenEstimate),
      "X-Markdown-Source": page.url,
    },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
