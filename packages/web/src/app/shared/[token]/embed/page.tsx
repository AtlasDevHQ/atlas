// server-only — `Date.now()` and theme resolution must run server-side so SSR
// matches the rendered output. The `<Markdown>` component imported by view.tsx
// is the only client island.
import { fetchSharedConversation } from "../../lib";
import { EmbedView, EmbedErrorView, resolveEmbedTheme } from "./view";

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ theme?: string | string[] }>;
}

export default async function SharedConversationEmbedPage({
  params,
  searchParams,
}: PageProps) {
  const { token } = await params;
  const { theme: themeParam } = await searchParams;
  const theme = resolveEmbedTheme(themeParam);

  const result = await fetchSharedConversation(token);
  if (!result.ok) {
    return <EmbedErrorView reason={result.reason} theme={theme} />;
  }
  return <EmbedView data={result.data} theme={theme} />;
}
