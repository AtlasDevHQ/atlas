/* oxlint-disable next/no-img-element -- Satori, not Next.js. The JSX below is
 * never rendered by React: @vercel/og hands it to Satori, whose renderer
 * understands a fixed subset of HTML elements (div, span, img, svg) and has no
 * concept of a component. `next/image` would emit nothing. The rule fires only
 * because this file is .tsx and the nextjs plugin is enabled repo-wide. Scoped
 * to this file so the rule keeps working on every real Next surface. */
/**
 * Generate brand assets for social media (LinkedIn, GitHub, Twitter/X).
 *
 * Usage: bun scripts/generate-brand-assets.tsx
 * Output: apps/www/public/brand/
 *
 * Uses @vercel/og (Satori) — every div MUST have display:flex when it has children.
 */

import { ImageResponse } from "@vercel/og";
import * as fs from "fs";
import * as path from "path";

const BRAND_GREEN = "#23CE9E";
const BG_DARK = "#09090b";
const BG_MID = "#18181b";
const BG_LIGHT = "#27272a";
const TEXT_MUTED = "#a1a1aa";
const TEXT_WHITE = "#fafafa";

const prismSvg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" fill="none"><path d="M128 28 L228 212 L28 212 Z" fill="#23CE9E"/></svg>')}`;

// Every style object gets display:flex by default (Satori requirement)
const flex = { display: "flex" as const };

interface Asset {
  name: string;
  width: number;
  height: number;
  element: React.ReactElement;
  /**
   * Where the file lands, relative to `apps/www/public`. Most assets are
   * brand collateral and default to `brand/`; the Open Graph card is
   * referenced as `/og.png` by every page's metadata, so it writes to the
   * public root.
   */
  dir?: string;
}

/**
 * The launch cycle's sentence, from docs/prd/launch-cycle.md. The Open Graph
 * card is one of the surfaces that renders it, so it is written here in the
 * PRD's words and checked by scripts/check-launch-sentence.sh.
 */
const SENTENCE =
  "Atlas is the company facts your AI agents can trust: every one carries its source, its date, and the name of the person who approved it. Open source, runs in your VPC.";

