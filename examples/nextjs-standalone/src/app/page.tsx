"use client";

import dynamic from "next/dynamic";
import { AtlasUIProvider } from "@atlas/web/ui/context";
import { authClient } from "@/lib/auth/client";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";

const AtlasChat = dynamic(
  () => import("@atlas/web/ui/components/atlas-chat").then((m) => ({ default: m.AtlasChat })),
  { ssr: false },
);

export default function Home() {
  return (
    <AtlasUIProvider config={{ apiUrl: API_URL, isCrossOrigin: IS_CROSS_ORIGIN, authClient }}>
      <AtlasChat />
    </AtlasUIProvider>
  );
}
