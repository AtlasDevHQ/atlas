# DNS for AI Discovery (DNS-AID) — `useatlas.dev`

Runbook for publishing **DNS-based agent discovery** records for the
`useatlas.dev` zone so an agent (or an agent-readiness scanner) can find Atlas's
entry points straight from DNS, before it ever fetches an HTTP `.well-known`
document.

> **Status: experimental.** DNS-AID is an early IETF draft
> ([draft-mozleywilliams-dnsop-dnsaid](https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/)),
> built on the stable SVCB/HTTPS record spec
> ([RFC 9460](https://www.rfc-editor.org/rfc/rfc9460)). The owner-name
> convention (`_agents`) and the core SvcParams (`alpn`, `port`) are stable;
> the enrichment params (`well-known`, `cap`, `policy`, …) are draft-only and
> not yet IANA-registered, so they must be published as experimental `keyNNNNN`
> params and some DNS providers won't accept them. The records below lead with
> the **standards-safe** set (target + `alpn` + `port`) — that's enough for
> entry-point discovery, because the metadata itself is already served over
> HTTPS at the discovered host (`/.well-known/mcp/server-card.json`,
> `/.well-known/agent-skills/index.json`, `/auth.md`, etc.). The draft
> enrichment params are documented as an optional second step.

Skill reference: <https://isitagentready.com/.well-known/agent-skills/dns-aid/SKILL.md>

---

## What we publish

Atlas is MCP-first. The brand MCP surface is `mcp.useatlas.dev` (Streamable
HTTP at `mcp.useatlas.dev/mcp`), the human/brand site is `useatlas.dev`, and the
skills + server-card indexes are served under `useatlas.dev/.well-known/`. So we
publish two entry points under `_agents.useatlas.dev`:

| Owner name | Purpose | Target |
|---|---|---|
| `_mcp._agents.useatlas.dev` | The MCP agent endpoint | `mcp.useatlas.dev` |
| `_index._agents.useatlas.dev` | The org's agent index (skills / server-card) | `useatlas.dev` |

> The draft requires the SVCB **TargetName** to be a real host with no DNS-SD
> underscore labels (public X.509 certs are used in the connection), which both
> `mcp.useatlas.dev` and `useatlas.dev` satisfy.

---

## Records (standards-safe set)

Presentation format (RFC 9460 §2.1). Add these to the `useatlas.dev` zone:

```zone
; --- DNS for AI Discovery (DNS-AID) entry points ---
; MCP agent endpoint (Streamable HTTP at https://mcp.useatlas.dev/mcp)
_mcp._agents.useatlas.dev.   3600 IN SVCB 1 mcp.useatlas.dev. (
                                  alpn="mcp,h2"
                                  port=443 )

; Organization agent index (skills + server-card served under /.well-known)
_index._agents.useatlas.dev. 3600 IN SVCB 1 useatlas.dev. (
                                  alpn="h2,http/1.1"
                                  port=443 )
```

Notes:

- **Priority `1`** = ServiceMode (a usable endpoint), not AliasMode (`0`).
- **`alpn="mcp,h2"`** — `h2` is the real TLS ALPN transport. `mcp` is the
  agent-protocol token the draft carries in `alpn`; it is **not** an
  IANA-registered ALPN id, so resolvers treat it as an opaque token. One
  protocol suite per record — if Atlas later serves A2A, add a **separate**
  `_a2a._agents.useatlas.dev` SVCB record rather than a second protocol in this
  `alpn`.
- **TTL 3600** — modest so a target/protocol change propagates within the hour.

### Optional: draft enrichment params

Once you want DNS to point directly at the metadata document (rather than
letting the agent derive `/.well-known/...` from the host), add the draft's
`well-known` param. It is unregistered, so it must go out as an experimental
key. Example intent (draft presentation):

```zone
_mcp._agents.useatlas.dev. 3600 IN SVCB 1 mcp.useatlas.dev. (
                                alpn="mcp,h2" port=443
                                well-known="mcp/server-card.json" )
```

`well-known="mcp/server-card.json"` means "fetch
`https://mcp.useatlas.dev/.well-known/mcp/server-card.json`". If your DNS
provider rejects the `well-known=` keyword, encode it as the experimental
`keyNNNNN` form once the draft assigns a number, or **skip it** — the standards-
safe records above are sufficient for discovery.

---

## Applying in Cloudflare (registrar for `useatlas.dev`)

Cloudflare supports the SVCB record type in the dashboard and API.

1. **Dashboard** → `useatlas.dev` → **DNS** → **Records** → **Add record**.
2. **Type**: `SVCB`. **Name**: `_mcp._agents` (Cloudflare appends the zone).
3. **Value**: enter the SVCB rdata — `1 mcp.useatlas.dev. alpn="mcp,h2" port=443`.
   - If the UI splits fields, set **Priority** `1`, **Target** `mcp.useatlas.dev`,
     and the SvcParams (`alpn`, `port`) in the params section.
   - Leave **Proxy status** = **DNS only** (grey cloud). Proxying an SVCB
     record through Cloudflare's edge would rewrite the answer.
4. Repeat for `_index._agents` → target `useatlas.dev`.
5. If Cloudflare rejects a custom param (e.g. `well-known`), drop it and ship the
   standards-safe record; the param is optional enrichment.

Via the API (SVCB `type` is `64`):

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data '{
    "type": "SVCB",
    "name": "_mcp._agents.useatlas.dev",
    "data": { "priority": 1, "target": "mcp.useatlas.dev", "value": "alpn=\"mcp,h2\" port=443" },
    "ttl": 3600
  }'
```

---

## DNSSEC — sign the zone

DNS-AID consumers "SHOULD validate DNSSEC and SHOULD refuse to act on bogus or
unverifiable records", so the discovery data must be authenticated.

1. Cloudflare → `useatlas.dev` → **DNS** → **Settings** → **DNSSEC** → **Enable
   DNSSEC**. Cloudflare shows a **DS record** (key tag, algorithm, digest type,
   digest).
2. Add that **DS record at the domain registrar** (where `useatlas.dev` is
   registered — the parent zone). This is the step that actually turns on the
   chain of trust; enabling in Cloudflare alone is not enough.
3. Wait for the registrar's DS to propagate (minutes to a couple hours), then
   verify the `AD` (Authenticated Data) flag is set (below).

If Atlas later adds DANE TLSA records for the targets, those **MUST** be signed
(they only ride the DNSSEC chain you just established).

---

## Verify

```bash
# The SVCB records resolve:
dig +short SVCB _mcp._agents.useatlas.dev
dig +short SVCB _index._agents.useatlas.dev

# DNSSEC authenticates them — look for the `ad` flag in the header:
dig +dnssec SVCB _mcp._agents.useatlas.dev | grep -E 'flags:|SVCB'

# Same over DNS-over-HTTPS (what an agent behind a DoH resolver sees):
curl -sS -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=_mcp._agents.useatlas.dev&type=SVCB' | jq

# Chain-of-trust sanity check (external validator):
#   https://dnssec-analyzer.verisignlabs.com/useatlas.dev
```

A healthy result: the `dig +dnssec` answer header contains `flags: qr rd ra ad`
(the **`ad`** flag = validated), and the SVCB answer names the expected target +
`alpn`/`port`.

---

## Caveats & rollback

- **Early draft.** The `_agents` convention may change before the draft
  stabilizes; keep the TTL modest and revisit when the draft advances or IANA
  registers the SvcParamKeys.
- **No app dependency.** Nothing in the Atlas codebase reads these records —
  they're pure infra discovery metadata. Removing them (delete the two SVCB
  records) is a safe, instant rollback with no code impact.
- **Keep in sync with the HTTP surface.** If the MCP host or the brand apex ever
  moves, update the SVCB **TargetName** here too — DNS-AID is the DNS mirror of
  the same entry points `apps/www` serves at `/.well-known/*` and `/auth.md`.
