"use client";

import type { ReactNode } from "react";

interface EmptyAskHeroProps {
  heading: string;
  subhead?: ReactNode;
  children?: ReactNode;
}

export function EmptyAskHero({ heading, subhead, children }: EmptyAskHeroProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {heading}
        </h2>
        {subhead && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{subhead}</p>
        )}
      </div>
      {children}
    </div>
  );
}
