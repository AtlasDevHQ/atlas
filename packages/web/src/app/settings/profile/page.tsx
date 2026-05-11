"use client";

/**
 * Per-user settings (no admin role required). MFA tiles reuse the shared
 * <MfaPanel /> with /admin/account-security — the underlying endpoints
 * are auth-only, not admin-gated, so a feature added there shows up here
 * for free.
 */

import { authClient } from "@/lib/auth/client";
import { SectionHeading } from "@/ui/components/admin/compact";
import { MfaPanel } from "@/ui/components/admin/security/mfa-panel";
import { IdentitySection } from "@/ui/components/settings/identity-section";
import { PasswordSection } from "@/ui/components/settings/password-section";
import { SessionsSection } from "@/ui/components/settings/sessions-section";

interface SessionUser {
  email: string;
}

export default function ProfilePage() {
  const session = authClient.useSession();
  const user = (session.data?.user ?? null) as SessionUser | null;

  if (!user) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-muted-foreground">Sign in to manage your profile.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Settings
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Identity, password, multi-factor authentication, and active sessions for{" "}
          <span className="font-medium text-foreground">{user.email}</span>.
        </p>
      </header>

      <div className="space-y-10">
        <IdentitySection />

        <PasswordSection />

        <section>
          <SectionHeading
            title="Multi-factor authentication"
            description="Add a second factor — passkey, authenticator app, or both — so a stolen password isn't enough."
          />
          <MfaPanel reauthRedirectTo="/settings/profile" />
        </section>

        <SessionsSection />
      </div>
    </div>
  );
}
