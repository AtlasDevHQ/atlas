# Atlas Logo Assets

## Files

| File | Use Case |
|------|----------|
| `atlas-mark-dark.svg` | Full detail mark on dark backgrounds |
| `atlas-mark-light.svg` | Full detail mark on light backgrounds |
| `atlas-mark-mono-white.svg` | Single-color white (dark bg, print) |
| `atlas-mark-mono-black.svg` | Single-color black (light bg, print) |
| `atlas-mark-simplified.svg` | Reduced detail for small display |
| `atlas-favicon.svg` | Solid fill for favicons and tabs |

## Size Guidelines

These are recommendations — the simplified stroke variant may be preferred for inline UI elements regardless of size.

- **≥128px** → Full detail with inner rays, strata, and base nodes
- **64px** → Reduced: drop diagonal rays and base nodes, keep center ray and apex
- **24–48px** → Simplified: outline stroke + apex circle (`atlas-mark-simplified.svg`)
- **≤16px** → Solid filled triangle (`atlas-favicon.svg`)

> **Note:** The favicon SVG uses a slightly different (more compact) triangle geometry for optical compensation at small sizes.

## Colors

| Name | Hex | Usage |
|------|-----|-------|
| Primary | `#23CE9E` | Default mark color |
| Primary Dark | `#1A9B76` | Light-bg variant, gradient end |
| Deep | `#148060` | Accent/hover states (UI only — not used in logo SVGs) |
| Dark Surface | `#0C0C10` | Recommended dark background |
| Light Surface | `#F6F6F8` | Recommended light background |
