"use client";

import dynamic from "next/dynamic";
import { AtlasChat } from "@useatlas/react";
import { authClient } from "@/lib/auth/client";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";
import { NavBar } from "@/ui/components/tour/nav-bar";

const GuidedTour = dynamic(
  () => import("@/ui/components/tour/guided-tour").then((m) => m.GuidedTour),
  { ssr: false },
);

const ADMIN_ROLES = new Set(["admin", "owner", "platform_admin"]);

export default function Home() {
  const session = authClient.useSession();
  const activeMember = authClient.organization.activeMember();
  const user = session.data?.user as
    | { email?: string; role?: string }
    | undefined;
  const orgRole = (activeMember.data as Record<string, unknown> | undefined)?.role;
  const isAdmin = ADMIN_ROLES.has(user?.role ?? "") || ADMIN_ROLES.has(String(orgRole ?? ""));
  const isSignedIn = !!user;

  // Server tracking requires managed auth (signed-in user)
  const serverTrackingEnabled = isSignedIn;

  return (
    <GuidedTour
      apiUrl={API_URL}
      isCrossOrigin={IS_CROSS_ORIGIN}
      isAdmin={isAdmin}
      serverTrackingEnabled={serverTrackingEnabled}
    >
      <div className="flex h-dvh flex-col">
        <NavBar isAdmin={isAdmin} />
        {/* Override AtlasChat's h-dvh so it fills remaining space below the NavBar */}
        <div className="flex-1 overflow-hidden [&_.atlas-root]:h-full">
          <AtlasChat
            apiUrl={API_URL}
            sidebar
            schemaExplorer
            authClient={authClient}
          />
        </div>
      </div>
    </GuidedTour>
  );
}