const assets: Asset[] = [
  // Open Graph / Twitter card — 1200x630. Referenced as `/og.png` by every
  // page's metadata, so it writes to the public root rather than brand/.
  {
    name: "og.png",
    width: 1200,
    height: 630,
    dir: ".",
    element: (
      <div style={{ ...flex, flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 55%, ${BG_LIGHT} 100%)`, fontFamily: "system-ui, sans-serif", padding: "64px 72px" }}>
        <div style={{ ...flex, alignItems: "center", gap: "18px" }}>
          <img src={prismSvg} width={52} height={52} />
          <span style={{ fontSize: "52px", fontWeight: 700, letterSpacing: "-1px", color: TEXT_WHITE }}>atlas</span>
        </div>
        <div style={{ ...flex, flexDirection: "column", gap: "26px" }}>
          <span style={{ fontSize: "44px", fontWeight: 600, lineHeight: 1.22, letterSpacing: "-1px", color: TEXT_WHITE }}>
            {SENTENCE}
          </span>
          <div style={{ ...flex, alignItems: "center", gap: "14px", border: `1px solid ${BG_LIGHT}`, borderRadius: "10px", padding: "14px 20px", background: BG_DARK }}>
            <span style={{ fontSize: "22px", color: BRAND_GREEN, fontFamily: "monospace" }}>$</span>
            <span style={{ fontSize: "22px", color: TEXT_WHITE, fontFamily: "monospace" }}>bunx @useatlas/mcp init --hosted --demo --write</span>
          </div>
        </div>
        <div style={{ ...flex, justifyContent: "space-between", fontSize: "18px", color: TEXT_MUTED }}>
          <span>No account, no email</span>
          <span>useatlas.dev</span>
        </div>
      </div>
    ),
  },

  // GitHub social preview — 1280x640
  {
    name: "github-social.png",
    width: 1280,
    height: 640,
    element: (
      <div style={{ ...flex, flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 50%, ${BG_LIGHT} 100%)`, fontFamily: "system-ui, sans-serif", padding: "60px" }}>
        <div style={{ ...flex, alignItems: "center", gap: "20px" }}>
          <img src={prismSvg} width={64} height={64} />
          <span style={{ fontSize: "64px", fontWeight: 700, letterSpacing: "-1px", color: TEXT_WHITE }}>atlas</span>
        </div>
        <div style={{ ...flex, fontSize: "36px", fontWeight: 600, marginTop: "32px", textAlign: "center", color: TEXT_WHITE }}>
          Deploy-anywhere text-to-SQL data analyst agent
        </div>
        <div style={{ ...flex, gap: "12px", marginTop: "28px", fontSize: "18px", color: TEXT_MUTED }}>
          <span style={{ color: BRAND_GREEN }}>TypeScript</span>
          <span>·</span>
          <span>7 databases</span>
          <span>·</span>
          <span>24 plugins</span>
          <span>·</span>
          <span>Open source</span>
        </div>
        <div style={{ ...flex, position: "absolute", bottom: "40px", fontSize: "16px", color: TEXT_MUTED }}>useatlas.dev</div>
      </div>
    ),
  },

  // LinkedIn post image — 1200x627
  {
    name: "linkedin-post.png",
    width: 1200,
    height: 627,
    element: (
      <div style={{ ...flex, flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 50%, ${BG_LIGHT} 100%)`, fontFamily: "system-ui, sans-serif", padding: "60px" }}>
        <div style={{ ...flex, alignItems: "center", gap: "16px" }}>
          <img src={prismSvg} width={56} height={56} />
          <span style={{ fontSize: "56px", fontWeight: 700, letterSpacing: "-1px", color: TEXT_WHITE }}>atlas</span>
        </div>
        <div style={{ ...flex, flexDirection: "column", alignItems: "center", marginTop: "36px" }}>
          <span style={{ fontSize: "40px", fontWeight: 700, color: TEXT_WHITE, letterSpacing: "-0.5px" }}>Quit copying SQL from ChatGPT</span>
          <span style={{ fontSize: "40px", fontWeight: 700, color: BRAND_GREEN }}>_</span>
        </div>
        <div style={{ ...flex, fontSize: "20px", color: TEXT_MUTED, marginTop: "20px", textAlign: "center" }}>
          Connect your database. Ask questions in plain English. Get validated SQL and results.
        </div>
        <div style={{ ...flex, position: "absolute", bottom: "36px", fontSize: "16px", color: TEXT_MUTED }}>useatlas.dev</div>
      </div>
    ),
  },

  // LinkedIn banner — 1584x396
  {
    name: "linkedin-banner.png",
    width: 1584,
    height: 396,
    element: (
      <div style={{ ...flex, flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 50%, ${BG_LIGHT} 100%)`, fontFamily: "system-ui, sans-serif", padding: "60px 80px" }}>
        <div style={{ ...flex, flexDirection: "column", gap: "16px" }}>
          <div style={{ ...flex, alignItems: "center", gap: "16px" }}>
            <img src={prismSvg} width={48} height={48} />
            <span style={{ fontSize: "48px", fontWeight: 700, letterSpacing: "-1px", color: TEXT_WHITE }}>atlas</span>
          </div>
          <div style={{ ...flex, fontSize: "24px", fontWeight: 600, color: TEXT_MUTED, marginTop: "8px" }}>
            Deploy-anywhere text-to-SQL data analyst agent
          </div>
        </div>
        <div style={{ ...flex, flexDirection: "column", alignItems: "flex-end", gap: "10px", fontSize: "18px", color: TEXT_MUTED }}>
          <span style={{ ...flex }}><span style={{ color: BRAND_GREEN, fontWeight: 600 }}>7</span>&nbsp;databases</span>
          <span style={{ ...flex }}><span style={{ color: BRAND_GREEN, fontWeight: 600 }}>20+</span>&nbsp;plugins</span>
          <span style={{ ...flex }}><span style={{ color: BRAND_GREEN, fontWeight: 600 }}>Open</span>&nbsp;source</span>
          <span style={{ fontSize: "14px", marginTop: "4px" }}>useatlas.dev</span>
        </div>
      </div>
    ),
  },

  // Twitter/X header — 1500x500
  {
    name: "twitter-header.png",
    width: 1500,
    height: 500,
    element: (
      <div style={{ ...flex, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: "60px", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 50%, ${BG_LIGHT} 100%)`, fontFamily: "system-ui, sans-serif", padding: "60px" }}>
        <div style={{ ...flex, alignItems: "center", gap: "16px" }}>
          <img src={prismSvg} width={52} height={52} />
          <span style={{ fontSize: "52px", fontWeight: 700, letterSpacing: "-1px", color: TEXT_WHITE }}>atlas</span>
        </div>
        <div style={{ ...flex, width: "1px", height: "80px", background: "#3f3f46" }} />
        <div style={{ ...flex, flexDirection: "column", gap: "8px" }}>
          <span style={{ fontSize: "28px", fontWeight: 600, color: TEXT_WHITE }}>Text-to-SQL data analyst agent</span>
          <span style={{ fontSize: "18px", color: TEXT_MUTED }}>Open source · Self-hosted or cloud · useatlas.dev</span>
        </div>
      </div>
    ),
  },

  // Square avatar — 400x400
  {
    name: "square-avatar.png",
    width: 400,
    height: 400,
    element: (
      <div style={{ ...flex, flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 50%, ${BG_LIGHT} 100%)`, fontFamily: "system-ui, sans-serif", padding: "40px" }}>
        <img src={prismSvg} width={160} height={160} />
        <span style={{ fontSize: "48px", fontWeight: 700, letterSpacing: "-1px", color: TEXT_WHITE, marginTop: "20px" }}>atlas</span>
      </div>
    ),
  },

  // Square mark only — 400x400
  {
    name: "square-mark.png",
    width: 400,
    height: 400,
    element: (
      <div style={{ ...flex, alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 50%, ${BG_LIGHT} 100%)` }}>
        <img src={prismSvg} width={200} height={200} />
      </div>
    ),
  },

  // Discord server icon — 512x512
  {
    name: "discord-icon.png",
    width: 512,
    height: 512,
    element: (
      <div style={{ ...flex, flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 50%, ${BG_LIGHT} 100%)`, fontFamily: "system-ui, sans-serif" }}>
        <img src={prismSvg} width={200} height={200} />
        <span style={{ fontSize: "56px", fontWeight: 700, letterSpacing: "-1px", color: TEXT_WHITE, marginTop: "24px" }}>atlas</span>
      </div>
    ),
  },

  // GitHub org avatar — 500x500
  {
    name: "github-avatar.png",
    width: 500,
    height: 500,
    element: (
      <div style={{ ...flex, alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: `linear-gradient(145deg, ${BG_DARK} 0%, ${BG_MID} 50%, ${BG_LIGHT} 100%)` }}>
        <img src={prismSvg} width={260} height={260} />
      </div>
    ),
  },

  // PWA icon — 512x512
  {
    name: "pwa-512.png",
    width: 512,
    height: 512,
    element: (
      <div style={{ ...flex, alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: BG_DARK }}>
        <img src={prismSvg} width={320} height={320} />
      </div>
    ),
  },

  // PWA icon — 192x192
  {
    name: "pwa-192.png",
    width: 192,
    height: 192,
    element: (
      <div style={{ ...flex, alignItems: "center", justifyContent: "center", width: "100%", height: "100%", background: BG_DARK }}>
        <img src={prismSvg} width={120} height={120} />
      </div>
    ),
  },

  // Email signature logo — 200x50 horizontal lockup
  {
    name: "email-signature.png",
    width: 200,
    height: 50,
    element: (
      <div style={{ ...flex, alignItems: "center", justifyContent: "center", gap: "8px", width: "100%", height: "100%", background: "white", fontFamily: "system-ui, sans-serif", padding: "6px 12px" }}>
        <img src={prismSvg} width={28} height={28} />
        <span style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.5px", color: "#09090b" }}>atlas</span>
      </div>
    ),
  },

  // Email signature logo (dark bg) — 200x50
  {
    name: "email-signature-dark.png",
    width: 200,
    height: 50,
    element: (
      <div style={{ ...flex, alignItems: "center", justifyContent: "center", gap: "8px", width: "100%", height: "100%", background: BG_DARK, fontFamily: "system-ui, sans-serif", padding: "6px 12px" }}>
        <img src={prismSvg} width={28} height={28} />
        <span style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.5px", color: TEXT_WHITE }}>atlas</span>
      </div>
    ),
  },
];

async function main() {
  const publicDir = path.join(import.meta.dir, "..", "apps", "www", "public");

  for (const asset of assets) {
    const outDir = path.join(publicDir, asset.dir ?? "brand");
    fs.mkdirSync(outDir, { recursive: true });
    process.stdout.write(`  ${asset.dir ?? "brand"}/${asset.name} (${asset.width}x${asset.height})...`);
    const response = new ImageResponse(asset.element, {
      width: asset.width,
      height: asset.height,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(path.join(outDir, asset.name), buffer);
    console.log(" done");
  }

  console.log(`\nGenerated ${assets.length} assets under ${publicDir}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
