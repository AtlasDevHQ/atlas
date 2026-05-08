# Atlas Brand Assets

Canonical brand assets for Atlas DevHQ. Used for catalog submissions (Claude Desktop directory, mcp.so, registry.modelcontextprotocol.io), partner pages, swag, social embeds, and email signatures.

## Color tokens

The single source of truth lives at [`apps/www/brand.css`](../../brand.css) and is consumed by all three frontends (`apps/www`, `apps/docs`, `packages/web`):

| Token | Value | Use |
| --- | --- | --- |
| `--atlas-brand` | `oklch(0.759 0.148 167.71)` ≈ `#23CE9E` | Primary brand green. The triangle, primary buttons, focus rings. |
| `--atlas-brand-hover` | `oklch(0.82 0.148 167.71)` | Hover/active state on brand-colored interactive elements. |
| `--atlas-brand-foreground` | `oklch(0.145 0 0)` | Text/icon color on brand-colored backgrounds. |

Hex equivalents for catalog forms that don't take OKLCH: **`#23CE9E`** (primary), **`#3FE3B0`** (hover), **`#0A0A0A`** (on-brand foreground).

## Logo files

All assets live in this directory. Transparent backgrounds unless otherwise noted.

| File | Dimensions | Format | Intended use |
| --- | --- | --- | --- |
| `mark.svg` | 1024×1024 viewBox | SVG | Source of truth — render to any size. |
| `mark-1024.png` | 1024×1024 | PNG (RGBA) | Catalog submissions (Anthropic + others), partner pages. |
| `pwa-512.png` | 512×512 | PNG (RGBA) | PWA install icon (high-res). |
| `pwa-192.png` | 192×192 | PNG (RGBA) | PWA install icon (standard). |
| `square-mark.png` | 400×400 | PNG (RGBA) | Generic square mark for embeds. |
| `square-avatar.png` | 400×400 | PNG (RGBA) | Avatar variant (use for profile pics on third-party services). |
| `github-avatar.png` | 500×500 | PNG (RGBA) | GitHub org/user avatar. |
| `github-social.png` | 1280×640 | PNG (RGBA) | GitHub repo social card. |
| `discord-icon.png` | 512×512 | PNG (RGBA) | Discord server icon. |
| `linkedin-banner.png` | 1584×396 | PNG (RGBA) | LinkedIn company page banner. |
| `linkedin-post.png` | 1200×627 | PNG (RGBA) | LinkedIn post card. |
| `twitter-header.png` | 1500×500 | PNG (RGBA) | X/Twitter profile header. |
| `email-signature.png` | 200×50 | PNG (RGBA) | Email signature (light theme). |
| `email-signature-dark.png` | 200×50 | PNG (RGBA) | Email signature (dark theme). |

The favicon used in-app is [`apps/www/src/app/icon.svg`](../../src/app/icon.svg) (256 viewBox); it's the same triangle as `mark.svg` at a smaller scale.

## Re-rendering from `mark.svg`

Need a different size? Render from the SVG (no manual asset rebuilds):

```bash
bun x svgexport@0.4.2 mark.svg mark-<N>.png <N>:<N>
```

Output is RGBA with transparent background. Drop the new file into this directory and add a row to the table above so future submissions know it exists.

## Brand voice (one paragraph for catalog forms)

> Atlas is a deploy-anywhere text-to-SQL data analyst agent. It connects to your data warehouse over a semantic layer (typed entities, joins, metrics, glossary) and validated SQL execution (4-layer parser + table whitelist + auto-LIMIT + statement timeout) so an AI agent can answer business questions without hallucinating tables, joining wrong, or running unbounded scans. Self-hosted under AGPL-3.0; hosted SaaS at app.useatlas.dev.

Drop this into long-description fields verbatim or trim to fit the form's word count. Pair with the catalog tool annotations at [`apps/docs/content/docs/architecture/mcp-tool-annotations.mdx`](../../../../apps/docs/content/docs/architecture/mcp-tool-annotations.mdx) for the per-tool entries on MCP catalog forms.

## Out of scope (intentionally)

- Loom/YouTube hosting of demo videos — operator-side, doesn't belong in repo.
- One-off campaign assets (event banners, conference swag) — produced ad-hoc and not committed.
- Press kit (founder photos, exec bios) — lives in the marketing CMS, not here.
