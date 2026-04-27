"use client";

import { useEffect, useState } from "react";
import type { LegalSectionData } from "./types";

export function LegalTOC({ sections }: { sections: LegalSectionData[] }) {
  const [activeId, setActiveId] = useState<string | null>(sections[0]?.id ?? null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveId(visible.target.id);
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const section of sections) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  return (
    <aside aria-label="Document contents" className="lg:sticky lg:top-24 lg:self-start">
      <p className="mb-4 font-mono text-[11px] tracking-widest text-brand uppercase">
        // contents
      </p>
      <ol className="space-y-1">
        {sections.map((section, i) => {
          const isActive = activeId === section.id;
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={isActive ? "location" : undefined}
                className={`-ml-3.5 flex items-baseline gap-2.5 border-l-2 py-1.5 pl-3 text-[13px] transition-colors hover:border-brand/60 hover:text-brand ${
                  isActive
                    ? "border-brand text-brand"
                    : "border-transparent text-zinc-400"
                }`}
              >
                <span
                  className={`font-mono text-[10px] tracking-wider ${
                    isActive ? "text-brand" : "text-zinc-400"
                  }`}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{section.title}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
