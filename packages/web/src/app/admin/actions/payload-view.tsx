/**
 * Renders an action's payload based on its `type`. Known types get a
 * structured view (SQL pre-block, method/url chip, file path + content).
 * Unknown types, and known types with malformed payloads, fall through to
 * a JSON dump so the operator still sees *something* instead of a blank
 * expansion.
 *
 * The `console.warn` on malformed known-type payloads is intentional and
 * asserted in `payload-view.test.tsx` — it surfaces schema drift when
 * the agent starts emitting a new payload shape. Without it, the
 * fallback would silently hide the drift.
 */
export function PayloadView({
  type,
  payload,
}: {
  type: string;
  payload: Record<string, unknown>;
}) {
  const t = type.toLowerCase();

  if (t === "sql_write" || t === "sql") {
    if (typeof payload.sql === "string") {
      return (
        <pre className="overflow-auto rounded border bg-muted/60 p-2 font-mono text-xs leading-relaxed">
          {payload.sql}
        </pre>
      );
    }
    console.warn(`PayloadView: ${type} payload missing string .sql`, payload);
  }

  if (t === "api_call" || t === "api") {
    const method = typeof payload.method === "string" ? payload.method : null;
    const url = typeof payload.url === "string" ? payload.url : null;
    if (method || url) {
      const body = payload.body;
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 rounded border bg-muted/60 px-2 py-1.5 font-mono text-xs">
            {method && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                {method}
              </span>
            )}
            {url && <span className="truncate text-foreground">{url}</span>}
          </div>
          {body != null && (
            <pre className="overflow-auto rounded border bg-muted/40 p-2 text-xs">
              {typeof body === "string" ? body : JSON.stringify(body, null, 2)}
            </pre>
          )}
        </div>
      );
    }
    console.warn(`PayloadView: ${type} payload missing method/url`, payload);
  }

  if (t === "file_write" || t === "file") {
    if (typeof payload.path === "string") {
      return (
        <div className="space-y-1.5">
          <div className="rounded border bg-muted/60 px-2 py-1.5 font-mono text-xs">
            {payload.path}
          </div>
          {typeof payload.content === "string" && (
            <pre className="overflow-auto rounded border bg-muted/40 p-2 font-mono text-xs">
              {payload.content}
            </pre>
          )}
        </div>
      );
    }
    console.warn(`PayloadView: ${type} payload missing string .path`, payload);
  }

  // Fallback so payloads from new tools surface unformatted instead of disappearing.
  return (
    <pre className="overflow-auto rounded border bg-muted/40 p-2 text-xs">
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}
