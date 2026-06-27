"use client";

import { authClient } from "@/lib/auth/client";
import { navigatePostAuth } from "@/lib/auth/post-auth-nav";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowRight, BookOpen, Clock, MessageSquare, Settings, Users } from "lucide-react";
import { SignupShell } from "@/ui/components/signup/signup-shell";
import { useTrialStatus } from "@/ui/hooks/use-trial-status";
import { useSuccessStarterPrompts } from "@/ui/hooks/use-success-starter-prompts";
import { formatDate } from "@/lib/format";

interface NextStepDef {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  external?: boolean;
}

const NEXT_STEPS: NextStepDef[] = [
  {
    href: "/admin/semantic",
    icon: Settings,
    title: "Refine your semantic layer",
    description: "Add joins, measures, and descriptions so the agent gets answers right the first time.",
  },
  {
    href: "/platform/organizations",
    icon: Users,
    title: "Invite your team",
    description: "Share workspaces with teammates and decide who can connect databases.",
  },
  {
    href: "https://docs.useatlas.dev/getting-started",
    icon: BookOpen,
    title: "Read the quickstart",
    description: "Five minutes on prompts, semantic tuning, and how the agent reasons over your schema.",
    external: true,
  },
];

export default function SuccessPage() {
  // Starter prompts derive from the connected workspace's semantic layer via
  // the same adaptive resolver the in-chat empty state uses (#3935 §F4), with
  // a shared static fallback for a cold-start / not-yet-ready semantic layer.
  const { prompts: starterPrompts } = useSuccessStarterPrompts();

  // #2487: hydrate the Better Auth session store before navigating to a
  // guarded route. Without this, AuthGuard can read the pre-signup `null`
  // snapshot and bounce the user back to /login.
  //
  // #4018: hand off to the app with a HARD nav (`navigatePostAuth`), matching
  // the login front-door — this is the canonical "auth state just changed →
  // guarded route" boundary the helper exists for. A soft `router.push` keeps
  // the funnel's SPA client (and its session snapshot) alive across the
  // boundary; a full reload re-bootstraps the app cleanly from the durable
  // cookie instead of a carried-over store.
  async function openAtlas(destination: string) {
    try {
      await authClient.getSession();
    } catch (err) {
      console.warn(
        "[signup/success] getSession before navigate failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    navigatePostAuth(destination);
  }

  return (
    <SignupShell step="done" width="wide">
      <Card>
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl tracking-tight">You&apos;re all set</CardTitle>
          <CardDescription>
            Your workspace is ready. Ask a question to get started — Atlas will explore the
            schema, write SQL, and explain the result.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <TrialNotice />

          <section aria-labelledby="prompts-heading" className="space-y-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="size-4 text-primary" aria-hidden="true" />
              <h2 id="prompts-heading" className="text-sm font-semibold">
                Try starting with one of these
              </h2>
            </div>
            <ul className="space-y-2">
              {starterPrompts.map((prompt) => (
                <li key={prompt}>
                  <button
                    type="button"
                    onClick={() => openAtlas(`/?prompt=${encodeURIComponent(prompt)}`)}
                    className="group flex w-full items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span>{prompt}</span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <Button size="lg" className="w-full" onClick={() => openAtlas("/")}>
            Open Atlas
          </Button>

          <section aria-labelledby="next-heading" className="space-y-3 border-t pt-6">
            <h2 id="next-heading" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              When you&apos;re ready, also consider
            </h2>
            <ul className="grid gap-2 sm:grid-cols-3">
              {NEXT_STEPS.map((step) => (
                <li key={step.title}>
                  <NextStepCard {...step} />
                </li>
              ))}
            </ul>
          </section>
        </CardContent>
      </Card>
    </SignupShell>
  );
}

/**
 * Trial honesty at signup completion (#3434): the pricing page promised a
 * "14-day free trial", so the moment the workspace exists we say when it
 * started and when it ends — instead of the clock first surfacing as an
 * admin-only banner (or, for members, a hard 403 at expiry).
 *
 * Renders nothing while loading, off-trial, and on self-hosted deploys
 * (where /api/v1/trial answers `trial: null`).
 */
function TrialNotice() {
  const { trial, loading } = useTrialStatus();
  if (loading || !trial) return null;

  return (
    <div
      role="status"
      data-testid="signup-trial-notice"
      className="flex items-start gap-3 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-left"
    >
      <Clock className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
      <div className="space-y-0.5 text-sm">
        <p className="font-medium">
          Your {trial.trialDays}-day free trial started {formatDate(trial.startedAt)}.
        </p>
        <p className="text-xs text-muted-foreground">
          Full access until {formatDate(trial.endsAt)} — no charges until you pick a plan.
          Workspace admins can upgrade anytime in Admin → Billing.
        </p>
      </div>
    </div>
  );
}

function NextStepCard({ href, icon: Icon, title, description, external }: NextStepDef) {
  const linkProps = external
    ? { target: "_blank" as const, rel: "noopener noreferrer" as const }
    : {};
  return (
    <a
      href={href}
      {...linkProps}
      className="flex h-full flex-col gap-1.5 rounded-md border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </a>
  );
}
