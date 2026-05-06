"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth/client";

/**
 * Resend the verification email for a given address.
 *
 * Used by both the login-page EMAIL_NOT_VERIFIED alert (callback `/login`)
 * and the signup-page "check your email" interstitial (callback
 * `/signup/workspace`). The 30s local cooldown is UX, not a security
 * control — the `/send-verification-email` endpoint is rate-limited
 * server-side.
 */
export function ResendVerificationButton({
  email,
  callbackURL,
}: {
  email: string;
  callbackURL: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleClick() {
    if (state === "sending") return;
    setState("sending");
    setErrorMsg(null);
    try {
      // The cast is the documented workaround for Better Auth's
      // plugin-augmented client type — `sendVerificationEmail` is a base
      // action but TS6 strictness loses it through the plugin chain.
      const send = (
        authClient as unknown as {
          sendVerificationEmail?: (opts: { email: string; callbackURL?: string }) => Promise<{
            data: unknown;
            error: { message?: string } | null;
          }>;
        }
      ).sendVerificationEmail;
      if (typeof send !== "function") {
        throw new Error("sendVerificationEmail action not available on this client");
      }
      const result = await send({ email, callbackURL });
      if (result.error) {
        setErrorMsg(result.error.message ?? "Could not send the email. Please try again.");
        setState("error");
        return;
      }
      setState("sent");
    } catch (err) {
      console.warn(
        "[auth] sendVerificationEmail threw",
        err instanceof Error ? err.message : String(err),
      );
      setErrorMsg("Could not send the email. Please try again.");
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        Sent — check your inbox (and spam folder).
      </p>
    );
  }

  return (
    <div className="mt-1 space-y-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === "sending" || !email}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "sending" ? (
          <>
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Sending…
          </>
        ) : (
          "Resend verification email"
        )}
      </button>
      {state === "error" && errorMsg && (
        <p className="text-xs text-red-800/90 dark:text-red-200/90">{errorMsg}</p>
      )}
    </div>
  );
}
