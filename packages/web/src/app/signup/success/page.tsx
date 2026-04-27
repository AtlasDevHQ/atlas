"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowRight, BookOpen, MessageSquare, Settings, Users } from "lucide-react";
import { SignupShell } from "@/ui/components/signup/signup-shell";

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
    href: "/admin/organizations",
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

const STARTER_PROMPTS = [
  "What are our top 10 customers by revenue this quarter?",
  "Which products had the biggest week-over-week drop?",
  "Show me churn risk by plan tier.",
];

export default function SuccessPage() {
  const router = useRouter();

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
          <section aria-labelledby="prompts-heading" className="space-y-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="size-4 text-primary" aria-hidden="true" />
              <h2 id="prompts-heading" className="text-sm font-semibold">
                Try starting with one of these
              </h2>
            </div>
            <ul className="space-y-2">
              {STARTER_PROMPTS.map((prompt) => (
                <li key={prompt}>
                  <button
                    type="button"
                    onClick={() => router.push(`/?prompt=${encodeURIComponent(prompt)}`)}
                    className="group flex w-full items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span>{prompt}</span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <Button size="lg" className="w-full" onClick={() => router.push("/")}>
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
