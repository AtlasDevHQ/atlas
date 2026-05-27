"use client";

/**
 * Accept-invitation landing page — the destination of the email link
 * Better Auth's `sendInvitationEmail` callback dispatches.
 *
 * Three states, switched by the session and the result of
 * `authClient.organization.getInvitation`:
 *
 *   1. Unauthenticated      → "Sign in or create an account to continue."
 *      The two CTAs preserve `?invitationId=…` so the post-auth handlers
 *      on /login and /signup route back here.
 *
 *   2. Authenticated as the right user → "Join {orgName} as {role}." The
 *      accept button calls `acceptInvitation`, sets the new org active,
 *      and routes to /.
 *
 *   3. Authenticated as someone else → "Signed in as the wrong account."
 *      Better Auth's `getInvitation` returns 403 `you are not the
 *      recipient`; the panel offers Sign out + retry.
 *
 * Email verification (`requireEmailVerificationOnInvitation: true` in the
 * org plugin config) is enforced on the server. If the session user
 * hasn't verified their email, `acceptInvitation` returns 403 with
 * `EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION`
 * — we surface that as a recovery prompt that points back to /signup
 * (the only place where OTP verification is wired today).
 */

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Database, Mail, AlertTriangle, LogOut } from "lucide-react";
import { authClient, type OrgInvitationDetail } from "@/lib/auth/client";

interface PageProps {
  params: Promise<{ id: string }>;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "unauthenticated" }
  | { kind: "ready"; invitation: OrgInvitationDetail }
  | { kind: "wrong-account"; signedInAs: string; invitedEmail: string | null }
  | { kind: "email-unverified" }
  | { kind: "error"; message: string };

export default function AcceptInvitationPage({ params }: PageProps) {
  const { id: invitationId } = use(params);
  const router = useRouter();
  const session = authClient.useSession();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  useEffect(() => {
    // Better Auth's session hook starts as `isPending: true` for one
    // render. Don't make a decision until the hook resolves to either
    // a session or null.
    if (session.isPending) return;

    if (!session.data?.user) {
      setState({ kind: "unauthenticated" });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await authClient.organization.getInvitation({ query: { id: invitationId } });
        if (cancelled) return;
        if (result.error) {
          // Better Auth returns 403 with code YOU_ARE_NOT_THE_RECIPIENT when
          // the session email differs from the invitation email. Distinguish
          // that from "invitation expired / not found" so the recovery UI
          // can branch.
          const msg = result.error.message ?? "";
          if (msg.toLowerCase().includes("recipient")) {
            setState({
              kind: "wrong-account",
              signedInAs: session.data?.user.email ?? "your current account",
              invitedEmail: null,
            });
          } else {
            setState({ kind: "error", message: msg || "This invitation is no longer valid." });
          }
          return;
        }
        if (!result.data) {
          setState({ kind: "error", message: "Invitation not found." });
          return;
        }
        setState({ kind: "ready", invitation: result.data });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : "Failed to load invitation.",
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [invitationId, session.isPending, session.data?.user]);

  async function handleAccept() {
    setAcceptError(null);
    setAccepting(true);
    try {
      const result = await authClient.organization.acceptInvitation({ invitationId });
      if (result.error) {
        const msg = result.error.message ?? "";
        if (msg.toLowerCase().includes("email verification") || msg.toLowerCase().includes("verify")) {
          setState({ kind: "email-unverified" });
          return;
        }
        setAcceptError(msg || "Failed to accept invitation.");
        return;
      }
      if (result.data?.member?.organizationId) {
        // Pin the new workspace as active so the user lands inside it.
        await authClient.organization.setActive({ organizationId: result.data.member.organizationId })
          .catch(() => { /* non-fatal — server-side hook stamps activeOrganizationId on next session refresh */ });
      }
      router.push("/");
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : "Failed to accept invitation.");
    } finally {
      setAccepting(false);
    }
  }

  async function handleSignOut() {
    try {
      await authClient.signOut();
    } finally {
      // Routing through window.location ensures the layout-level session
      // observer re-evaluates and the unauthenticated branch renders.
      window.location.href = `/login?invitationId=${invitationId}`;
    }
  }

  if (state.kind === "loading") {
    return (
      <Card>
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Database className="size-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl tracking-tight">Loading invitation…</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  if (state.kind === "unauthenticated") {
    return (
      <Card>
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Mail className="size-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl tracking-tight">Accept your invitation</CardTitle>
          <CardDescription>
            Sign in or create an account to join the workspace you were invited to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            className="w-full"
            onClick={() => router.push(`/signup?invitationId=${invitationId}`)}
          >
            Create account
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => router.push(`/login?invitationId=${invitationId}`)}
          >
            Sign in to an existing account
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "wrong-account") {
    return (
      <Card>
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
            <AlertTriangle className="size-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl tracking-tight">Wrong account</CardTitle>
          <CardDescription>
            You're signed in as <strong>{state.signedInAs}</strong>, but this invitation was sent to a different email. Sign out and use the address the invitation was sent to.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={handleSignOut}>
            <LogOut className="mr-2 size-4" />
            Sign out and try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "email-unverified") {
    return (
      <Card>
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
            <Mail className="size-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl tracking-tight">Verify your email first</CardTitle>
          <CardDescription>
            You need to verify your email before you can join a workspace. Check your inbox for the verification code, or request a new one from your account settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={() => router.push("/settings/profile")}>
            Go to account settings
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl tracking-tight">Invitation unavailable</CardTitle>
          <CardDescription>{state.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={() => router.push("/")}>
            Go home
          </Button>
        </CardContent>
      </Card>
    );
  }

  // state.kind === "ready"
  const { invitation } = state;
  return (
    <Card>
      <CardHeader className="space-y-3 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Database className="size-6" aria-hidden="true" />
        </div>
        <CardTitle className="text-2xl tracking-tight">Join {invitation.organizationName}</CardTitle>
        <CardDescription>
          {invitation.inviterEmail} invited you to join <strong>{invitation.organizationName}</strong> as <strong>{invitation.role}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {acceptError && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t accept</AlertTitle>
            <AlertDescription>{acceptError}</AlertDescription>
          </Alert>
        )}
        <Button className="w-full" onClick={handleAccept} disabled={accepting}>
          {accepting ? "Joining…" : `Join ${invitation.organizationName}`}
        </Button>
      </CardContent>
    </Card>
  );
}
