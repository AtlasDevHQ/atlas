import { type CSSProperties } from "react";

const HEADLINE_LINES = ["A semantic layer", "for analytics,", "agent-native."] as const;
const ITALIC_LINE_INDEX = 2;

const SUBHEAD =
  "Atlas is a YAML-defined semantic layer for analytics — authored by humans, consumed by AI agents. Entities, glossary, and metrics live in your repo; the agent reads them, writes deterministic SQL, and runs it through 7 validators before it ever touches your warehouse.";

type NodeKind =
  | "input"
  | "yaml"
  | "process"
  | "gate"
  | "db"
  | "result"
  | "audit"
  | "widget";

type SchemaNode = {
  id: string;
  x: number;
  y: number;
  w: number;
  label: string;
  value: string;
  kind: NodeKind;
};

const NODES: SchemaNode[] = [
  { id: "prompt",     x: 600,  y: 560, w: 220, label: "prompt",                value: '"top categories by gmv…"',   kind: "input"   },
  { id: "semantic",   x: 620,  y: 100, w: 240, label: "semantic_layer.yaml",   value: "entities · metrics · glossary", kind: "yaml"  },
  { id: "compiler",   x: 640,  y: 320, w: 200, label: "compiler",              value: "AST → SQL",                    kind: "process" },
  { id: "validators", x: 900,  y: 320, w: 240, label: "7 validators",          value: "ast · perms · row_limit · …",  kind: "gate"    },
  { id: "warehouse",  x: 1190, y: 200, w: 220, label: "warehouse",             value: "postgres / snowflake / bq",    kind: "db"      },
  { id: "result",     x: 1190, y: 460, w: 220, label: "result",                value: "rows · read-only",             kind: "result"  },
  { id: "audit",      x: 900,  y: 560, w: 240, label: "audit_log",             value: "every query · every op",       kind: "audit"   },
  { id: "widget",     x: 640,  y: 460, w: 200, label: "<AtlasChat />",         value: "react widget",                 kind: "widget"  },
];

const NODE_BY_ID: Record<string, SchemaNode> = Object.fromEntries(
  NODES.map((n) => [n.id, n]),
);

type Edge = { from: string; to: string; label: string };

const EDGES: Edge[] = [
  { from: "prompt",     to: "compiler",   label: "01"  },
  { from: "semantic",   to: "compiler",   label: "02"  },
  { from: "compiler",   to: "validators", label: "03"  },
  { from: "validators", to: "warehouse",  label: "04"  },
  { from: "warehouse",  to: "result",     label: "05"  },
  { from: "result",     to: "widget",     label: "06"  },
  { from: "validators", to: "audit",      label: "log" },
  { from: "result",     to: "audit",      label: "log" },
];

const EDGE_DELAY_MS = [0, 300, 600, 900, 1200, 1500, 1800, 2100];
const NODE_DELAY_MS: Record<string, number> = {
  prompt: 0,
  semantic: 0,
  compiler: 300,
  validators: 600,
  warehouse: 900,
  result: 1200,
  widget: 1500,
  audit: 1800,
};

const NODE_TINTS: Record<NodeKind, string> = {
  input:   "color-mix(in oklch, var(--atlas-brand) 14%, transparent)",
  yaml:    "oklch(0.18 0 0)",
  process: "oklch(0.18 0 0)",
  gate:    "oklch(0.2 0.04 167)",
  db:      "oklch(0.18 0 0)",
  result:  "oklch(0.18 0 0)",
  audit:   "oklch(0.18 0 0)",
  widget:  "oklch(0.18 0 0)",
};
const NODE_ACCENTS: Record<NodeKind, string> = {
  input:   "var(--atlas-brand)",
  yaml:    "oklch(0.85 0.18 70)",
  process: "oklch(0.78 0.13 280)",
  gate:    "var(--atlas-brand)",
  db:      "oklch(0.78 0.13 280)",
  result:  "var(--atlas-brand)",
  audit:   "oklch(0.708 0 0)",
  widget:  "oklch(0.85 0.18 70)",
};

