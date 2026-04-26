type NodeKind = "entity" | "gate" | "db" | "audit";

const NODE_ACCENT: Record<NodeKind, string> = {
  entity: "oklch(0.85 0.18 70)",
  gate:   "var(--atlas-brand)",
  db:     "oklch(0.78 0.13 280)",
  audit:  "oklch(0.708 0 0)",
};

type PrimitiveCardProps = {
  kind: NodeKind;
  name: string;
  title: string;
  blurb: string;
  ports: ReadonlyArray<string>;
};

function PrimitiveCard({ kind, name, title, blurb, ports }: PrimitiveCardProps) {
  const accent = NODE_ACCENT[kind];
  return (
    <article
      className="relative rounded-xl border border-white/10 p-6"
      style={{ background: "oklch(0.18 0 0 / 0.4)" }}
    >
      <header className="mb-4 flex items-center gap-2.5">
        <span
          className="rounded border px-[7px] py-[3px] font-mono text-[9.5px] tracking-[0.12em] uppercase"
          style={{
            color: accent,
            borderColor: `color-mix(in oklch, ${accent} 30%, transparent)`,
          }}
        >
          {kind}
        </span>
        <span className="font-mono text-[12px] text-zinc-400">{name}</span>
        <span
          className="ml-auto h-2 w-2 rounded-full"
          style={{ background: accent }}
        />
      </header>
      <h3 className="m-0 mb-2 text-[19px] font-semibold text-zinc-50">{title}</h3>
      <p className="m-0 mb-4 text-[13.5px] leading-[1.6] text-zinc-400">{blurb}</p>
      <div className="flex flex-wrap gap-1.5">
        {ports.map((port) => (
          <span
            key={port}
            className="rounded border border-white/10 px-2 py-[3px] font-mono text-[10.5px] text-zinc-400"
            style={{ background: "oklch(0.16 0 0)" }}
          >
            {port}
          </span>
        ))}
      </div>
    </article>
  );
}

type DropInProps = { name: string; desc: string };

function DropInItem({ name, desc }: DropInProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-mono text-[14px] font-medium text-zinc-50">{name}</div>
      <div className="text-[12.5px] leading-[1.55] text-zinc-400">{desc}</div>
    </div>
  );
}

export function Primitives() {
  return (
    <section
      id="primitives"
      className="scroll-mt-20 border-b border-white/5 px-6 pt-20 pb-16 md:px-16 md:pt-[88px] md:pb-[72px]"
    >
      <header className="mb-10 max-w-[720px]">
        <p className="mb-4 font-mono text-[11.5px] uppercase tracking-[0.16em] text-brand">
          // nodes in the system
        </p>
        <h2 className="m-0 mb-4 text-[36px] md:text-[46px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-50">
          Four primitives.
        </h2>
        <p className="m-0 text-base leading-[1.65] text-zinc-400">
          Inspectable, optional, TypeScript. No agent, no orchestration framework, no prompt salad.
        </p>
      </header>

      <div className="grid gap-3.5 md:grid-cols-2">
        <PrimitiveCard
          kind="entity"
          name="semantic_layer"
          title="Semantic layer"
          blurb="Entities, metrics, glossary in YAML. Versioned beside your code. Atlas reads them on every prompt."
          ports={["accounts", "metrics", "glossary"]}
        />
        <PrimitiveCard
          kind="gate"
          name="validators"
          title="7 validators"
          blurb="AST-parsed, permission-checked, row-limited. Read-only by default. Same in dev, same in prod."
          ports={["ast", "perms", "row_limit", "+ 4"]}
        />
        <PrimitiveCard
          kind="db"
          name="warehouses"
          title="Warehouse-native"
          blurb="One connection spec. On self-host, no data leaves your network. Atlas runs in your VPC."
          ports={["postgres", "snowflake", "bigquery", "duckdb"]}
        />
        <PrimitiveCard
          kind="audit"
          name="audit_log"
          title="Audit-ready"
          blurb="Every query, every result, every operator — logged, searchable, exportable. SSO, SAML, SCIM."
          ports={["sso", "saml", "scim", "csv"]}
        />
      </div>

      {/* Drop-in surfaces strip */}
      <div
        className="mt-8 rounded-[10px] border border-dashed border-white/10 px-6 py-6 md:px-7 md:py-6"
        style={{ background: "oklch(0.16 0 0 / 0.5)" }}
      >
        <p className="mb-4 font-mono text-[11px] tracking-[0.06em] text-brand">
          // drop-in surfaces
        </p>
        <div className="grid items-stretch gap-6 md:[grid-template-columns:1fr_1px_1fr_1px_1fr]">
          <DropInItem
            name="<AtlasChat />"
            desc="React widget. Inherits your tokens, speaks your data."
          />
          <div className="hidden h-full w-px bg-white/5 md:block" />
          <DropInItem
            name="prompt_lib.ts"
            desc="Prompts in TypeScript, not strings in a UI. Diffed, rolled back, code-reviewed."
          />
          <div className="hidden h-full w-px bg-white/5 md:block" />
          <DropInItem
            name="$ atlas cli"
            desc="Run, test, replay queries from terminal or CI."
          />
        </div>
      </div>
    </section>
  );
}
