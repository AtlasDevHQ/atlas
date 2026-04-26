/* Shared chrome — nav + footer + glyph + design tokens used across www routes */

const AtlasGlyph = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--atlas-brand)" strokeWidth="1.8">
    <path d="M12 3L3 20h18L12 3z" />
    <circle cx="12" cy="3" r="1.6" fill="var(--atlas-brand)" />
  </svg>
);

const AtlasNav = ({ active = "" }) => {
  const link = (key, label, href) => (
    <a href={href} style={{ ...wwwStyles.navLink, ...(active === key ? wwwStyles.navLinkActive : {}) }}>{label}</a>
  );
  return (
    <nav style={wwwStyles.nav}>
      <div style={wwwStyles.navLeft}>
        <a href="Atlas Landing — Final.html" style={wwwStyles.brandLink}>
          <AtlasGlyph />
          <span style={wwwStyles.brand}>atlas</span>
        </a>
        <span style={wwwStyles.tag}>v0.94 · MIT</span>
      </div>
      <div style={wwwStyles.navMid}>
        {link("product", "product", "Atlas Landing — Final.html")}
        {link("docs", "docs", "www/docs.html")}
        {link("pricing", "pricing", "www/pricing.html")}
        {link("changelog", "changelog", "www/changelog.html")}
      </div>
      <div style={wwwStyles.navRight}>
        <a href="https://github.com/useatlas" style={wwwStyles.navLink}>github ★ 4.2k</a>
        <a href="www/sign-in.html" style={wwwStyles.navLink}>sign in</a>
        <button style={wwwStyles.cta}>start 14-day trial</button>
      </div>
    </nav>
  );
};

const AtlasFooter = () => (
  <footer style={wwwStyles.foot}>
    <div style={wwwStyles.footRow}>
      <div style={wwwStyles.footL}>
        <AtlasGlyph />
        <span style={wwwStyles.footBrand}>atlas</span>
        <span style={wwwStyles.footTag}>text-to-sql, that actually runs</span>
      </div>
      <div style={wwwStyles.footCols}>
        <div>
          <div style={wwwStyles.footHead}>product</div>
          <a href="Atlas Landing — Final.html" style={wwwStyles.footLink}>features</a>
          <a href="www/pricing.html" style={wwwStyles.footLink}>pricing</a>
          <a href="www/changelog.html" style={wwwStyles.footLink}>changelog</a>
          <a href="www/status.html" style={wwwStyles.footLink}>status</a>
        </div>
        <div>
          <div style={wwwStyles.footHead}>developers</div>
          <a href="www/docs.html" style={wwwStyles.footLink}>docs</a>
          <a href="www/docs.html#cli" style={wwwStyles.footLink}>cli</a>
          <a href="www/docs.html#react" style={wwwStyles.footLink}>react widget</a>
          <a href="https://github.com/useatlas" style={wwwStyles.footLink}>github</a>
        </div>
        <div>
          <div style={wwwStyles.footHead}>legal</div>
          <a href="www/sla.html" style={wwwStyles.footLink}>sla</a>
          <a href="www/terms.html" style={wwwStyles.footLink}>terms</a>
          <a href="www/privacy.html" style={wwwStyles.footLink}>privacy</a>
          <a href="www/dpa.html" style={wwwStyles.footLink}>dpa</a>
        </div>
      </div>
    </div>
    <div style={wwwStyles.footMeta}>
      <span>© 2026 atlas defense corp · sf</span>
      <span style={{ fontFamily: "var(--font-mono)" }}>v0.94.2 · main · a8e20cf</span>
      <span>made by humans, for data teams</span>
    </div>
  </footer>
);

const PageHeader = ({ eye, title, dek, meta }) => (
  <header style={wwwStyles.pageHead}>
    <div style={wwwStyles.eye}>{eye}</div>
    <h1 style={wwwStyles.h1}>{title}</h1>
    {dek && <p style={wwwStyles.dek}>{dek}</p>}
    {meta && <div style={wwwStyles.pageMeta}>{meta}</div>}
  </header>
);

const wwwStyles = {
  nav: {
    display: "grid", gridTemplateColumns: "1fr auto 1fr",
    padding: "18px 40px", alignItems: "center",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    position: "sticky", top: 0, zIndex: 10,
    background: "oklch(0.12 0.005 280 / 0.85)", backdropFilter: "blur(12px)",
  },
  navLeft: { display: "flex", alignItems: "center", gap: 10 },
  brandLink: { display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "inherit" },
  brand: { fontWeight: 600, fontSize: 17, color: "oklch(0.985 0 0)" },
  tag: { fontFamily: "var(--font-mono)", fontSize: 10.5, color: "oklch(0.443 0 0)", marginLeft: 8, letterSpacing: "0.04em", padding: "2px 6px", border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 4 },
  navMid: { display: "flex", gap: 28, fontSize: 13.5, color: "oklch(0.708 0 0)" },
  navLink: { cursor: "pointer", color: "oklch(0.708 0 0)", textDecoration: "none" },
  navLinkActive: { color: "var(--atlas-brand)" },
  navRight: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 18, fontSize: 13, color: "oklch(0.708 0 0)" },
  cta: { background: "var(--atlas-brand)", color: "oklch(0.145 0 0)", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" },

  pageHead: { padding: "80px 64px 56px", borderBottom: "1px solid oklch(1 0 0 / 0.05)", maxWidth: 1100, margin: "0 auto", width: "100%" },
  eye: { fontFamily: "var(--font-mono)", fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--atlas-brand)", marginBottom: 18 },
  h1: { fontSize: 56, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.05, margin: "0 0 20px" },
  dek: { fontSize: 18, lineHeight: 1.55, color: "oklch(0.708 0 0)", margin: 0, maxWidth: 720 },
  pageMeta: { marginTop: 28, display: "flex", gap: 24, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },

  foot: { padding: "44px 64px", display: "flex", flexDirection: "column", gap: 32, borderTop: "1px solid oklch(1 0 0 / 0.05)" },
  footRow: { display: "grid", gridTemplateColumns: "1.4fr 2fr", gap: 36 },
  footL: { display: "flex", alignItems: "center", gap: 12 },
  footBrand: { fontSize: 18, fontWeight: 600 },
  footTag: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", marginLeft: 12, letterSpacing: "0.04em" },
  footCols: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 32 },
  footHead: { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "oklch(0.443 0 0)", marginBottom: 12 },
  footLink: { fontSize: 13, color: "oklch(0.708 0 0)", padding: "4px 0", display: "block", textDecoration: "none" },
  footMeta: { paddingTop: 18, borderTop: "1px solid oklch(1 0 0 / 0.05)", display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.04em", color: "oklch(0.443 0 0)" },
};

window.AtlasNav = AtlasNav;
window.AtlasFooter = AtlasFooter;
window.AtlasGlyph = AtlasGlyph;
window.PageHeader = PageHeader;
window.wwwStyles = wwwStyles;
