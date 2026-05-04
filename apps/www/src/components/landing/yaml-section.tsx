import { type CSSProperties } from "react";

const YAML_LINES: ReadonlyArray<{ raw: string }> = [
  { raw: "name: Orders" },
  { raw: "type: fact_table" },
  { raw: "table: orders" },
  { raw: "grain: one row per order" },
  { raw: "" },
  { raw: "dimensions:" },
  { raw: "  - name: status" },
  { raw: "    sql: status" },
  { raw: "    type: string" },
  { raw: "    sample_values: [pending, shipped, delivered, cancelled]" },
  { raw: "" },
  { raw: "  - name: order_month" },
  { raw: "    sql: TO_CHAR(created_at, 'YYYY-MM')" },
  { raw: "    type: string" },
  { raw: "    virtual: true" },
  { raw: "" },
  { raw: "measures:" },
  { raw: "  - name: total_gmv_cents" },
  { raw: "    sql: total_cents" },
  { raw: "    type: sum" },
  { raw: "" },
  { raw: "joins:" },
  { raw: "  - target_entity: Customers" },
  { raw: "    relationship: many_to_one" },
  { raw: "    join_columns: { from: customer_id, to: id }" },
];

type Token = { text: string; cls?: string };

function tokenize(line: string): Token[] {
  if (line.trim().startsWith("- ") || line.trim().startsWith("name:") || line.includes(":")) {
    const match = line.match(/^(\s*)(-?\s*)?([\w\-_]+)(:\s*)(.*)$/);
    if (match) {
      const [, indent, dash, key, colon, rest] = match;
      const tokens: Token[] = [];
      if (indent) tokens.push({ text: indent });
      if (dash) tokens.push({ text: dash, cls: "text-brand" });
      tokens.push({ text: key ?? "", cls: "text-zinc-50 font-medium" });
      tokens.push({ text: colon ?? "" });
      if (rest) {
        if (/^\[.*\]$/.test(rest) || /^\{.*\}$/.test(rest)) {
          tokens.push({ text: rest, cls: "text-amber-300/90" });
        } else if (rest === "true" || rest === "false") {
          tokens.push({ text: rest, cls: "text-purple-300/90" });
        } else {
          tokens.push({ text: rest, cls: "text-amber-200/80" });
        }
      }
      return tokens;
    }
  }
  return [{ text: line }];
}

function YamlPane() {
  return (
    <div
      className="overflow-hidden rounded-xl border border-white/10"
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
          semantic/entities/orders.yml
        </span>
      </div>
      <pre className="m-0 overflow-auto p-4 font-mono text-[12px] leading-[1.7] text-zinc-300">
        {YAML_LINES.map((line, i) => (
          <span key={i} className="block">
            {tokenize(line.raw).map((tok, j) => (
              <span key={j} className={tok.cls}>
                {tok.text || " "}
              </span>
            ))}
          </span>
        ))}
      </pre>
    </div>
  );
}

const QUESTION = "What's our top-performing category by GMV this month?";

const ANSWER_ROWS: ReadonlyArray<{ category: string; gmv: string; orders: string }> = [
  { category: "Bedding", gmv: "$184,219", orders: "2,041" },
  { category: "Kitchen", gmv: "$142,718", orders: "1,587" },
  { category: "Bath", gmv: "$98,402", orders: "1,103" },
  { category: "Outdoor", gmv: "$71,288", orders: "812" },
  { category: "Accessories", gmv: "$54,011", orders: "693" },
];

