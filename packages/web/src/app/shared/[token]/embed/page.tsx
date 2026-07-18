import { fetchSharedConversation } from "../fetch";
import { isAuthWallReason } from "../share-result";
import { OrgShareResolver } from "../org-share-resolver";
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
    // Same client-side org-share hand-off as the standalone page (#4719,
    // adopting #4718). Scope caveat: the session cookie is host-only AND
    // SameSite=Lax (ADR-0024, Decision), so the credentialed retry only helps when
    // the embed is framed same-site (e.g. inside Atlas itself). In a
    // third-party iframe the browser withholds the cookie and the resolver
    // lands on the same navigation-free auth copy as before — the intended
    // terminal state for an org share on a foreign page, not a bug.
    if (isAuthWallReason(result.reason)) {
      return <OrgShareResolver token={token} variant="embed" theme={theme} />;
    }
    return <EmbedErrorView reason={result.reason} theme={theme} />;
  }
  return <EmbedView data={result.data} theme={theme} />;
}
