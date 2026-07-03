import type { SectionPage } from "@/lib/source";
import type { Audience } from "@/lib/audience";
import { stripInactiveAudienceBlocks } from "@/lib/audience-markdown";

// Accepts a page from EITHER human section (`SectionPage` — the shared
// frontmatter-schema union), so the root/SaaS and `/self-hosted` machine
// surfaces both render through this one path (PRD #4257, slice #4266).
export async function getLLMText(
  page: SectionPage,
  audience: Audience,
): Promise<string> {
  const processed = await page.data.getText("processed");
  // Resolve `<WhenSaaS>` / `<WhenSelfHosted>` for this surface's audience so the
  // markdown twin / llms-full.txt never carry the other audience's branch — the
  // same isolation the HTML conditionals enforce (PRD #4257).
  const scoped = stripInactiveAudienceBlocks(processed, audience);

  return `# ${page.data.title} (${page.url})\n\n${scoped}`;
}
