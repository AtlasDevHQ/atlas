---
paths:
  - "semantic/**"
  - "packages/api/src/lib/semantic/**"
---

# Semantic layer

- [ ] **YAML format** — Entity files define columns, types, sample values, joins, virtual dimensions, measures, query patterns (`EntityShape` in `packages/api/src/lib/semantic/shapes.ts`). Group-scoped directory layout per [ADR-0012](docs/adr/0012-group-scoped-semantic-layer-directories.md) — see **Table whitelist** above
- [ ] **Metrics are authoritative** — SQL in `metrics/*.yml` must be used exactly as written
- [ ] **Glossary terms** — Terms marked `ambiguous` in `glossary.yml` should trigger clarifying questions

## Entity YAML

Entity files define columns, types, sample values, joins, virtual dimensions, measures, query patterns. See `semantic/entities/*.yml` (and `semantic/groups/<group>/entities/`) + `EntityShape` in `packages/api/src/lib/semantic/shapes.ts`.
