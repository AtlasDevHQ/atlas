/**
 * Knowledge Base feature section (#4226) — the fourth pillar, shipped v0.0.40.
 * Copy stays plain-language and mirrors the trust story: knowledge *informs*
 * answers, the semantic layer stays the only authoritative surface. The pane
 * shows a real hosted document — OKF markdown + the `atlas:` provenance block
 * is the at-rest truth (ADR-0028); the "published" chip is admin UI state, so
 * it rides in the pane chrome, not the file body.
 */

const DOC_LINES: ReadonlyArray<{ text: string; cls?: string }> = [
  { text: "---", cls: "text-zinc-500" },
  { text: "type: concept", cls: "text-zinc-300" },
  { text: "title: What counts as churn", cls: "text-zinc-300" },
  { text: "tags: [metrics, retention]", cls: "text-zinc-300" },
  { text: "atlas:", cls: "text-brand" },
  { text: "  collection: product-handbook", cls: "text-zinc-400" },
  { text: "  source: bundle-sync", cls: "text-zinc-400" },
  { text: "---", cls: "text-zinc-500" },
  { text: "" },
  { text: "A customer counts as churned when their last", cls: "text-zinc-200" },
  { text: "subscription lapses and no reactivation occurs", cls: "text-zinc-200" },
  { text: "within 30 days. Exclude workspaces tagged", cls: "text-zinc-200" },
  { text: "internal_test — they never count as revenue.", cls: "text-zinc-200" },
];

function KnowledgeDocPane() {
  return (
    <div
      className="overflow-hidden rounded-xl border border-white/10 shadow-pane"
      style={{ background: "oklch(0.12 0 0)" }}
    >
      <div
        className="flex items-center gap-2 border-b border-white/5 px-3.5 py-2"
        style={{ background: "oklch(0.16 0 0)" }}
      >
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: "oklch(0.65 0.18 22)" }}
        />
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: "oklch(0.78 0.16 70)" }}
        />
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: "oklch(0.7 0.16 140)" }}
        />
        <span className="ml-2 font-mono text-[11px] text-zinc-400">
          knowledge/product-handbook/concepts/churn.md
        </span>
        <span className="ml-auto rounded border border-white/10 px-2 py-[2px] font-mono text-[10px] text-zinc-400">
          reviewed · published
        </span>
      </div>
      <pre
        className="m-0 overflow-auto p-4 font-mono text-[12px] leading-[1.7] text-zinc-300"
        aria-label="A hosted knowledge document: OKF markdown with an atlas: provenance block"
      >
        {DOC_LINES.map((line, i) => (
          <span key={i} className={`block ${line.cls ?? ""}`}>
            {line.text || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * The Knowledge Base band: what the agent reads beyond the schema. Sits after
 * HowItWorks (the YAML trust story) so the page reads "schema first, business
 * knowledge second, both review-gated".
 */
export function KnowledgeBase() {
  return (
    <section
      id="knowledge"
      className="scroll-mt-20 border-b border-border-soft px-content pt-20 pb-16 md:pt-[88px] md:pb-[72px]"
    >
      <div className="grid gap-10 md:grid-cols-2 md:items-center">
        <div>
          <p className="mb-3 font-mono text-[11px] tracking-[0.06em] text-brand">
            // knowledge base
          </p>
          <h2 className="m-0 mb-4 text-[36px] md:text-[46px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">
            It knows your business, not just your schema.
          </h2>
          <p className="m-0 mb-4 text-base leading-[1.65] text-fg-muted">
            Your schema says what the data is; your team knows what it means.
            Upload runbooks, metric definitions, and business rules as
            plain-markdown collections — or point a collection at your docs
            repo and Atlas keeps it in sync nightly. The agent reads them
            alongside your semantic layer when it answers.
          </p>
          <p className="m-0 mb-6 text-base leading-[1.65] text-fg-muted">
            Every upload lands as a draft a human reviews before the agent can
            see it. And knowledge only ever <em>informs</em> answers — it never
            runs as SQL and never overrides your semantic layer.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <a
              href="https://docs.useatlas.dev/guides/knowledge-base"
              className="inline-flex items-center rounded-lg bg-accent px-[18px] py-[11px] text-[13.5px] font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
            >
              Read the Knowledge Base guide →
            </a>
          </div>
        </div>

        <KnowledgeDocPane />
      </div>
    </section>
  );
}
