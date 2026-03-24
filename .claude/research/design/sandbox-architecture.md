# Sandbox Architecture Design

> Design doc for platform-agnostic code execution sandboxing in Atlas.
> Relates to: #83 (sandbox lifecycle), #44 (v0.9 secret injection)

## Problem

Atlas needs isolated code execution for two purposes:

1. **Explore tool (today)** — run shell commands (`ls`, `cat`, `grep`) against the semantic layer YAML files. Read-only, no network, no secrets needed.

2. **Code execution tool (future)** — run agent-generated Python/scripts to analyze data retrieved via SQL. Needs a runtime (Python + pandas/numpy), may need authenticated access to AI services (via credential brokering), must not have direct access to secrets.

The explore tool works today on Vercel (Firecracker VM) and on Linux with nsjail. It fails on **Railway and Render** because these platforms run shared-kernel containers that block `clone()` with namespace flags — no `CAP_SYS_ADMIN`, no unprivileged user namespaces. Both bubblewrap (bwrap) and firejail hit the same wall. This is a fundamental platform limitation, not a configuration issue.

The code execution tool is a harder problem because it requires:
- A real language runtime (Python, not just bash/coreutils)
- Potentially authenticated network access (AI gateway, external APIs)
- Credential brokering (secrets injected at the network layer, never visible to sandboxed code)
- Data ingress (SQL results passed into the sandbox)

## Threat Model: Who Needs What

Not every deployment needs the same level of sandbox isolation. The right tier depends on your trust model:

### Self-hosted / single-tenant (company deploys Atlas for their own team)

The agent and all its users are employees operating within the same trust boundary. The LLM provider (Anthropic, OpenAI) is the only external party. In this model:

- **Prompt injection is the main risk** — a crafted value in the database or semantic layer could influence the agent's behavior. But the agent's tools are already scoped: `executeSQL` is SELECT-only with table whitelisting, and `explore` only reads YAML files. Even a successful injection can't write data, access secrets, or reach the network.
- **There's no untrusted multi-tenant boundary** — User A and User B are both employees with legitimate access to the same data. Cross-user isolation is a nice-to-have, not a security requirement.
- **nsjail or the sidecar is plenty** — you're defending against accidental damage or a particularly creative prompt injection, not against a hostile tenant trying to escape a VM.
- **just-bash is acceptable** — if you run Atlas on a private network, behind VPN, with `ATLAS_API_KEY` auth, the explore tool reading YAML files via `just-bash` with path-traversal protection is a reasonable posture. The risk of a read-only `cat` on YAML files is genuinely low.

### Multi-tenant SaaS / public-facing (Atlas serves users from different organizations)

Now you have real trust boundaries. User A should not be able to influence User B's queries or data. The LLM might process attacker-controlled input (e.g., data from a user's database that contains injection payloads). In this model:

- **Sandbox isolation is critical** — generated code (explore commands, future Python analysis) must run in its own security context with no path to secrets or other users' data.
- **Credential brokering matters** — if the code execution tool needs to call external APIs, secrets must be injected at the network layer, never visible inside the sandbox.
- **Firecracker (Vercel Sandbox, E2B) is the right answer** — hardware-level VM isolation, ephemeral per execution, impossible for one tenant's code to see another's memory or filesystem.
- **The sidecar is a step down** — process isolation within a shared container is weaker than VM isolation. It prevents cross-request data leakage (separate tmpdirs, separate subprocesses) but doesn't provide a hypervisor boundary.

### The spectrum

```
                        More isolation →

Self-hosted,        Self-hosted,       Multi-tenant      Multi-tenant
private network     public-facing      (internal)        SaaS

┌──────────┐      ┌──────────┐      ┌──────────┐      ┌──────────┐
│ just-bash│      │  nsjail  │      │ sidecar  │      │ Vercel   │
│ or       │      │  or      │      │ or       │      │ Sandbox  │
│ sidecar  │      │ sidecar  │      │ E2B      │      │ or E2B   │
└──────────┘      └──────────┘      └──────────┘      └──────────┘
  Tier 4-5           Tier 3-4          Tier 2-4          Tier 1-2
```

Atlas auto-detects the best available tier and falls back gracefully. You can override with `ATLAS_SANDBOX` if you need a specific guarantee.

## Security Model

