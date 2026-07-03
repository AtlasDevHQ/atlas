import type { InferPageType } from "fumadocs-core/source";
import type { source } from "@/lib/source";
import type { Audience } from "@/lib/audience";
import { stripInactiveAudienceBlocks } from "@/lib/audience-markdown";

export async function getLLMText(
  page: InferPageType<typeof source>,
  audience: Audience,
): Promise<string> {
  const processed = await page.data.getText("processed");
  // Resolve `<WhenSaaS>` / `<WhenSelfHosted>` for this surface's audience so the
  // markdown twin / llms-full.txt never carry the other audience's branch — the
  // same isolation the HTML conditionals enforce (PRD #4257).
  const scoped = stripInactiveAudienceBlocks(processed, audience);

  return `# ${page.data.title} (${page.url})\n\n${scoped}`;
}
