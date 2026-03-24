# Sandbox Architecture

> Design doc for platform-agnostic code execution sandboxing in Atlas.

## Problem

Atlas needs isolated code execution for two purposes:

1. **Explore tool** — run shell commands (`ls`, `cat`, `grep`) against the semantic layer YAML files. Read-only, no network, no secrets needed.

2. **Python execution tool** — run agent-generated Python to analyze data retrieved via SQL. Needs a runtime (Python + pandas/numpy/matplotlib), must not have direct access to secrets.

The explore tool works on Vercel (Firecracker VM) and on Linux with nsjail. It fails on **Railway** because the platform runs shared-kernel containers that block `clone()` with namespace flags — no `CAP_SYS_ADMIN`, no unprivileged user namespaces. Both bubblewrap (bwrap) and firejail hit the same wall. This is a fundamental platform limitation, not a configuration issue.

## Threat Model: Who Needs What

Not every deployment needs the same level of sandbox isolation. The right tier depends on your trust model:

### Self-hosted / single-tenant (company deploys Atlas for their own team)

The agent and all its users are employees operating within the same trust boundary. The LLM provider (Anthropic, OpenAI) is the only external party. In this model:

- **Prompt injection is the main risk** — a crafted value in the database or semantic layer could influence the agent's behavior. But the agent's tools are already scoped: `executeSQL` is SELECT-only with table whitelisting, and `explore` only reads YAML files. Even a successful injection can't write data, access secrets, or reach the network.
- **There's no untrusted multi-tenant boundary** — User A and User B are both employees with legitimate access to the same data. Cross-user isolation is a nice-to-have, not a security requirement.
- **nsjail or the sidecar is plenty** — you're defending against accidental damage or a particularly creative prompt injection, not against a hostile tenant trying to escape a VM.
- **just-bash is acceptable** — if you run Atlas on a private network, behind VPN, with `ATLAS_API_KEY` auth, the explore tool reading YAML files via `just-bash` with path-traversal protection is a reasonable posture.

### Multi-tenant SaaS / public-facing (Atlas serves users from different organizations)

Now you have real trust boundaries. User A should not be able to influence User B's queries or data. The LLM might process attacker-controlled input (e.g., data from a user's database that contains injection payloads). In this model:

- **Sandbox isolation is critical** — generated code (explore commands, Python analysis) must run in its own security context with no path to secrets or other users' data.
- **Credential brokering matters** — if the code execution tool needs to call external APIs, secrets must be injected at the network layer, never visible inside the sandbox.
- **Firecracker (Vercel Sandbox, E2B) is the right answer** — hardware-level VM isolation, ephemeral per execution, impossible for one tenant's code to see another's memory or filesystem.
- **The sidecar is a step down** — process isolation within a shared container is weaker than VM isolation. It prevents cross-request data leakage (separate tmpdirs, separate subprocesses) but doesn't provide a hypervisor boundary.

### The spectrum

```
                        More isolation -->

Self-hosted,        Self-hosted,       Multi-tenant      Multi-tenant
private network     public-facing      (internal)        SaaS

+----------+      +----------+      +----------+      +----------+
| just-bash|      |  nsjail  |      | sidecar  |      | Vercel   |
| or       |      |  or      |      | or E2B   |      | Sandbox  |
| sidecar  |      | sidecar  |      | or       |      | or E2B / |
|          |      |          |      | Daytona  |      | Daytona  |
+----------+      +----------+      +----------+      +----------+
  Tier 3-4           Tier 2-3         Plugin/Tier 3      Tier 1/Plugin
```

Atlas auto-detects the best available tier and falls back gracefully. You can override with `ATLAS_SANDBOX` if you need a specific guarantee.

## Security Model

