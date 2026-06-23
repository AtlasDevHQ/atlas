import { CATEGORY_ROWS, TOP_CATEGORY_QUESTION } from "./data";

const YAML_LINES: ReadonlyArray<string> = [
  "name: Orders",
  "type: fact_table",
  "table: orders",
  "grain: one row per order",
  "",
  "dimensions:",
  "  - name: status",
  "    sql: status",
  "    type: string",
  "    sample_values: [pending, shipped, delivered, cancelled]",
  "",
  "  - name: order_month",
  "    sql: TO_CHAR(created_at, 'YYYY-MM')",
  "    type: string",
  "    virtual: true",
  "",
  "measures:",
  "  - name: total_gmv_cents",
  "    sql: total_cents",
  "    type: sum",
  "",
  "joins:",
  "  - target_entity: Customers",
  "    relationship: many_to_one",
  "    join_columns: { from: customer_id, to: id }",
];

type Token = { text: string; cls?: string };

function valueClass(rest: string): string {
  if (/^\[.*\]$/.test(rest) || /^\{.*\}$/.test(rest)) return "text-amber-300/90";
  if (rest === "true" || rest === "false") return "text-purple-300/90";
  return "text-amber-200/80";
}

function tokenize(line: string): Token[] {
  if (!line.includes(":")) return [{ text: line }];

  const match = line.match(/^(\s*)(-?\s*)?([\w\-_]+)(:\s*)(.*)$/);
  if (!match) return [{ text: line }];

  const [, indent, dash, key, colon, rest] = match;
  const tokens: Token[] = [];
  if (indent) tokens.push({ text: indent });
  if (dash) tokens.push({ text: dash, cls: "text-brand" });
  tokens.push({ text: key, cls: "text-zinc-50 font-medium" });
  tokens.push({ text: colon });
  if (rest) tokens.push({ text: rest, cls: valueClass(rest) });
  return tokens;
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
      <pre
        className="m-0 overflow-auto p-4 font-mono text-[12px] leading-[1.7] text-zinc-300"
        aria-label="YAML excerpt from semantic/entities/orders.yml"
      >
        {YAML_LINES.map((line, i) => (
          <span key={i} className="block">
            {tokenize(line).map((tok, j) => (
              <span key={j} className={tok.cls}>
                {tok.text || " "}
              </span>
            ))}
          </span>
        ))}
      </pre>
    </div>
  );
}

const QUESTION = TOP_CATEGORY_QUESTION;

/** The hero already renders the full result table; here we echo only the
 * top row so the SQL stays the payload and the answer doesn't repeat. */
const TOP_ROW = CATEGORY_ROWS[0];

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
            // you ask
          </p>
          <p className="m-0 text-[14px] text-zinc-100">{QUESTION}</p>
        </div>

        <div>
          <p className="mb-2 font-mono text-[11px] tracking-[0.06em] text-zinc-400">
            // atlas reads your YAML, then writes the SQL
          </p>
          <pre
            className="m-0 overflow-auto rounded-md border border-white/10 px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-zinc-300"
            style={{ background: "oklch(0.10 0 0)" }}
            aria-label="Generated SQL for: top-performing category by GMV this month"
          >
            <span className="text-purple-300/90">SELECT</span> c.name,{"\n"}       <span className="text-purple-300/90">SUM</span>(o.total_cents) /{" "}
            <span className="text-amber-200/80">100.0</span> <span className="text-purple-300/90">AS</span> gmv,{"\n"}       <span className="text-purple-300/90">COUNT</span>(<span className="text-purple-300/90">DISTINCT</span> o.id){" "}
            <span className="text-purple-300/90">AS</span> orders{"\n"}
            <span className="text-purple-300/90">FROM</span> orders o{"\n"}
            <span className="text-purple-300/90">JOIN</span> order_items oi{" "}
            <span className="text-purple-300/90">ON</span> oi.order_id = o.id{"\n"}
            <span className="text-purple-300/90">JOIN</span> products p{" "}
            <span className="text-purple-300/90">ON</span> p.name = oi.product_name{"\n"}
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
            // result · {CATEGORY_ROWS.length} rows · 7 validators passed
          </p>
          <div
            className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-md border border-white/10 px-3 py-2.5 font-mono text-[12.5px]"
            style={{ background: "oklch(0.10 0 0)" }}
          >
            <span className="text-zinc-400">{TOP_ROW.category} leads</span>
            <span className="text-brand">{TOP_ROW.gmv}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-400">{TOP_ROW.orders} orders</span>
          </div>
          <p className="mt-2 font-mono text-[11px] text-zinc-400">
            read-only · row-limited · audited
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The "how it works / why trust it" section: your semantic layer in YAML (the
 * input you control) beside the SQL Atlas generates and the validated result it
 * returns. Replaces the old YamlSection + TraceSection.
 */
export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="scroll-mt-20 border-b border-border-soft px-6 pt-20 pb-16 md:px-16 md:pt-[100px] md:pb-20"
      style={{ background: "var(--bg-raised)" }}
    >
      <header className="mb-10 max-w-[760px]">
        <h2 className="m-0 mb-4 text-[36px] md:text-[46px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">
          Why you can trust the answer.
        </h2>
        <p className="m-0 text-base leading-[1.65] text-fg-muted">
          You define your data once in YAML: the entities, joins, and the terms
          your team actually uses, versioned in your repo and reviewed in pull
          requests. Atlas reads it on every question, writes the SQL, and runs it
          read-only behind seven validators. You see exactly what ran.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 md:items-stretch">
        <YamlPane />
        <AnswerPane />
      </div>

      <div className="mt-10 flex flex-wrap gap-2.5">
        <a
          href="https://docs.useatlas.dev/semantic-layer"
          className="inline-flex items-center rounded-lg bg-accent px-[18px] py-[11px] text-[13.5px] font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
        >
          See how the YAML works →
        </a>
        <a
          href="https://app.useatlas.dev/demo"
          className="inline-flex items-center rounded-lg border border-border bg-transparent px-3.5 py-2.5 text-[13.5px] text-fg transition-colors hover:border-border-strong hover:bg-bg-sunken"
        >
          Try the demo
        </a>
      </div>
    </section>
  );
}
