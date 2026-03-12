"use client";

import { AtlasChat } from "@useatlas/react";
import { authClient } from "@/lib/auth/client";
import { API_URL } from "@/lib/api-url";

export default function Home() {
  return (
    <AtlasChat
      apiUrl={API_URL}
      sidebar
      schemaExplorer
      authClient={authClient}
    />
  );
}