Reference: [Vercel — Security boundaries in agentic architectures](https://vercel.com/blog/security-boundaries-in-agentic-architectures) (Feb 2026)

### Four Actors

| Actor | Atlas equivalent | Trust level |
|-------|-----------------|-------------|
| Agent harness | Hono API + `streamText` loop | Trusted (deployed via SDLC) |
| Agent secrets | `ATLAS_DATASOURCE_URL`, API keys, `DATABASE_URL` | Must never enter sandbox |
| Generated code | `explore` commands, future Python analysis | Untrusted (prompt-injectable) |
| Filesystem / environment | Host OS, `semantic/` directory | Protected from generated code |

### Current Architecture (Correct)

Atlas already follows the recommended architecture for the explore tool:

- **Agent harness** holds all secrets. The agent never sees connection strings.
- **`executeSQL`** runs in the harness — the agent invokes it as a scoped tool, the harness validates SQL through 4 layers, then executes it with the DB connection it manages.
- **`explore`** runs in a sandbox with no secrets (`JAIL_ENV` = `PATH`, `HOME`, `LANG` only), no network access, read-only filesystem scoped to `semantic/`.
- The explore sandbox has **no path to agent secrets** — this is the critical property.

### Future Architecture (Code Execution)

The code execution tool extends this with credential brokering:

```
┌─────────────────────────────────────────────────┐
│  Agent Harness (Hono API server)                │
│  ┌───────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ explore   │  │executeSQL│  │ runCode     │  │
│  │ (sandbox) │  │(in-proc) │  │ (sandbox)   │  │
│  └─────┬─────┘  └──────────┘  └──────┬──────┘  │
│        │                              │         │
│        │ no network                   │ ┌─────────────────┐
│        │ no secrets                   └─│ Credential Proxy │
│        │ read-only fs                   │ (TLS termination │
│        │                                │  header injection│
│                                         │  domain matching)│
│                                         └────────┬────────┘
│                                                  │
│  Secrets: ATLAS_DATASOURCE_URL,                  │ Injects: Authorization headers
│  API keys, DATABASE_URL                          │ for allowed domains only
│  (never enter any sandbox)                       │
└──────────────────────────────────────────────────┘
```

## Platform Capabilities Matrix

Research conducted Feb 2026 against current platform documentation and community forums.

| Platform | Architecture | User namespaces | `clone()` | nsjail | bwrap | Root access |
|----------|-------------|-----------------|-----------|--------|-------|-------------|
| **Vercel** | Firecracker VM (Sandbox product) | N/A (VM-level isolation) | N/A | N/A | N/A | N/A |
| **Fly.io** | Firecracker microVM | **Likely yes** (full VM with root) | **Likely yes** | **Probable** | **Probable** | Yes |
| **Railway** | Shared-kernel containers | **No** — blocked | **No** — `EPERM` | **No** | **No** | No |
| **Render** | Shared-kernel containers | **No** — blocked | **No** — `EPERM` | **No** | **No** | No |
| **Self-hosted Docker** | Depends on host | With `--privileged` or `--cap-add SYS_ADMIN` | With capabilities | With capabilities | With capabilities | Configurable |
| **Self-hosted VM** | Full kernel | Yes | Yes | Yes | Yes | Yes |

### Railway Details

- [No privileged containers](https://station.railway.com/feedback/allow-services-to-be-run-in-privileged-m-8c66b22b) — feature request open since 2024, no timeline
- No mechanism to add capabilities or modify kernel sysctls
- Employee hinted "Yet" — possible future support, but not planned
- `clone(flags=CLONE_NEWNS|CLONE_NEWCGROUP|...)` returns `EPERM`

### Render Details

- [No privileged mode](https://community.render.com/t/run-docker-container-in-privileged-mode/1814) — "we do not allow Render services to run docker in privileged mode"
- Same shared-kernel model as Railway

### Fly.io Details

- Firecracker microVMs with [full root access](https://community.fly.io/t/passing-params-to-docker-run/2016) — "We don't actually run containers, we extract your app into a VM with full root access"
- Docker `--cap-add` flags don't apply (not Docker), but root in VM should provide equivalent
- Fly's blog [mentions nsjail](https://fly.io/blog/sandboxing-and-workload-isolation/) as a sandboxing approach
- **Needs verification** — no confirmed report of nsjail working on Fly.io

### nsjail With Reduced Namespaces

Investigated whether nsjail could work with a subset of namespaces (e.g., disabling user namespace):

- `--disable_clone_newuser` [requires root](https://github.com/google/nsjail/issues/78) — without user namespace, all other namespace types need `CAP_SYS_ADMIN`
- Disabling ALL namespaces leaves only rlimits + seccomp-bpf — no filesystem isolation, no network isolation, no PID isolation
- **Not viable** — the core value of the sandbox (restricting to `semantic/` only) requires mount namespace at minimum

## Sandbox Tier System

### Current (Explore Only)

```
Tier 1: Vercel Sandbox     — Firecracker VM, deny-all network
Tier 2: nsjail             — Linux namespaces, no network, read-only mount
Tier 3: just-bash          — OverlayFS (in-memory writes), path-traversal protection
```

### Proposed (Explore + Code Execution)

```
Tier 1: Vercel Sandbox     — Full model: VM isolation + credential brokering + live policy updates
Tier 2: Remote sandbox API — E2B, Modal, or similar: Firecracker VMs via API (vendor-neutral)
Tier 3: nsjail             — Linux namespaces (self-hosted Docker/VM). Explore only — no credential brokering
Tier 4: Sidecar service    — HTTP-isolated microservice (Railway/Render). Explore + basic code execution
Tier 5: just-bash          — Dev fallback. Path-traversal protection only
```

## Tier 4: Sidecar Service Design (Railway/Render)

Since no kernel-level sandbox works on Railway/Render, isolation must come from **process/network separation** — a separate service with its own filesystem and no access to the main service's secrets.

### Architecture

```
┌──────────────────────────────────┐     ┌─────────────────────────────┐
│  Main Service (Hono API)         │     │  Sandbox Sidecar            │
│                                  │     │                             │
│  ENV:                            │     │  ENV:                       │
│    ATLAS_DATASOURCE_URL=...      │     │    (none — no secrets)      │
│    ANTHROPIC_API_KEY=...         │     │                             │
│    DATABASE_URL=...              │     │  FILES:                     │
│                                  │     │    /semantic/**/*.yml        │
│  Agent loop calls:               │     │    /usr/bin/python3         │
│    POST http://sandbox:8080/exec │────▶│    numpy, pandas, etc.      │
│      { command, timeout, mode }  │     │                             │
│                                  │     │  EXPOSES:                   │
│  Receives:                       │     │    POST /exec               │
│    { stdout, stderr, exitCode }  │◀────│    POST /health             │
│                                  │     │                             │
└──────────────────────────────────┘     └─────────────────────────────┘
        Railway private network
```

### Security Properties

| Property | How it's achieved |
|----------|-------------------|
| No access to secrets | Sidecar has no env vars with credentials |
| Filesystem isolation | Sidecar only has `semantic/` and runtime deps |
| Network isolation | Sidecar has no outbound internet (Railway private networking only) |
| Resource limits | Railway service resource limits (CPU, memory, timeout) |
| Data ingress | SQL results sent via POST body (not filesystem) |
| Credential brokering | Main service proxies authenticated requests on behalf of sidecar (future) |

### Sidecar API

```
POST /exec
Content-Type: application/json

{
  "command": "cat entities/orders.yml",
  "mode": "shell",           // "shell" (bash) or "python" (future)
  "timeout": 10000,          // ms
  "files": [                 // optional: inject data files for code execution
    { "path": "/tmp/data.csv", "content": "..." }
  ]
}

Response:
{
  "stdout": "...",
  "stderr": "...",
  "exitCode": 0
}
```

### Sidecar Docker Image

Minimal image — no runtime, no secrets, no database drivers:

```dockerfile
FROM python:3.12-slim

# Analysis libraries for code execution mode
RUN pip install --no-cache-dir pandas numpy

# Only tools needed for explore mode
# (python:slim already includes bash, coreutils, grep, find)

# Semantic layer copied at build time or mounted as volume
COPY semantic/ /semantic/

# Tiny HTTP server (could be Hono, Flask, or raw Bun)
COPY sidecar/ /app/
WORKDIR /app
EXPOSE 8080
CMD ["python", "server.py"]
```

### Per-Request Isolation

The sidecar is long-running at the HTTP server level, but each request must be ephemeral at the execution level. Without this, concurrent requests could leak data between users (User A's SQL results visible to User B's code), crashed processes could leave zombie state, and working directories could interfere with each other.

**Pattern: per-request subprocess + temp directory**

```
Sidecar HTTP server (long-running, stateless)
  │
  ├── POST /exec (request A)
  │     → mkdir /tmp/exec-<uuid-a>/
  │     → write data files there (SQL results from request body)
  │     → spawn subprocess (bash/python) with cwd=/tmp/exec-<uuid-a>/
  │     → capture stdout/stderr
  │     → kill on timeout (ulimit enforced)
  │     → rm -rf /tmp/exec-<uuid-a>/
  │     → return response
  │
  ├── POST /exec (request B)        ← completely independent
  │     → mkdir /tmp/exec-<uuid-b>/
  │     → ...
```

Each execution gets:

| Property | How |
|----------|-----|
| Own temp directory | Created fresh per request, deleted after (success or failure) |
| Own subprocess | Separate PID, killed on completion/timeout |
| Own data files | SQL results written to that temp dir only |
| Own resource limits | `ulimit` on the subprocess (CPU time, memory, file size) |
| Shared read-only data | `semantic/` directory — identical for all users, never modified |

The `semantic/` directory is the one shared resource — but it's read-only reference data, not user-specific. This is safe to share.

**Comparison to Vercel Sandbox:** Each `Sandbox.create()` spins up a fresh Firecracker VM, inherently ephemeral. The sidecar version achieves the same property at the process level — less isolation (shared kernel, shared container) but the critical guarantee is preserved: **no cross-request data leakage, no leftover state**.

**Concurrency model:** The sidecar can handle concurrent requests since each spawns its own subprocess in its own temp directory. No request queue needed. The sidecar's CPU/memory limits (set at the Railway/Render service level) provide a natural ceiling on concurrent executions.

### Sidecar Limitations vs. Vercel Sandbox

| Capability | Vercel Sandbox | Sidecar |
|-----------|---------------|---------|
| VM-level isolation | Yes (Firecracker) | No (container, process-level) |
| Per-execution ephemeral | Yes (new VM per sandbox) | Yes (new subprocess + tmpdir per request) |
| Cross-request data leakage | Impossible (separate VMs) | Prevented (separate tmpdirs, cleanup on completion) |
| Credential brokering (TLS termination) | Yes (built-in) | Possible (main service proxies) |
| Live network policy updates | Yes | No (static) |
| Language runtime | Configurable per sandbox | Fixed at build time |
| Cold start | ~1-2s | Near-zero (always running) |
| Cost | Per-execution | Per-service (always-on) |
| Kernel-level isolation | Yes (hypervisor boundary) | No (shared kernel with host) |

### Credential Brokering via Sidecar

For future code execution that needs authenticated API calls (e.g., calling an AI gateway):

```
Sandboxed code → POST /proxy on main service → Main service injects auth header → External API
```

The sidecar doesn't call external APIs directly. Instead, it calls back to the main service's proxy endpoint, which:
1. Validates the request (domain whitelist, method whitelist)
2. Injects the appropriate credential header
3. Forwards to the external service
4. Returns the response to the sidecar

This is architecturally equivalent to Vercel's credential brokering, just implemented at the application layer instead of the network/VM layer. The tradeoff is that the sidecar code could theoretically read the response headers on the way back — but since the sidecar never has the raw secret, it can't use it for exfiltration to arbitrary domains.

## Tier 2: Remote Sandbox API (E2B / Modal)

For deployments that want Vercel Sandbox-grade isolation without being on Vercel:

### E2B (e2b.dev)

- Firecracker VMs via API, designed for AI agent code execution
- Per-execution ephemeral sandboxes
- Python, Node.js, custom runtimes
- Network control (allow/deny)
- File upload/download API
- ~$0.10/hour per sandbox
- **No built-in credential brokering** — would need to implement at application layer

### Integration Surface

The `ExploreBackend` interface already abstracts the execution environment. A remote sandbox backend would implement the same interface:

```typescript
// packages/api/src/lib/tools/explore-e2b.ts (hypothetical)
export async function createE2BBackend(
  semanticRoot: string
): Promise<ExploreBackend> {
  const sandbox = await E2B.Sandbox.create({
    template: "atlas-explore", // pre-built with pandas, numpy
  });

  // Upload semantic files (same as Vercel sandbox pattern)
  const files = collectSemanticFiles(semanticRoot, "semantic");
  await sandbox.filesystem.write(files);

  return {
    exec: async (command) => {
      const result = await sandbox.process.start({ cmd: "sh", args: ["-c", command] });
      await result.wait();
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    close: async () => await sandbox.close(),
  };
}
```

### Updated Backend Selection

```typescript
export type ExploreBackendType =
  | "vercel-sandbox"   // Tier 1
  | "remote-sandbox"   // Tier 2 (E2B, Modal, etc.)
  | "nsjail"           // Tier 3
  | "sidecar"          // Tier 4
  | "just-bash";       // Tier 5

function getExploreBackendType(): ExploreBackendType {
  if (useVercelSandbox()) return "vercel-sandbox";
  if (useRemoteSandbox()) return "remote-sandbox";  // ATLAS_SANDBOX=e2b
  // Explicit nsjail (ATLAS_SANDBOX=nsjail) — hard-fail if unavailable
  if (process.env.ATLAS_SANDBOX === "nsjail" && !_nsjailFailed) return "nsjail";
  if (useSidecar()) return "sidecar";                // ATLAS_SANDBOX_URL=http://...
  // nsjail auto-detect (binary on PATH) — skipped when sidecar is set
  if (!_nsjailFailed && useNsjail()) return "nsjail";
  return "just-bash";
}
```

## Code Execution Tool Design

The code execution tool (`runCode`) is the future tool that makes the sandbox architecture matter beyond explore:

### What It Does

After getting data via `executeSQL`, the agent can write Python to:
- Compute derived metrics (moving averages, percentiles, correlations)
- Clean/transform data (handle nulls, parse dates, pivot)
- Statistical analysis (regression, clustering, anomaly detection)
- Format complex outputs (multi-series charts data, summary tables)

### Tool Definition (Sketch)

```typescript
export const runCode = tool({
  description: "Execute Python code to analyze data. Use after executeSQL to perform " +
    "statistical analysis, transformations, or computations that SQL can't express. " +
    "Available libraries: pandas, numpy. No network access. No database access.",

  inputSchema: z.object({
    code: z.string().describe("Python code to execute"),
    data: z.record(z.string(), z.unknown()).optional()
      .describe("Data to make available as variables (from previous SQL results)"),
  }),

  execute: async ({ code, data }) => {
    const backend = await getCodeExecutionBackend();
    // Write data files, execute code, return output
  },
});
```

### Security for Code Execution

| Threat | Mitigation |
|--------|-----------|
| Arbitrary file read | Sandbox filesystem — only `semantic/` and `/tmp` |
| Secret exfiltration | No secrets in sandbox env. Credential brokering for authorized APIs only |
| Network exfiltration | deny-all (explore) or domain-allowlist (code execution with AI calls) |
| Resource exhaustion | Timeout (10s default), memory limit, process limit |
| Prompt injection → malicious code | Sandbox isolates impact. Code can't reach secrets or host |
| Persistent state across executions | Ephemeral sandbox (Vercel, E2B) or per-request subprocess + tmpdir cleanup (sidecar) |
| Cross-user data leakage | Per-request isolation — each execution gets own tmpdir, subprocess, data files. Shared `semantic/` is read-only |

## Implementation Phases

### Phase 1: Sidecar Explore Backend (v0.8?)

- Build minimal sidecar Docker image (bash + coreutils only)
- Add `explore-sidecar.ts` backend implementing `ExploreBackend`
- Env var: `ATLAS_SANDBOX_URL=http://sandbox-sidecar:8080`
- Update backend selection priority
- Add to `examples/docker/docker-compose.yml` as optional service
- Railway/Render deployment docs

### Phase 2: Code Execution Tool (v0.9?)

- Define `runCode` tool in tool registry
- Python runtime in sandbox (all tiers)
- Data passing (SQL results → sandbox via files/stdin)
- Sidecar gets Python + pandas/numpy in its image

### Phase 3: Credential Brokering (v0.9)

- Proxy endpoint on main service for authenticated outbound calls
- Domain allowlist configuration in `atlas.config.ts`
- Vercel Sandbox uses native `networkPolicy.transform`
- Sidecar/E2B use application-layer proxy
- Ties into #44 (v0.9: Systems of Action — secret injection workstream)

### Phase 4: Remote Sandbox Integration (v1.0?)

- E2B or Modal backend implementing `ExploreBackend`
- `ATLAS_SANDBOX=e2b` with `E2B_API_KEY`
- Same interface, VM-grade isolation, works everywhere

## Configuration

### atlas.config.ts (Future)

```typescript
export default defineConfig({
  sandbox: {
    // Auto-detect (default): Vercel > nsjail > sidecar > just-bash
    backend: "auto",

    // Or explicit:
    // backend: "vercel-sandbox" | "nsjail" | "sidecar" | "e2b" | "just-bash"

    // Sidecar URL (required when backend: "sidecar" or auto-detected)
    sidecarUrl: "http://sandbox-sidecar:8080",

    // E2B config (required when backend: "e2b")
    e2b: {
      apiKey: process.env.E2B_API_KEY,
      template: "atlas-sandbox",
    },

    // Code execution settings
    codeExecution: {
      enabled: true,
      timeout: 30000,        // ms
      memoryLimit: 512,      // MB
    },

    // Credential brokering (Phase 4)
    credentials: {
      "ai-gateway.vercel.sh": {
        headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_TOKEN}` },
      },
    },
  },
});
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_SANDBOX` | auto-detect | Force sandbox backend: `nsjail`, `sidecar`, `e2b` |
| `ATLAS_SANDBOX_URL` | — | Sidecar service URL (enables sidecar backend) |
| `E2B_API_KEY` | — | E2B API key (enables E2B backend) |
| `ATLAS_CODE_EXECUTION` | `false` | Enable the `runCode` tool |

## Background: What is Firecracker?

[Firecracker](https://github.com/firecracker-microvm/firecracker) is an open-source virtual machine monitor (VMM) built by AWS. It creates lightweight microVMs — real virtual machines with their own Linux kernel, but optimized for fast boot (~125ms) and low memory overhead (~5MB per VM). AWS built it to power Lambda and Fargate.

**Why it matters for sandboxing:** A Firecracker microVM provides hardware-level isolation via the hypervisor boundary. Code running inside a microVM literally cannot see the host's memory, processes, or filesystem — it's a different machine as far as the guest kernel is concerned. This is fundamentally stronger than namespace-based isolation (nsjail) or process-based isolation (sidecar), where everything still shares one kernel.

**Who uses Firecracker:**

| Product | How they use it |
|---------|----------------|
| AWS Lambda | Each function invocation runs in a Firecracker microVM |
| AWS Fargate | Container workloads isolated in Firecracker VMs |
| AWS Bedrock AgentCore | Code interpreter runs in dedicated per-session microVMs |
| Fly.io | Every Fly Machine is a Firecracker microVM |
| Vercel Sandbox | `@vercel/sandbox` creates Firecracker VMs for agent code execution |
| E2B | Sandbox product provides Firecracker VMs via API for AI agents |

**Can you run Firecracker yourself?** Technically yes, but it requires bare metal or a VM with nested virtualization support (access to `/dev/kvm`). Container platforms like Railway and Render don't expose KVM — you can't run a hypervisor inside a container that's already on someone else's hypervisor. Running Firecracker directly also means building your own orchestration layer (API, networking, file management, lifecycle). That's exactly what Vercel, E2B, and Fly.io built as their core products. For Atlas, using their SDKs is the practical path.

**Mental model:** Firecracker is to E2B/Vercel Sandbox as the Linux kernel is to Railway. You don't run the kernel yourself — you use a platform that runs it for you and gives you a nice API on top.

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Sidecar over bwrap/firejail | All namespace-based tools fail on Railway/Render. Sidecar uses process separation, not kernel features |
| Application-layer credential proxy over TLS termination | TLS-terminating proxy requires significant infrastructure. App-layer proxy is simpler and achieves the same security property (secrets don't enter sandbox) |
| E2B as Tier 2 over building custom | E2B provides Firecracker VMs via API, purpose-built for this use case. Building our own VM orchestrator is out of scope |
| Phased rollout | Each phase is independently valuable. Explore sidecar helps Railway users now. Code execution and credential brokering build on the same infrastructure |
| `ExploreBackend` interface is correct | The existing interface (`exec(command) → { stdout, stderr, exitCode }`) works for all tiers including sidecar and remote sandbox |
| Per-request subprocess isolation in sidecar | Long-running HTTP server, ephemeral subprocess + tmpdir per request. Prevents cross-user data leakage without requiring per-request container spin-up. `semantic/` shared read-only is safe since it's reference data |
