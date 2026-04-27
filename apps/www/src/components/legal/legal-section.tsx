import type { LegalSectionData } from "./types";

export function LegalSection({
  section,
  index,
}: {
  section: LegalSectionData;
  index: number;
}) {
  return (
    <section id={section.id} aria-labelledby={`${section.id}-heading`} className="scroll-mt-24">
      <div className="mb-6 flex items-baseline gap-4 border-b border-zinc-800/40 pb-4">
        <span className="font-mono text-[13px] tracking-wider text-brand">
          {String(index + 1).padStart(2, "0")}
        </span>
        <h2
          id={`${section.id}-heading`}
          className="text-xl font-semibold tracking-tight text-zinc-100 md:text-2xl"
        >
          {section.title}
        </h2>
      </div>
      <div className="grid gap-8 md:grid-cols-[1fr_280px] md:gap-10">
        <div className="space-y-4 text-[14.5px] leading-7 text-zinc-300">
          {section.legal.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
        <aside className="border-l border-dashed border-zinc-700/60 pl-6">
          <p className="mb-3 font-mono text-[10.5px] tracking-widest text-brand uppercase">
            // plain english
          </p>
          <p className="text-[13px] leading-6 text-zinc-400">{section.plain}</p>
        </aside>
      </div>
    </section>
  );
}
