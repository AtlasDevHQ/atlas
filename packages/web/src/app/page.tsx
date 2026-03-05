"use client";

import { AtlasUIProvider } from "@/ui/context";
import { AtlasChat } from "@/ui/components/atlas-chat";
import { authClient } from "@/lib/auth/client";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";

export default function Home() {
  return (
    <AtlasUIProvider config={{ apiUrl: API_URL, isCrossOrigin: IS_CROSS_ORIGIN, authClient }}>
      <AtlasChat />
    </AtlasUIProvider>
  );
}
