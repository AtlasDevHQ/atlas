"use client";

import { Suspense, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { authClient } from "@/lib/auth/client";
import { useAtlasTransport } from "@/ui/hooks/use-atlas-transport";
import { useDatasourceSummary } from "@/ui/hooks/use-datasource-summary";
import { useDefaultLanding } from "@/ui/hooks/use-default-landing";
import { useIsAdmin } from "@/ui/hooks/use-platform-admin-guard";
import { IncidentBanner } from "@/ui/components/incident-banner";
import { ConnectDataPrompt } from "@/ui/components/connect-data-prompt";
import { AtlasChat } from "@/ui/components/atlas-chat";
import { Button } from "@/components/ui/button";

const OPENSTATUS_SLUG = process.env.NEXT_PUBLIC_OPENSTATUS_SLUG;
const STATUS_URL = process.env.NEXT_PUBLIC_STATUS_URL;

const GuidedTour = dynamic(
  () => import("@/ui/components/tour/guided-tour").then((m) => m.GuidedTour),
  { ssr: false },
);

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-zinc-500">Loading...</p>
        </div>
      }
    >
      <ChatPage />
    </Suspense>
  );
}

// The hosted SaaS workspace chat is a THIN wrapper around the single canonical
// web chat `<AtlasChat>` (#3081). Before #3081 this page carried its own inline
// chat implementation that drifted from the embeddable component and never
// gained Conversation REST scope; now it renders `<AtlasChat embedded>` and adds
// only the hosted-only chrome: the incident banner, the guided tour, the admin
// landing redirect, and the zero-table "connect data" gate. The persistent
// `WorkspaceShell` (shared across /, /notebook, /dashboards) owns the
// conversation rail, schema explorer, prompt library, and command palette;
// `embedded` mode suppresses `<AtlasChat>`'s own copies of those.
function ChatPage() {
  const router = useRouter();
  const session = authClient.useSession();
  const isAdmin = useIsAdmin();
  const isSignedIn = !!session.data?.user;

  // Admin landing opt-out: an admin whose default landing is the console is
  // redirected off the chat. Route control stays in the page (the shared chat
  // component is not a router). Wait for the session so a 401 doesn't fall
  // through to chat and silently skip the redirect on first paint.
  const { defaultLanding, loading: landingLoading } = useDefaultLanding(
    isSignedIn && !session.isPending,
  );
  const redirectingToAdmin = isAdmin && defaultLanding === "admin";
  useEffect(() => {
    if (landingLoading) return;
    if (!redirectingToAdmin) return;
    router.replace("/admin");
  }, [landingLoading, redirectingToAdmin, router]);

  // Minimal transport to feed the datasource summary (headers + auth gate) and
  // to surface a hard health failure before we render a dead-looking chat. The
  // WorkspaceShell mounts its own transport too, but the `/api/health` probe is
  // deduped by a module-level cache inside `useAtlasTransport` (`_cachedAuthMode`),
  // so the second instance reuses the first probe and is cheap. `<AtlasChat>`
  // owns its own transport for the chat itself.
  const { getHeaders, authResolved, healthWarning } = useAtlasTransport({
    apiUrl: getApiUrl(),
    isCrossOrigin: isCrossOrigin(),
    getConversationId: () => null,
    onNewConversationId: () => undefined,
  });

  // Gate the chat on a connected datasource: a zero-table workspace shows the
  // connect-data prompt (and `<AtlasChat>` hides the composer) so the user sets
  // up data before the agent runs and fails confusingly downstream.
  const datasource = useDatasourceSummary({
    apiUrl: getApiUrl(),
    isCrossOrigin: isCrossOrigin(),
    getHeaders,
    enabled: authResolved && isSignedIn,
  });
  const needsDataSetup = datasource.data?.tableCount === 0;

  // A failed `/api/health` probe means the API is unreachable / misconfigured.
  // Surface the actionable error + a Retry instead of rendering an
  // apparently-working chat wired to a dead backend — in `embedded` mode
  // `<AtlasChat>` only renders `healthWarning` as a faint inline hint, far too
  // subtle for a hard failure. Restores the pre-#3081 inline page's health gate.
  if (healthWarning) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{healthWarning}</p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Suppress the chat during the one-frame window between the preference fetch
  // resolving as `admin` and the router landing on /admin (avoids a flash of
  // the chat surface before the redirect commits).
  if (redirectingToAdmin) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-500">Loading admin console...</p>
      </div>
    );
  }

  return (
    <GuidedTour
      apiUrl={getApiUrl()}
      isCrossOrigin={isCrossOrigin()}
      isAdmin={isAdmin}
      serverTrackingEnabled={isSignedIn}
    >
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <IncidentBanner slug={OPENSTATUS_SLUG} statusUrl={STATUS_URL} />
        <AtlasChat
          embedded
          needsDataSetup={needsDataSetup}
          emptyStateOverride={<ConnectDataPrompt isAdmin={isAdmin} />}
        />
      </div>
    </GuidedTour>
  );
}