function SchemaMap() {
  const W = 1440;
  const H = 720;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="block w-full"
      role="img"
      aria-label="Atlas system diagram: prompt and semantic layer feed the compiler, the compiler runs through 7 validators, then the warehouse, result, audit log, and React widget"
    >
      <defs>
        <linearGradient id="hero-wire-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--atlas-brand)" stopOpacity="0.7" />
          <stop offset="100%" stopColor="var(--atlas-brand)" stopOpacity="0.2" />
        </linearGradient>
        <pattern id="hero-dot-grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="oklch(1 0 0 / 0.06)" />
        </pattern>
        <radialGradient id="hero-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--atlas-brand)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--atlas-brand)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width={W} height={H} fill="url(#hero-dot-grid)" />
      <ellipse cx="980" cy="380" rx="420" ry="300" fill="url(#hero-halo)" />

      {EDGES.map((e, i) => {
        const a = NODE_BY_ID[e.from]!;
        const b = NODE_BY_ID[e.to]!;
        const ax = a.x + a.w / 2;
        const ay = a.y + 32;
        const bx = b.x + b.w / 2;
        const by = b.y + 32;
        const midX = (ax + bx) / 2;
        const path = `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
        const delay = EDGE_DELAY_MS[i] ?? 0;
        const litStyle = { "--schema-delay": `${delay}ms` } as CSSProperties;

        return (
          <g key={`${e.from}-${e.to}-${i}`} className="schema-edge" style={litStyle}>
            {/* Faint baseline so the path is always visible even in reduced-motion */}
            <path d={path} fill="none" stroke="oklch(1 0 0 / 0.08)" strokeWidth="1" />
            <path
              d={path}
              fill="none"
              stroke="url(#hero-wire-grad)"
              strokeWidth="1.4"
              strokeDasharray="2 6"
            >
              <animate
                attributeName="stroke-dashoffset"
                from="16"
                to="0"
                dur="2s"
                repeatCount="indefinite"
              />
            </path>
            <g transform={`translate(${midX - 14}, ${(ay + by) / 2 - 8})`}>
              <rect
                width="28"
                height="16"
                rx="3"
                fill="#0C0C10"
                stroke="color-mix(in oklch, var(--atlas-brand) 40%, transparent)"
              />
              <text
                x="14"
                y="11"
                textAnchor="middle"
                fontSize="9"
                fontFamily="var(--font-mono)"
                fill="var(--atlas-brand)"
                letterSpacing="0.06em"
              >
                {e.label}
              </text>
            </g>
          </g>
        );
      })}

      {NODES.map((n) => {
        const acc = NODE_ACCENTS[n.kind];
        const bg = NODE_TINTS[n.kind];
        const delay = NODE_DELAY_MS[n.id] ?? 0;
        const style = { "--schema-delay": `${delay}ms` } as CSSProperties;
        return (
          <g
            key={n.id}
            transform={`translate(${n.x}, ${n.y})`}
            className="schema-node"
            style={style}
          >
            <rect
              width={n.w}
              height="74"
              rx="8"
              fill={bg}
              stroke="oklch(1 0 0 / 0.1)"
              strokeWidth="1"
            />
            <circle cx="14" cy="32" r="4" fill={acc} />
            <circle cx={n.w - 14} cy="32" r="4" fill={acc} stroke="#0C0C10" strokeWidth="2" />
            <g transform="translate(28, 18)">
              <rect
                width={n.kind.length * 6.5 + 12}
                height="14"
                rx="3"
                fill="oklch(0 0 0 / 0.4)"
                stroke="oklch(1 0 0 / 0.08)"
              />
              <text
                x="6"
                y="10"
                fontSize="9"
                fontFamily="var(--font-mono)"
                fill={acc}
                letterSpacing="0.08em"
              >
                {n.kind.toUpperCase()}
              </text>
            </g>
            <text
              x="28"
              y="50"
              fontSize="14"
              fontFamily="var(--font-sans)"
              fill="oklch(0.985 0 0)"
              fontWeight="600"
            >
              {n.label}
            </text>
            <text
              x="28"
              y="65"
              fontSize="11"
              fontFamily="var(--font-mono)"
              fill="oklch(0.65 0 0)"
            >
              {n.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-white/5">
      {/* Absolute over the SVG on desktop, stacked above on mobile where the SVG shrinks. */}
      <div className="relative md:absolute md:top-20 md:left-20 md:z-[2] md:max-w-[460px] px-6 pt-16 md:px-0 md:pt-0">
        <p className="mb-[18px] font-mono text-[11.5px] uppercase tracking-[0.16em] text-brand">
          // the schema is the product
        </p>
        <h1 className="m-0 text-[44px] sm:text-[56px] md:text-[64px] font-semibold leading-[1.02] tracking-[-0.035em] text-zinc-50">
          {HEADLINE_LINES.map((line, i) => (
            <span key={line} className="block">
              {i === ITALIC_LINE_INDEX ? (
                <em className="font-semibold text-brand">{line}</em>
              ) : (
                line
              )}
            </span>
          ))}
        </h1>
        <p className="mt-6 max-w-[420px] text-base leading-[1.6] text-zinc-400">
          {SUBHEAD}
        </p>
        <div className="mt-7 flex flex-wrap gap-2.5">
          <a
            href="https://docs.useatlas.dev/guides/mcp"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-[18px] py-[11px] text-[13.5px] font-semibold text-zinc-950 transition-colors hover:bg-brand-hover"
          >
            Install the MCP server →
          </a>
          <a
            href="https://docs.useatlas.dev/guides/mcp"
            className="inline-flex items-center rounded-lg border border-white/10 bg-zinc-900 px-3.5 py-2.5 text-zinc-50 transition-colors hover:border-white/20"
          >
            <code className="font-mono text-[12.5px]">
              $ bunx @useatlas/mcp init
            </code>
          </a>
        </div>
        <p className="mt-3.5 font-mono text-[11px] tracking-[0.04em] text-zinc-400">
          works in claude desktop, cursor, continue · self-host is free
        </p>
      </div>

      <div className="md:pt-0 pt-8">
        <SchemaMap />
      </div>
    </section>
  );
}
