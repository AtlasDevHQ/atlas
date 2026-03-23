"use client";

import { useEffect } from "react";
import { useBranding } from "@/ui/hooks/use-branding";

/**
 * Client component that dynamically updates the favicon and page title based
 * on workspace branding. Uses direct DOM manipulation because branding data is
 * fetched at runtime (session-dependent) and cannot use Next.js static metadata.
 */
export function BrandingHead() {
  const { branding } = useBranding();

  useEffect(() => {
    if (!branding) return;

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

    // Dynamic title (replace all occurrences of "Atlas" with custom text)
    if (branding.hideAtlasBranding && branding.logoText) {
      const currentTitle = document.title;
      if (currentTitle.includes("Atlas")) {
        document.title = currentTitle.replaceAll("Atlas", branding.logoText);
      }
    }
  }, [branding]);

  return null;
}
