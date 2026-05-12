"use client";

import { Suspense } from "react";

export default function DashboardsLayout({ children }: { children: React.ReactNode }) {
  return <Suspense>{children}</Suspense>;
}
