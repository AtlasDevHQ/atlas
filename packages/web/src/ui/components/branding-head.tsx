"use client";

import { useBranding } from "@/ui/hooks/use-branding";

/**
 * Client component that injects dynamic favicon and title from workspace branding.
 * Placed inside <head> won't work in Next.js App Router, so this uses DOM manipulation.
 */
export function BrandingHead() {
  const { branding } = useBranding();

  if (typeof document !== "undefined" && branding) {
    // Dynamic favicon
    if (branding.faviconUrl) {
      let link = document.querySelector<HTMLLinkElement>("link[data-branding-favicon]");
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        link.setAttribute("data-branding-favicon", "");
        document.head.appendChild(link);
      }
      if (link.href !== branding.faviconUrl) {
        link.href = branding.faviconUrl;
      }
    }

    // Dynamic title (replace "Atlas" with custom text)
    if (branding.hideAtlasBranding && branding.logoText) {
      const currentTitle = document.title;
      if (currentTitle.includes("Atlas")) {
        document.title = currentTitle.replace("Atlas", branding.logoText);
      }
    }
  }

  // This component renders nothing — side-effects only
  return null;
}
