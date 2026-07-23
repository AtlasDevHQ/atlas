# Telemetry — span naming and attribute conventions

How Atlas names OpenTelemetry spans and their attributes, and where the
instrumentation seams are. Read this before adding a span (or a tool, which
gets one for free — see [Tool spans](#tool-spans-the-registry-seam)).

Tracing is opt-in at runtime: `@opentelemetry/api` returns a no-op tracer when
the SDK isn't initialized (no `OTEL_EXPORTER_OTLP_ENDPOINT`), so every wrapper
below exports nothing and does no exporter work on a deployment with tracing
off (the tool seam still costs a closure and a couple of function calls per
call). SDK setup lives in
`packages/api/src/lib/telemetry.ts`; the wrappers live in
`packages/api/src/lib/tracing.ts`.

## The wrappers

| Helper | Use for |
|---|---|
| `withSpan(name, attrs, fn, setResultAttributes?)` | Promise-returning work |
| `withEffectSpan(name, attrs, effect, setResultAttributes?)` | Effect-returning work — keeps `Data.TaggedError` types intact across the span so downstream `Effect.retry({ while })` policies can still discriminate on the tag |

Both set `SpanStatusCode.OK` on success and record the exception + `ERROR`
status on failure. `withEffectSpan` deliberately leaves a pure-interrupt cause
(clean shutdown via `Fiber.interrupt`) at `UNSET` so a graceful stop doesn't
read as an error in the trace explorer.

Prefer a wrapper over driving the tracer directly. Three places don't, each for
a reason the wrappers can't express:

- `http.request` (`api/index.ts`) reads its outcome from `c.res.status` after
  `next()` resolves — a 4xx/5xx is a returned response, not a throw, which
  `withSpan`'s OK-on-success contract can't say.
- `atlas.agent` (`agent.ts`) outlives the function that starts it: the span is
  ended from `onFinish` / `onError` once the stream completes.
- `atlas.tool.*` (`lib/tools/tool-spans.ts`) must not await: `withSpan` is
  typed `Promise<T>`, which would collapse the AI SDK's non-promise `execute`
  return arms (a plain value, or an `AsyncIterable` for a streaming tool) into
  a promise and change the shape the wrapper hands back to its caller.

## Span names

**`atlas.<subsystem>.<operation>`** — dotted, lowercase, `snake_case` within a
segment (`atlas.scheduler.oauth_state_cleanup`, not `oauthStateCleanup`).

One deliberate exception: the final segment of `atlas.tool.<name>` is a
verbatim tool identifier, not an operation phrase — it must match the name the
model calls and the SDK's `ai.toolCall.name` — so `atlas.tool.searchKnowledge`
is intentional, not the `healthCheckAll` class of drift below.

The `atlas.` prefix is what makes prefix-filtered dashboards work, so it is the
part that matters most. Subsystem segments in use today:

| Prefix | Emitted by |
|---|---|
| `atlas.agent` | the agent turn (root of the tool spans below) |
| `atlas.tool.<toolName>` | every registered agent tool — the registry seam |
| `atlas.sql.execute`, `atlas.explore`, `atlas.python.execute`, `atlas.profile.table` | tools that additionally self-instrument (nested under their seam span) |
| `atlas.profile.*` | schema profiling — `profiler.ts`, plus `atlas.profile.connection` (`effect/semantic-generator.ts`) and `atlas.profile.live_datasource` (`datasources/mcp-lifecycle.ts`). Most build their attributes via `profileSpanAttributes` |
| `atlas.plugin.*` | plugin lifecycle — init / refresh / teardown |
| `atlas.scheduler.*` | scheduler engine + delivery, plus the per-tick periodic-fiber spans whose names are pinned by `SCHEDULER_CLEANUP_SPAN_NAMES` / `SCHEDULER_WORK_SPAN_NAMES` in `effect/layers.ts` |
| `atlas.mcp.tool.run` | MCP tool dispatch (`packages/mcp/src/telemetry.ts`) |

A **name segment must be low-cardinality**. Per-tool span names are bounded by
what registers at boot — core tools plus whatever plugins wire in — so
`atlas.tool.<name>` is safe and keeps a trace waterfall readable. Anything
unbounded — a workspace id, a connection id, a query — belongs in an attribute,
never the name. Where a count would do, emit the count: the profiler emits
`atlas.profile.selected_table_count`, not the table names.

## Attributes

Two shapes are in use, both legitimate:

- **`atlas.<subsystem>.<attribute>`** when the attribute belongs to one
  subsystem — `atlas.tool.name`, `atlas.profile.db_type`,
  `atlas.compaction.*`, `atlas.durable.*`, `atlas.billing.*`.
- **`atlas.<attribute>`** (flat) for cross-cutting identifiers that ride spans
  from several subsystems — `atlas.connection_id`, `atlas.connection_group_id`,
  `atlas.org_id`, `atlas.row_count`, `atlas.model`, `atlas.backend`. This is
  the older and still the more common form; don't "fix" it, and don't invent a
  subsystem prefix for an id that genuinely crosses subsystems.

New subsystem-owned attributes should take the first form.

**No secrets on a span** — connection strings, API keys, tokens. Beyond that,
weigh what you attach: spans go to an external collector. Sizes, counts, ids
and enum-ish values are always safe. Two known exceptions ride today:
`atlas.command` on `atlas.explore` carries 200 chars of model-authored shell,
and `recordException` (used by both wrappers and by the tool seam) sends the
error message and stack, which for a driver error can include host/database/user.
Both are operator-facing and pre-existing; treat them as the ceiling, not a
licence to add more.

## Tool spans (the registry seam)

Every tool handed to the agent is wrapped in an **`atlas.tool.<name>`** span by
`withToolSpans` (`lib/tools/tool-spans.ts`), applied inside
`ToolRegistry.getAll()` — the point where tools leave the registry for the AI
SDK. Every *executable* tool is wrapped; client-side / provider-executed tools
(no `execute`) pass through untouched. **Adding a tool requires no telemetry
code**: registering it is what traces it. (#4464 exists because the previous
per-tool convention left `searchKnowledge`, `createDashboard`,
`executeRestOperation` and the action tools with no `atlas.*` segment at all —
only the tools that remembered to self-instrument had one.)

- The seam span is the **floor, not the ceiling.** A tool with richer
  instrumentation keeps its own inner span (`atlas.sql.execute` and friends),
  which nests *under* the seam span — the wrapper uses `startActiveSpan`, so
  the tool body runs inside the seam span's context.
- `ToolRegistry.get()` / `.entries()` deliberately return the **raw** entries:
  they feed metadata and `ToolRegistry.merge()`, and re-registering a wrapped
  tool would nest a redundant span. `getAll()` mints fresh wrapper closures per
  call, so its result is not identity-stable.
- Attributes: `atlas.tool.name` and `atlas.tool.call_id` (the AI SDK
  `toolCallId`) always; `atlas.tool.error` on completion; `atlas.tool.streaming`
  and `atlas.tool.aborted` on those paths only.
- Most Atlas tools report failure by *returning* an error envelope rather than
  throwing (the model needs to read the failure and retry), so that outcome
  rides as `atlas.tool.error` and the span status stays OK; a *thrown* error
  sets `ERROR` and records the exception. Two envelopes are recognized:
  `{ error: "..." }` and `success: false`. **Known gap:** two shapes read as
  no-error — a tool that discriminates on its own vocabulary (`sendEmail` /
  `createLinearIssue` return `{ status: "no_workspace" | … }`), because a
  generic seam can't know each tool's success words; and a tool that returns a
  bare string (`explore` returns `Error (exit N): …` as text), which can carry
  no envelope at all. Treat `atlas.tool.error` as a **lower bound** on returned
  failures.
- Telemetry can't fail a turn: every mutation after the span starts is guarded
  individually, so an exporter or attribute-validation throw is logged
  (`log.warn`), costs only its own operation, and leaves the tool's result — or
  its error, unmodified — to propagate. Span *creation* itself is not guarded: a
  provider that throws at `startActiveSpan` would fail the call.

### Boundaries of the seam span

`agent.ts` composes `getAll()` → `wrapToolsWithHooks` → `wrapToolsWithDurableState`,
so the seam span is the **innermost** wrapper. Consequences worth knowing before
reading a waterfall:

- Plugin `beforeToolCall` / `afterToolCall` dispatch falls **outside** the
  span: it measures tool execution, not the full per-call overhead. (The
  durable-state wrapper is `AsyncLocalStorage` context propagation only — no
  I/O; memory and transcript commits ride `onStepFinish`, outside any tool
  span.)
- A call rejected by a plugin `beforeToolCall` hook never reaches `execute`, so
  it emits **no** tool span at all — a rejected call is invisible, not fast.
  Symmetrically, an `afterToolCall` hook that rejects a *result* replaces it
  after the span has already closed OK, so the trace shows a success the model
  saw as an error.
- The AI SDK emits its own `ai.toolCall` span around `execute` when
  `experimental_telemetry` is on, so `atlas.tool.*` nests inside it — expect
  both. The seam still earns its keep: it carries the returned-error signal the
  SDK can't see (`ai.toolCall` marks a call that *returned* `{ error }` a
  success) and is the stable parent for the self-instrumented spans. It does
  not survive SDK telemetry being off — both are gated on
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- When any plugin is registered, `wrapToolsWithHooks` awaits `execute`, which
  collapses a streaming tool's `AsyncIterable` into a promise before the SDK
  sees it. Pre-existing, and moot while no Atlas tool streams — but the next
  person adding one needs to know.
- A **streaming** tool (`execute` returning an `AsyncIterable`) closes its span
  when `execute` returns the iterable — *before* the first chunk is pulled — so
  the span measures setup only and cannot see a mid-stream failure. It carries
  `atlas.tool.streaming` and its status is left `UNSET`: outcome unknown must
  not read as success. No Atlas tool streams today.
- A turn aborted mid-call closes the span with `atlas.tool.aborted`, so a
  disconnect doesn't leak an open span. The span closes **at abort time**: any
  later outcome — result, error, exception — is not recorded, so
  `atlas.tool.aborted` means "outcome unknown", the same stance the streaming
  arm takes. A signal already aborted when the call starts ends the span
  immediately, leaving a zero-duration span over an untraced execution.

## Grandfathered exceptions

Renaming a span or attribute breaks live trace queries and dashboards, so these
stay as-is until someone coordinates the rename with the dashboard owners.
Don't drive-by-fix them; don't copy them either. Not exhaustive — the flat
`atlas.<attribute>` family is described under [Attributes](#attributes) and is
a convention, not drift.

| Span / attribute | Where | Drift |
|---|---|---|
| `http.request` | `api/index.ts` | Intentional — OTel semantic-convention name for the HTTP root span, not Atlas drift |
| `db.system` on `atlas.sql.execute` | `lib/tools/sql.ts` | Same — OTel semantic convention |
| `stripe.webhook.process` | `lib/auth/server.ts` | Missing the `atlas.` prefix; prefix-filtered dashboards miss it |
| `billing.agent_gate` | `lib/billing/agent-gate.ts` | Missing the `atlas.` prefix |
| `atlas.plugin.healthCheckAll` | `lib/plugins/registry.ts` | camelCase operation segment; should be `health_check_all` |
| `code.length`, `streaming` on `atlas.python.execute` | `lib/tools/python.ts` | Bare attribute names; should be `atlas.python.*` |
| `tool.name`, `workspace.id`, `transport`, `deploy.mode`, `tool.success`, `tool.error_code` on `atlas.mcp.tool.run` | `packages/mcp/src/telemetry.ts` | Bare attribute names; should be `atlas.mcp.*` |

## Testing

`@opentelemetry/sdk-trace-base` is not a declared dependency of `@atlas/api`
(only transitive, via `sdk-node`), and declaring one to stand up an
`InMemorySpanExporter` has repeatedly not been judged worth it. Pick by what
the code actually needs:

- **Pure attribute builders** — extract the attribute construction and test it
  directly (`profileSpanAttributes`, `buildStripeWebhookSpanAttributes`,
  `toolResultAttributes`). What `profiler-span.test.ts` and
  `stripe-webhook-span.test.ts` settled for, judging the exporter wiring
  heavier than the typos it would catch.
- **Single-source name records** — pin structurally
  (`SCHEDULER_CLEANUP_SPAN_NAMES` / `SCHEDULER_WORK_SPAN_NAMES` asserted from
  `lib/effect/__tests__/layers.test.ts`), so a rename or a deleted registration
  fails a test.
- **Pass-through semantics** — result, arguments, error propagation. What could
  actually break a request (`tracing.test.ts`).
- **The full span lifecycle**, when the code hand-rolls it rather than
  delegating to `withSpan`. A stub `TracerProvider` built from
  `@opentelemetry/api` alone captures name/attributes/status/`end()`, so that
  cost was avoidable after all. See `tool-spans.test.ts`, which uses one to
  assert span naming,
  end-exactly-once on every exit path, and that an exploding span mutation
  still can't fail the tool call. Install it in `beforeAll` and `trace.disable()`
  in `afterAll` — never at module top level, per the self-contained-tests rule.
