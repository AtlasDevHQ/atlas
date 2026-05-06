# MCP transport-session storage and scaling path

**Status:** active · **Date:** 2026-05-05 · **Owners:** Atlas core

## Context

Atlas's hosted MCP endpoint (#2024) stores per-session SSE transport state in an in-process `Map<sessionId, SSEServerTransport>`. This is the canonical pattern from Railway's own MCP guide and `@modelcontextprotocol/sdk` examples. It works correctly for single-process deployments; it breaks the moment requests for the same logical session can land on different processes.

In May 2026 we discovered (and verified via Railway's published docs):

> If you are using a single region with multiple replicas, Railway will randomly distribute public traffic to the replicas of that region.

There is no sticky-session toggle, IP-hash routing, or session affinity available on Railway. The MCP guide they publish themselves uses the same in-memory pattern Atlas uses — the platform's expected operating mode for an MCP server is **single-replica**.

Three consequences:

1. **Multi-replica MCP is currently impossible** without an external session store. A frame routed to the wrong replica returns `404 unknown_session`; the silent failure mode is "agent works for the first frame, disconnects on the next."
2. **Sticky-session implementation work (Path A)** is unavailable as a partial fix. Either we stay single-replica or we externalize state.
3. **The decision crystallizes** into "single replica per region today, durable session store when scaling demands it."

## Capacity envelope at single-replica

A single Bun process can hold thousands of idle SSE connections (low cost per fd) but is CPU-bound by tool-call execution at ~50–200 *truly active* concurrent sessions. "Active" = sending frames in the current second; idle agents waiting for user input are nearly free.

Realistic projection for Atlas's 1.0.0 → 1.5.0 trajectory: single-replica capacity is the **binding constraint after 1–2 years** at current growth pace. Atlas hits other limits first (database pool sizing, agent throughput, region capacity).

## Decision

Three phases, with explicit trigger conditions for each transition.

### Phase 0 (today — 1.4.1)

- One Railway replica per region (`api`, `api-eu`, `api-apac`)
- In-process `Map<sessionId, SSEServerTransport>` — unchanged from #2024's shape
- `MultiReplicaGuardLive` boot Layer (#2069 revised scope) hard-fails the api at startup if `RAILWAY_REPLICA_COUNT > 1` without `ATLAS_MCP_SESSION_STORE` configured
- OpenStatus synthetic monitor sends sequential MCP frames against prod and alerts on `404 unknown_session` — catches accidental drift past single-replica
- `apps/docs/content/docs/guides/mcp-hosted.mdx` accurately reflects the constraint (no false claim of "sticky routing required")

### Phase 1 — durable Postgres-backed session store

Triggered when *any* of:

- Single region exceeds ~150 concurrent active sessions at sustained peak (observable via the OTel signals from #2029)
- Customer SLA contract requires session-survival across deploys
- High-availability requirement forces multi-replica even at low throughput

Implementation shape (~3–5 days):

- **`@useatlas/api/lib/auth/secondary-storage.ts`** — Postgres-backed implementation of Better Auth's `SecondaryStorage` interface (`get` / `set` / `delete` with optional TTL). Backing table: `secondary_storage(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at TIMESTAMPTZ)` with an index on `expires_at` for TTL sweeps. ~50 lines, Atlas-owned, used by every K/V consumer Atlas accumulates over time
- **`@useatlas/api/lib/mcp/postgres-transport.ts`** — Custom `MCPServerTransport` against `@modelcontextprotocol/sdk`'s interface. Session metadata stored via the `SecondaryStorage` adapter; frame queue backed by `mcp_session_frames(session_id, frame_id, payload, created_at)`; SSE fan-out via Postgres `LISTEN/NOTIFY`
- **Drizzle migration** adding both tables
- **Better Auth integration**: wire the new `secondary-storage.ts` adapter into the `betterAuth({ secondaryStorage })` config. Free upgrades for the same effort: stateless session validation across replicas, rate-limit-state across replicas (currently per-replica in-memory), API-key cache
- **Boot-guard inversion**: `MultiReplicaGuardLive` becomes `RequireSessionStoreLive` — asserts the durable store IS configured before allowing multi-replica startup

Capacity target: **1000–2000 concurrent active sessions per region**, bounded by per-region Postgres write throughput on `*-int-postgres`.

### Phase 2 — Redis-backed (only if Phase 1 ceiling hits)

Triggered when *both* of:

- Phase 1 reaches Postgres write throughput limits (>500 frames/sec sustained per region) **and**
- p99 latency exceeds ~50ms store→deliver with Postgres verified as the bottleneck (flame-graph evidence, not speculation)

Implementation shape:

- Replace `secondary-storage.ts` adapter Postgres → Redis (one-config-change at the `betterAuth` boundary)
- Migrate `frame-queue` from Postgres `LISTEN/NOTIFY` to Redis Streams (`XADD` / `XREAD`)
- Three regional Redis instances on Railway following the existing per-region Postgres pattern
- All four Better Auth K/V consumers (sessions, rate limit, API keys, MCP session metadata) move to the same Redis backend simultaneously — operational cost amortized across consumers

Capacity target: **50,000+ concurrent active sessions per region**.

Atlas's growth pattern does not realistically reach Phase 2 within the current planning horizon. The phase exists in this document for completeness — to make sure the migration path is pre-thought if the trigger ever fires — not as a commitment.

## Why this seam, not others

- **Better Auth `SecondaryStorage` is the only K/V interface that survives the eventual Redis transition without a rewrite.** Custom interfaces would make Phase 2 a rewrite; this one makes it a swap.
- **Atlas already operates Postgres.** Adding Redis preemptively means three regional Redis instances on Railway, three more bills, three more SPOFs, three more monitoring surfaces — for a workload Postgres handles for years. Premature dependency by the textbook definition.
- **Postgres handles the workload.** ~1000 INSERT/sec per regional Postgres on a Hobby/Pro plan with WAL tuning. MCP frame rate is ~1/sec per active session. Math: comfortably 1000 concurrent active sessions per region before Postgres becomes the bottleneck.
- **`MCPServerTransport` is a stable abstraction in `@modelcontextprotocol/sdk`.** Building a custom transport doesn't fight the SDK; it uses the supported extension point. Future-proof against MCP spec evolution.

## Why not other backends

- **Sticky-session routing on Railway** — confirmed unavailable via Railway's docs ("randomly distribute public traffic"). Path is dead.
- **External LB in front of Railway (HAProxy / nginx with sticky)** — material infrastructure complexity, fights Railway's opinionated stack. Not worth the deviation.
- **Redis today** — premature dependency. Atlas runs no Redis code anywhere, no operational ramp paid, no other subsystem currently broken without it. Wait for amortization.
- **Memcached / KV-only stores** — lacks the streaming primitive needed for SSE frame fan-out. Would still need Postgres or Redis alongside for the queue.
- **Agent vendor session multiplexing** — out of our hands. Each MCP client (Claude Desktop, Cursor, ChatGPT) maintains its own session lifecycle; we can't influence their replica selection.

## Trigger metrics (Phase 0 → Phase 1)

Track these via the OTel signals introduced in #2029:

- `atlas.mcp.active_sessions` (gauge) — peak across regions
- `atlas.mcp.frames_per_second` (counter) — derive p95 burst rate
- `atlas.mcp.frame_latency` (histogram) — p99 delivery latency

Phase 1 work begins when peak `atlas.mcp.active_sessions` in any single region exceeds **150 for two consecutive weeks**, or when an explicit customer ask demands session-survival.

## References

- [#2069 — sticky-routing verification (revised scope)](https://github.com/AtlasDevHQ/atlas/issues/2069) — Phase 0 doc + boot-guard work
- [#2109 — Phase 1 implementation issue](https://github.com/AtlasDevHQ/atlas/issues/2109) — durable session store; filed alongside this ADR
- [#2068 — `mcp.useatlas.dev` brand hostname](https://github.com/AtlasDevHQ/atlas/issues/2068) — adjacent MCP work, unblocked by today's DNS
- [#2024 — hosted MCP endpoint](https://github.com/AtlasDevHQ/atlas/issues/2024) — original hosted MCP shipment
- Railway scaling docs — confirmed via Context7 lookup; "randomly distribute public traffic" is the canonical phrase
- Railway MCP server guide — confirms in-process Map is the platform's expected pattern
- Better Auth `SecondaryStorage` — the K/V abstraction Atlas adopts as the migration seam
- `@modelcontextprotocol/sdk` `MCPServerTransport` — the streaming abstraction Phase 1 implements against
