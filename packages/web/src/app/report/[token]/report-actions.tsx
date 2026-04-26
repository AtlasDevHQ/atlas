"use client";

import { useState } from "react";
import { Check, Link2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Header chrome action group for the shared report — Print + Copy link.
 * Both are public-viewer affordances; both are `print:hidden` so they don't
 * appear in the printed PDF or the OG card.
 *
 * Print uses `window.print()` because that's what the issue asks for: an MVP
 * "Download PDF" path that lives in the browser without a server-side
 * pipeline. Copy link reads `window.location.href` to avoid prop-drilling the
 * token through the server tree.
 */
export function ReportActions() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (typeof window === "undefined") return;
    const url = window.location.href;
    // navigator.clipboard is HTTPS-only in some browsers — fall back so
    // self-hosted HTTP deployments still get a working button.
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      // `execCommand("copy")` returns `false` (without throwing) when the
      // browser silently denies copy — sandboxed iframes, document-not-
      // focused, certain Safari WebView states. Treating reach-of-finally
      // as success would show the green "Copied" affordance with nothing
      // in the clipboard.
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        console.warn(
          "[report-actions] copy fallback threw:",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        document.body.removeChild(ta);
      }
      if (!ok) {
        console.warn("[report-actions] document.execCommand('copy') returned false");
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(url)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        })
        .catch((err: unknown) => {
          console.warn("[report-actions] clipboard.writeText failed, falling back:", err instanceof Error ? err.message : err);
          fallback();
        });
    } else {
      fallback();
    }
  }

  return (
    <div className="flex items-center gap-2 print:hidden">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={handleCopy}
        aria-label={copied ? "Link copied" : "Copy link to this report"}
      >
        {copied ? (
          <>
            <Check className="size-3.5" aria-hidden="true" />
            Copied
          </>
        ) : (
          <>
            <Link2 className="size-3.5" aria-hidden="true" />
            Copy link
          </>
        )}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => {
          if (typeof window !== "undefined") window.print();
        }}
        aria-label="Save this report as a PDF"
      >
        <Printer className="size-3.5" aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Save as PDF</span>
      </Button>
    </div>
  );
}
