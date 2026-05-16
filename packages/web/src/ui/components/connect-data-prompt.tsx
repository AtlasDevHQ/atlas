"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyAskHero } from "./empty-ask-hero";

interface ConnectDataPromptProps {
  /** When true, render the admin CTA button; otherwise render explanatory copy. */
  isAdmin: boolean;
}

export function ConnectDataPrompt({ isAdmin }: ConnectDataPromptProps) {
  return (
    <EmptyAskHero
      heading="Connect data to get started"
      subhead="Atlas needs a database connection or our demo dataset before it can answer questions."
    >
      {isAdmin ? (
        <Button asChild>
          <Link href="/signup/connect">Set up a connection</Link>
        </Button>
      ) : (
        <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
          Ask your workspace admin to connect a database — once it's set up, you&apos;ll be able to ask questions here.
        </p>
      )}
    </EmptyAskHero>
  );
}