Reference: [Vercel — Security boundaries in agentic architectures](https://vercel.com/blog/security-boundaries-in-agentic-architectures)

### Four Actors

| Actor | Atlas equivalent | Trust level |
|-------|-----------------|-------------|
| Agent harness | Hono API + `streamText` loop | Trusted (deployed via SDLC) |
| Agent secrets | `ATLAS_DATASOURCE_URL`, API keys, `DATABASE_URL` | Must never enter sandbox |
| Generated code | `explore` commands, `executePython` code | Untrusted (prompt-injectable) |
| Filesystem / environment | Host OS, `semantic/` directory | Protected from generated code |

### Architecture

Atlas follows the recommended architecture for both tools:

- **Agent harness** holds all secrets. The agent never sees connection strings.
- **`executeSQL`** runs in the harness — the agent invokes it as a scoped tool, the harness validates SQL through 4 layers, then executes it with the DB connection it manages.
- **`explore`** runs in a sandbox with no secrets (`JAIL_ENV` = `PATH`, `HOME`, `LANG` only), no network access, read-only filesystem scoped to `semantic/`.
- **`executePython`** runs in a sandbox with Python + data science libraries. SQL results are passed in via stdin (not filesystem). No database drivers, no API keys, no connection strings.
- Both sandboxes have **no path to agent secrets** — this is the critical property.

```
+--------------------------------------------------+
|  Agent Harness (Hono API server)                  |
|  +----------+  +-----------+  +----------------+ |
|  | explore  |  |executeSQL |  |executePython   | |
|  | (sandbox)|  | (in-proc) |  | (sandbox)      | |
|  +----+-----+  +-----------+  +-------+--------+ |
|       |                               |           |
|       | no network                    | no network|
|       | no secrets                    | no secrets|
|       | read-only fs                  | data via  |
|       |                               | stdin only|
|                                                   |
|  Secrets: ATLAS_DATASOURCE_URL,                   |
|  API keys, DATABASE_URL                           |
|  (never enter any sandbox)                        |
+---------------------------------------------------+
```

## Sandbox Tier System

### Built-in Backends

```
Tier 1: Vercel Sandbox     -- Firecracker VM, deny-all network
Tier 2: nsjail             -- Linux namespaces, no network, read-only mount
Tier 3: Sidecar service    -- HTTP-isolated container with no secrets (Railway)
Tier 4: just-bash          -- OverlayFS (in-memory writes), path-traversal protection
```

### Sandbox Plugins

Two additional sandbox backends are available as plugins (installed via `atlas.config.ts`). Plugins are priority-sorted and checked before the built-in chain:

| Plugin | Package | Priority | Isolation | Install |
|--------|---------|----------|-----------|---------|
| **E2B** | `plugins/e2b/` | 90 | Firecracker microVM (managed) | `bun add e2b` |
| **Daytona** | `plugins/daytona/` | 85 | Cloud-hosted ephemeral sandbox | `bun add @daytonaio/sdk` |

```typescript
// atlas.config.ts
import { defineConfig } from "@atlas/api/lib/config";
import { e2bSandboxPlugin } from "@useatlas/e2b";

export default defineConfig({
  plugins: [
    e2bSandboxPlugin({ apiKey: process.env.E2B_API_KEY! }),
  ],
});
```

When a sandbox plugin is active, it takes precedence over all built-in backends. This lets any deployment (Railway, Docker, etc.) get VM-grade isolation without Vercel.

### Runtime Selection Priority

```typescript
export type ExploreBackendType =
  | "plugin"          // Sandbox plugin (priority-sorted)
  | "vercel-sandbox"  // Tier 1
  | "nsjail"          // Tier 2
  | "sidecar"         // Tier 3
  | "just-bash";      // Tier 4

function getExploreBackendType(): ExploreBackendType {
  if (activeSandboxPlugin) return "plugin";
  if (useVercelSandbox()) return "vercel-sandbox";
  // Explicit nsjail (ATLAS_SANDBOX=nsjail) -- hard-fail if unavailable
  if (process.env.ATLAS_SANDBOX === "nsjail") return "nsjail";
  // Sidecar (ATLAS_SANDBOX_URL set)
  if (useSidecar()) return "sidecar";
  // nsjail auto-detect (binary on PATH)
  if (useNsjail()) return "nsjail";
  return "just-bash";
}
```

### What Each Tier Supports

| Capability | Vercel Sandbox | E2B / Daytona (plugin) | nsjail | Sidecar | just-bash |
|-----------|---------------|----------------------|--------|---------|-----------|
| `explore` (shell) | Yes | Yes | Yes | Yes | Yes |
| `executePython` | Yes | Yes | Yes | Yes | Yes |
| VM-level isolation | Yes (Firecracker) | Yes (managed) | No | No | No |
| Kernel namespace isolation | N/A | N/A | Yes | No | No |
| Process isolation | N/A | N/A | Yes | Yes (separate container) | No |
| No secrets in sandbox | Yes | Yes | Yes | Yes (separate env) | No (same process) |
| No network | Yes (deny-all) | Yes (isolated) | Yes | Yes (private networking only) | No |
| Per-execution ephemeral | Yes (new VM) | Yes (new sandbox) | Yes (new namespace) | Yes (new subprocess + tmpdir) | No |

## Platform Capabilities

| Platform | Architecture | User namespaces | nsjail | Sidecar | Best tier |
|----------|-------------|-----------------|--------|---------|-----------|
| **Vercel** | Firecracker VM | N/A | N/A | N/A | Tier 1 (Vercel Sandbox) |
| **Railway** | Shared-kernel containers | No | No | Yes | Tier 3 (Sidecar) |
| **Self-hosted Docker** | Depends on host | With capabilities | With capabilities | Optional | Tier 2 (nsjail) |
| **Self-hosted VM** | Full kernel | Yes | Yes | Optional | Tier 2 (nsjail) |

### Why Railway Can't Run nsjail

Railway runs shared-kernel containers that block the syscalls nsjail needs:
- [No privileged containers](https://station.railway.com/feedback/allow-services-to-be-run-in-privileged-m-8c66b22b) — feature request open since 2024, no timeline
- No mechanism to add capabilities or modify kernel sysctls
- `clone(flags=CLONE_NEWNS|CLONE_NEWCGROUP|...)` returns `EPERM`
- nsjail with `--disable_clone_newuser` [requires root](https://github.com/google/nsjail/issues/78) — not viable without `CAP_SYS_ADMIN`

This is why the sidecar exists: isolation via container separation instead of kernel namespaces.

## Sidecar Service Design

Since no kernel-level sandbox works on Railway, isolation comes from **process/network separation** — a separate service with its own filesystem and no access to the main service's secrets.

### Architecture

```
+----------------------------------+     +-----------------------------+
|  Main Service (Hono API)         |     |  Sandbox Sidecar            |
|                                  |     |                             |
|  ENV:                            |     |  ENV:                       |
|    ATLAS_DATASOURCE_URL=...      |     |    SIDECAR_AUTH_TOKEN=...   |
|    ANTHROPIC_API_KEY=...         |     |    (no DB creds, no API     |
|    DATABASE_URL=...              |     |     keys, no secrets)       |
|                                  |     |                             |
|  Agent loop calls:               |     |  FILES:                     |
|    POST http://sidecar:8080/exec |---->|    /semantic/**/*.yml       |
|    POST .../exec-python          |     |    python3 + pandas/numpy   |
|                                  |     |                             |
|  Receives:                       |     |  ENDPOINTS:                 |
|    { stdout, stderr, exitCode }  |<----|    GET  /health             |
|    or PythonResult               |     |    POST /exec               |
|                                  |     |    POST /exec-python        |
+----------------------------------+     +-----------------------------+
        Railway private network
```

### Security Properties

| Property | How it's achieved |
|----------|-------------------|
| No access to secrets | Sidecar env has no database credentials or API keys |
| Filesystem isolation | Sidecar only has `semantic/` (read-only) and runtime deps |
| Network isolation | Railway private networking only — no outbound internet |
| Resource limits | Railway service resource limits (CPU, memory) + per-request timeouts |
| Per-request isolation | Each request gets its own subprocess + temp directory, cleaned up after |
| Auth between services | `SIDECAR_AUTH_TOKEN` shared secret (Bearer token) |

### Sidecar API

**Shell execution** (`explore` tool):

```
POST /exec
Authorization: Bearer <SIDECAR_AUTH_TOKEN>
Content-Type: application/json

{ "command": "cat entities/orders.yml", "timeout": 10000 }

Response: { "stdout": "...", "stderr": "...", "exitCode": 0 }
```

**Python execution** (`executePython` tool):

```
POST /exec-python
Authorization: Bearer <SIDECAR_AUTH_TOKEN>
Content-Type: application/json

{
  "code": "import pandas as pd\nprint(df.describe())",
  "data": { "columns": ["id", "amount"], "rows": [[1, 100], [2, 200]] },
  "timeout": 30000
}

Response: {
  "success": true,
  "output": "...",
  "table": { "columns": [...], "rows": [...] },
  "rechartsCharts": [...],
  "charts": [{ "base64": "...", "mimeType": "image/png" }]
}
```

### Sidecar Dockerfile

Minimal image — no secrets, no database drivers:

```dockerfile
FROM oven/bun:1.3.11-debian AS base

# Shell tools for explore + Python for executePython
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash coreutils grep findutils tree \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Data science libraries
RUN pip3 install --no-cache-dir --break-system-packages \
    pandas numpy matplotlib scipy scikit-learn statsmodels

# Semantic layer baked in at build time
COPY semantic/ /semantic/
RUN chmod -R a-w /semantic/

# Sidecar server (Bun)
COPY packages/sandbox-sidecar/src/ ./src/
EXPOSE 8080
USER nobody
CMD ["bun", "run", "src/server.ts"]
```

### Per-Request Isolation

The sidecar is long-running at the HTTP server level, but each request is ephemeral at the execution level:

```
Sidecar HTTP server (long-running, stateless)
  |
  +-- POST /exec (request A)
  |     -> mkdir /tmp/exec-<uuid-a>/
  |     -> spawn bash subprocess with cwd=/semantic, HOME=/tmp/exec-<uuid-a>/
  |     -> capture stdout/stderr, kill on timeout
  |     -> rm -rf /tmp/exec-<uuid-a>/
  |     -> return response
  |
  +-- POST /exec-python (request B)
  |     -> mkdir /tmp/pyexec-<uuid-b>/charts/
  |     -> write user_code.py + wrapper.py
  |     -> pipe SQL data via stdin
  |     -> spawn python3, extract structured result via marker line
  |     -> collect chart PNGs, clean up
  |     -> return PythonResult
```

Each execution gets its own temp directory, subprocess, and data files. The shared `semantic/` directory is read-only reference data — safe to share across requests.

**Concurrency:** Up to 10 concurrent executions. Requests beyond the limit get HTTP 429.

### Sidecar vs. Vercel Sandbox

| Capability | Vercel Sandbox | Sidecar |
|-----------|---------------|---------|
| VM-level isolation | Yes (Firecracker) | No (container, process-level) |
| Per-execution ephemeral | Yes (new VM per sandbox) | Yes (new subprocess + tmpdir per request) |
| Cross-request data leakage | Impossible (separate VMs) | Prevented (separate tmpdirs, cleanup on completion) |
| Language runtime | Configurable per sandbox | Fixed at build time |
| Cold start | ~1-2s | Near-zero (always running) |
| Cost | Per-execution | Per-service (always-on) |
| Kernel-level isolation | Yes (hypervisor boundary) | No (shared kernel with host) |

### Python Security (All Tiers)

The `executePython` tool has defense-in-depth across all sandbox backends:

| Layer | Mechanism |
|-------|-----------|
| **API-side validation** | AST parse + import/builtin blocklist before sending to sandbox |
| **Sidecar-side validation** | Independent AST parse + blocklist (defense-in-depth) |
| **Blocked imports** | `subprocess`, `os`, `socket`, `shutil`, `http`, `urllib`, `requests`, `pickle`, `pathlib`, etc. |
| **Blocked builtins** | `exec`, `eval`, `compile`, `__import__`, `open`, `getattr`, `globals`, etc. |
| **Isolated namespace** | User code runs via `exec()` in a restricted dict — can't see wrapper variables |
| **No secrets in env** | Sandbox process env contains only `PATH`, `HOME`, `LANG`, `TMPDIR`, `MPLBACKEND` |
| **Result marker** | Per-execution random UUID marker prevents stdout spoofing |
| **Timeout** | SIGKILL (uncatchable) after configurable deadline |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_SANDBOX` | auto-detect | Force sandbox backend: `nsjail` |
| `ATLAS_SANDBOX_URL` | -- | Sidecar service URL (enables sidecar backend) |
| `SIDECAR_AUTH_TOKEN` | -- | Shared secret for sidecar auth (set on both services) |
| `ATLAS_NSJAIL_PATH` | -- | Explicit path to nsjail binary |
| `ATLAS_NSJAIL_TIME_LIMIT` | `10` | nsjail per-command time limit in seconds |
| `ATLAS_NSJAIL_MEMORY_LIMIT` | `256` | nsjail per-command memory limit in MB |

## Future: Credential Brokering

For code execution that needs authenticated API calls (e.g., calling an AI gateway from Python):

```
Sandboxed code -> POST /proxy on main service -> Main service injects auth header -> External API
```

The sidecar doesn't call external APIs directly. Instead, it calls back to the main service's proxy endpoint, which validates the request (domain whitelist), injects the appropriate credential header, and forwards to the external service. This is architecturally equivalent to Vercel's credential brokering, implemented at the application layer instead of the network/VM layer.

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Sidecar over bwrap/firejail | All namespace-based tools fail on Railway. Sidecar uses container separation, not kernel features |
| E2B and Daytona as plugins, not built-in | Keeps core lightweight. Users opt in via `atlas.config.ts` and install the SDK they need. Plugin priority system lets them override built-in backends |
| Per-request subprocess isolation | Long-running HTTP server, ephemeral subprocess + tmpdir per request. Prevents cross-user data leakage without requiring per-request container spin-up |
| AST-based Python validation on both sides | Defense-in-depth: API validates before sending, sidecar validates again. Belt and suspenders |
| Bun for sidecar HTTP server | Same runtime as the rest of Atlas. Python is installed for user code execution, not the server |
| `ExploreBackend` interface is correct | The existing interface (`exec(command) -> { stdout, stderr, exitCode }`) works for all tiers including plugins |

## Background: What is Firecracker?

[Firecracker](https://github.com/firecracker-microvm/firecracker) is an open-source virtual machine monitor (VMM) built by AWS. It creates lightweight microVMs — real virtual machines with their own Linux kernel, optimized for fast boot (~125ms) and low memory overhead (~5MB per VM). AWS built it to power Lambda and Fargate.

**Why it matters for sandboxing:** A Firecracker microVM provides hardware-level isolation via the hypervisor boundary. Code running inside a microVM literally cannot see the host's memory, processes, or filesystem — it's a different machine as far as the guest kernel is concerned. This is fundamentally stronger than namespace-based isolation (nsjail) or process-based isolation (sidecar), where everything still shares one kernel.

**Who uses Firecracker:**

| Product | How they use it |
|---------|----------------|
| AWS Lambda | Each function invocation runs in a Firecracker microVM |
| AWS Fargate | Container workloads isolated in Firecracker VMs |
| Vercel Sandbox | `@vercel/sandbox` creates Firecracker VMs for agent code execution |
| E2B | Sandbox product provides Firecracker VMs via API for AI agents |

**Can you run Firecracker yourself?** Technically yes, but it requires bare metal or a VM with nested virtualization support (access to `/dev/kvm`). Container platforms like Railway don't expose KVM — you can't run a hypervisor inside a container that's already on someone else's hypervisor. That's exactly what Vercel and E2B built as their core products. For Atlas, using their SDKs is the practical path.
