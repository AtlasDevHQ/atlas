"use client";

import dynamic from "next/dynamic";
import { AtlasChat } from "@useatlas/react";
import { authClient } from "@/lib/auth/client";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";
import { NavBar } from "@/ui/components/tour/nav-bar";
import { IncidentBanner } from "@/ui/components/incident-banner";

const OPENSTATUS_SLUG = process.env.NEXT_PUBLIC_OPENSTATUS_SLUG;
const STATUS_URL = process.env.NEXT_PUBLIC_STATUS_URL;

const GuidedTour = dynamic(
  () => import("@/ui/components/tour/guided-tour").then((m) => m.GuidedTour),
  { ssr: false },
);

export default function Home() {
  const session = authClient.useSession();
  const user = session.data?.user as
    | { email?: string; role?: string }
    | undefined;
  // User-level role check for nav bar display only — actual admin access
  // is gated by the backend (which resolves org member roles too).
  const isAdmin = user?.role === "admin" || user?.role === "owner" || user?.role === "platform_admin";
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
        <IncidentBanner slug={OPENSTATUS_SLUG} statusUrl={STATUS_URL} />
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
