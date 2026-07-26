---
paths:
  - "ee/**"
  - "packages/api/src/lib/effect/**"
  - "packages/mcp/src/**"
---

# Enterprise and SaaS gating

Full rationale, enforcement mechanics, and the `Tag.available` membership list: [docs/development/enterprise-gating.md](docs/development/enterprise-gating.md).
- [ ] **SaaS-specific features go in `/ee`** — Anything that exists specifically to make Atlas a hosted SaaS (deploy-mode detection, marketplace, residency, masking, SSO/SCIM, approvals, backups, white-labeling) lives in `ee/src/` under the commercial license
- [ ] **Never let core AGPL depend on `/ee`** — in `packages/api/src` exactly one file (`lib/effect/enterprise-layer.ts`) may import `@atlas/ee`; in `packages/mcp/src` only two audited seam files (`MCP_ALLOWED_FILES`). `scripts/check-ee-imports.sh` + `ee-stub-build` enforce it, so a violation is a CI failure, not a review catch
- [ ] **Never import `isEnterpriseEnabled` from `@atlas/ee` in core** — `yield* TheTag` and let the `NoopXxxLayer` short-circuit; value-level checks use the core mirror in `lib/effect/enterprise-config.ts`
- [ ] **Enterprise errors use `EnterpriseError`** — `instanceof`, never string matching. Routes map it to 403. `Tag.available` is for the 404 / shaped-success branch only — omit by default
- [ ] **Deploy mode is enterprise-gated** — `ATLAS_DEPLOY_MODE=saas` requires `/ee`. The commercial license prohibits using `/ee` in a competing product
- [ ] **SaaS-first configuration: env is for secrets + pre-DB boot inputs ONLY** — an operator or workspace admin must never redeploy to change config. A new knob's default home is the **settings registry** (`lib/settings.ts`; precedence `workspace > platform > env > default`, ~30s hot-reload). A new env var needs one of two justifications: it's secret, or the process needs it before the internal DB exists. Non-secret cross-region constants go in `atlas.config.ts` or the [env-profile](packages/api/src/lib/env-profile.ts). Boot contract: `SAAS_ENV_KEYS` in [saas-env.ts](packages/api/src/lib/effect/saas-env.ts); audit + backlog: [saas-env-audit.md](docs/development/saas-env-audit.md)
