type DropInProps = { name: string; desc: string };

function DropInItem({ name, desc }: DropInProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-mono text-[14px] font-medium text-fg">{name}</div>
      <div className="text-[12.5px] leading-[1.55] text-fg-muted">{desc}</div>
    </div>
  );
}

/**
 * The "drop-in surfaces" band. Carried over from the old Primitives section —
 * the four architecture cards were cut as too internal for a plain-language
 * page, but "use it wherever your team already works" is a real outcome, so the
 * surfaces strip stays as its own lightweight section.
 */
export function DropInSurfaces() {
  return (
    <section
      id="surfaces"
      className="scroll-mt-20 border-b border-border-soft px-content pt-20 pb-16 md:pt-[88px] md:pb-[72px]"
    >
      <header className="mb-8 max-w-[720px]">
        <h2 className="m-0 mb-4 text-[36px] md:text-[46px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">
          Use it where your team already works.
        </h2>
        <p className="m-0 text-base leading-[1.65] text-fg-muted">
          Embed the chat in your app, hand it to any MCP client, edit
          dashboards in the conversation, keep your prompts in code, or run
          queries from the terminal.
        </p>
      </header>

      <div
        className="rounded-[10px] border border-dashed border-border px-6 py-6 md:px-7 md:py-6"
        style={{ background: "var(--bg-raised)" }}
      >
        <div className="grid items-stretch gap-6 md:[grid-template-columns:1fr_1px_1fr_1px_1fr_1px_1fr]">
          <DropInItem
            name="<AtlasChat />"
            desc="React component, typed @useatlas/sdk, or a one-line script-tag widget. Inherits your tokens, speaks your data."
          />
          <div className="hidden h-full w-px bg-border-soft md:block" />
          <DropInItem
            name="bunx @useatlas/mcp"
            desc="MCP server (stdio + SSE). One init wires Atlas into Claude Desktop, Cursor, or Continue."
          />
          <div className="hidden h-full w-px bg-border-soft md:block" />
          <DropInItem
            name="dashboards.yml"
            desc="Chat drawer is the editor. Per-user drafts, versioned baseline, atomic Publish, bound-mode editing."
          />
          <div className="hidden h-full w-px bg-border-soft md:block" />
          <DropInItem
            name="$ atlas cli"
            desc="Prompts in code, run/test/replay queries from terminal or CI."
          />
        </div>
      </div>

      <p className="mt-6 text-[12.5px] leading-[1.55] text-fg-muted">
        SQL warehouses, search engines and REST APIs all become datasources you
        can ask in plain English, read-only, behind the same validators. The
        full list lives in the docs:{" "}
        <a href="https://docs.useatlas.dev/getting-started/connect-your-data" className="text-fg underline decoration-border-strong underline-offset-4 hover:text-accent">
          connect your data
        </a>
        .
      </p>
    </section>
  );
}