function AnswerPane() {
  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10"
      style={{ background: "oklch(0.14 0 0)" }}
    >
      <div
        className="flex items-center gap-2 border-b border-white/5 px-3.5 py-2"
        style={{ background: "oklch(0.16 0 0)" }}
      >
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: "var(--atlas-brand)" }}
        />
        <span className="font-mono text-[11px] text-zinc-400">atlas · agent reply</span>
        <span className="ml-auto rounded border border-white/10 px-2 py-[2px] font-mono text-[10px] text-zinc-400">
          via MCP
        </span>
      </div>
      <div className="flex flex-col gap-4 px-4 py-5">
        <div>
          <p className="mb-1 font-mono text-[11px] tracking-[0.06em] text-brand">
            // user
          </p>
          <p className="m-0 text-[14px] text-zinc-100">{QUESTION}</p>
        </div>

        <div>
          <p className="mb-2 font-mono text-[11px] tracking-[0.06em] text-zinc-400">
            // agent reads orders.yml + categories.yml + glossary.yml, then writes SQL
          </p>
          <pre
            className="m-0 overflow-auto rounded-md border border-white/10 px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-zinc-300"
            style={{ background: "oklch(0.10 0 0)" }}
          >
            <span className="text-purple-300/90">SELECT</span> c.name,{"\n"}       <span className="text-purple-300/90">SUM</span>(o.total_cents) /{" "}
            <span className="text-amber-200/80">100.0</span> <span className="text-purple-300/90">AS</span> gmv,{"\n"}       <span className="text-purple-300/90">COUNT</span>(<span className="text-purple-300/90">DISTINCT</span> o.id){" "}
            <span className="text-purple-300/90">AS</span> orders{"\n"}
            <span className="text-purple-300/90">FROM</span> orders o{"\n"}
            <span className="text-purple-300/90">JOIN</span> order_items oi{" "}
            <span className="text-purple-300/90">ON</span> oi.order_id = o.id{"\n"}
            <span className="text-purple-300/90">JOIN</span> products p{" "}
            <span className="text-purple-300/90">ON</span> p.id = oi.product_id{"\n"}
            <span className="text-purple-300/90">JOIN</span> categories c{" "}
            <span className="text-purple-300/90">ON</span> c.id = p.category_id{"\n"}
            <span className="text-purple-300/90">WHERE</span> o.status !={" "}
            <span className="text-amber-200/80">'cancelled'</span>{"\n"}
              <span className="text-purple-300/90">AND</span> o.created_at &gt;={" "}
            <span className="text-purple-300/90">DATE_TRUNC</span>(<span className="text-amber-200/80">'month'</span>,{" "}
            <span className="text-purple-300/90">NOW</span>()){"\n"}
            <span className="text-purple-300/90">GROUP BY</span> c.name{"\n"}
            <span className="text-purple-300/90">ORDER BY</span> gmv{" "}
            <span className="text-purple-300/90">DESC</span>{"\n"}
            <span className="text-purple-300/90">LIMIT</span> <span className="text-amber-200/80">5</span>;
          </pre>
        </div>

        <div>
          <p className="mb-2 font-mono text-[11px] tracking-[0.06em] text-zinc-400">
            // result · 5 rows · 7 validators passed
          </p>
          <div
            className="overflow-hidden rounded-md border border-white/10"
            style={{ background: "oklch(0.10 0 0)" }}
          >
            <div
              className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-white/5 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.06em] text-zinc-400"
            >
              <span>category</span>
              <span className="text-right">gmv</span>
              <span className="text-right">orders</span>
            </div>
            {ANSWER_ROWS.map((row, i) => (
              <div
                key={row.category}
                className="grid grid-cols-[1fr_auto_auto] gap-4 px-3 py-1.5 font-mono text-[12px] text-zinc-200"
                style={{
                  background: i % 2 ? "oklch(0.12 0 0)" : "transparent",
                }}
              >
                <span>{row.category}</span>
                <span className="text-right text-brand">{row.gmv}</span>
                <span className="text-right text-zinc-400">{row.orders}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const QUESTIONS: ReadonlyArray<string> = [
  "What's our GMV this quarter?",
  "What's our top-performing category by GMV this month?",
  "Monthly GMV trend over the past 6 months.",
  "Show me revenue last quarter.",
  "What are our most common return reasons?",
];

export function YamlSection() {
  const cardStyle: CSSProperties = { background: "oklch(0.16 0 0)" };
  return (
    <section
      id="yaml"
      className="scroll-mt-20 border-b border-white/5 px-6 pt-20 pb-16 md:px-16 md:pt-[100px] md:pb-20"
      style={cardStyle}
    >
      <header className="mb-10 max-w-[760px]">
        <p className="mb-4 font-mono text-[11.5px] uppercase tracking-[0.16em] text-brand">
          // the schema is the product
        </p>
        <h2 className="m-0 mb-4 text-[36px] md:text-[46px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-50">
          The YAML format is the moat.
        </h2>
        <p className="m-0 text-base leading-[1.65] text-zinc-400">
          Entities, dimensions, measures, joins, virtual dimensions, query patterns, glossary terms, and authoritative metrics — all in YAML, in your repo, code-reviewed in pull requests. Every field exists because an LLM needs it: <code className="font-mono text-zinc-300">sample_values</code> ground the agent in real data, <code className="font-mono text-zinc-300">glossary.status: ambiguous</code> forces clarifying questions, <code className="font-mono text-zinc-300">metrics.objective</code> picks <code className="font-mono text-zinc-300">MAX</code> vs <code className="font-mono text-zinc-300">MIN</code>.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 md:items-stretch">
        <YamlPane />
        <AnswerPane />
      </div>

      <div className="mt-10">
        <p className="mb-3 font-mono text-[11px] tracking-[0.06em] text-brand">
          // canonical questions
        </p>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-5">
          {QUESTIONS.map((q) => (
            <div
              key={q}
              className="rounded-md border border-white/10 px-3 py-2.5 font-mono text-[12px] leading-[1.5] text-zinc-300"
              style={{ background: "oklch(0.14 0 0)" }}
            >
              {q}
            </div>
          ))}
        </div>
        <p className="mt-3 font-mono text-[11px] tracking-[0.04em] text-zinc-400">
          // same questions on the readme, the docs homepage, and the eval harness · against the bundled NovaMart e-commerce demo
        </p>
      </div>

      <div className="mt-10 flex flex-wrap gap-2.5">
        <a
          href="https://docs.useatlas.dev/semantic-layer"
          className="inline-flex items-center rounded-lg bg-brand px-[18px] py-[11px] text-[13.5px] font-semibold text-zinc-950 transition-colors hover:bg-brand-hover"
        >
          Read the YAML format →
        </a>
        <a
          href="https://app.useatlas.dev/demo"
          className="inline-flex items-center rounded-lg border border-white/10 bg-zinc-900 px-3.5 py-2.5 text-[13.5px] text-zinc-50 transition-colors hover:border-white/20"
        >
          try the NovaMart demo
        </a>
      </div>
    </section>
  );
}
