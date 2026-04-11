"use client";

import dynamic from "next/dynamic";

const AtlasChat = dynamic(
  () => import("@atlas/web/ui/components/atlas-chat").then((m) => ({ default: m.AtlasChat })),
  { ssr: false },
);

export default function Home() {
  return <AtlasChat />;
}
