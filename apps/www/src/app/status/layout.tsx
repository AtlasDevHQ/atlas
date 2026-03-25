import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "System Status — Atlas",
  description:
    "Real-time status of Atlas services. Check API, web app, documentation, and infrastructure health.",
  openGraph: {
    title: "System Status — Atlas",
    description:
      "Real-time status of Atlas services. Check API, web app, documentation, and infrastructure health.",
    url: "https://useatlas.dev/status",
    siteName: "Atlas",
    type: "website",
  },
};

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return children;
}
