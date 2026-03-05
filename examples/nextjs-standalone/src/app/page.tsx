"use client";

import { AtlasUIProvider } from "@atlas/web/ui/context";
import { AtlasChat } from "@atlas/web/ui/components/atlas-chat";
import { authClient } from "@/lib/auth/client";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";

export default function Home() {
  return (
    <AtlasUIProvider config={{ apiUrl: API_URL, isCrossOrigin: IS_CROSS_ORIGIN, authClient }}>
      <AtlasChat />
    </AtlasUIProvider>
  );
}
