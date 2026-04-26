/* Legal-doc shared layout: TOC sidebar + annotated two-column body */

const LegalDoc = ({ sections }) => {
  const [active, setActive] = React.useState(sections[0]?.id);

  React.useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) setActive(e.target.id);
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    sections.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [sections]);

  return (
    <div style={legalStyles.wrap}>
      <aside style={legalStyles.toc}>
        <div style={legalStyles.tocHead}>// contents</div>
        <ol style={legalStyles.tocList}>
          {sections.map((s, i) => (
            <li key={s.id} style={legalStyles.tocItem}>
              <a href={`#${s.id}`} style={{
                ...legalStyles.tocLink,
                ...(active === s.id ? legalStyles.tocLinkActive : {}),
              }}>
                <span style={legalStyles.tocNum}>{String(i + 1).padStart(2, "0")}</span>
                <span>{s.title}</span>
              </a>
            </li>
          ))}
        </ol>
      </aside>
      <article style={legalStyles.body}>
        {sections.map((s, i) => (
          <section key={s.id} id={s.id} style={legalStyles.sec}>
            <div style={legalStyles.secHead}>
              <span style={legalStyles.secNum}>{String(i + 1).padStart(2, "0")}</span>
              <h2 style={legalStyles.secTitle}>{s.title}</h2>
            </div>
            <div style={legalStyles.secGrid}>
              <div style={legalStyles.legalCol}>
                {s.legal.map((p, j) => <p key={j} style={legalStyles.legalP}>{p}</p>)}
              </div>
              <aside style={legalStyles.plainCol}>
                <div style={legalStyles.plainHead}>// plain english</div>
                <div style={legalStyles.plainBody}>{s.plain}</div>
              </aside>
            </div>
          </section>
        ))}
      </article>
    </div>
  );
};

const legalStyles = {
  wrap: { display: "grid", gridTemplateColumns: "240px 1fr", gap: 64, maxWidth: 1280, margin: "0 auto", padding: "56px 64px 96px" },
  toc: { position: "sticky", top: 88, alignSelf: "start", maxHeight: "calc(100vh - 120px)", overflowY: "auto" },
  tocHead: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--atlas-brand)", letterSpacing: "0.06em", marginBottom: 16 },
  tocList: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 2 },
  tocItem: {},
  tocLink: { display: "flex", gap: 10, alignItems: "baseline", padding: "7px 0", fontSize: 12.5, color: "oklch(0.556 0 0)", textDecoration: "none", borderLeft: "2px solid transparent", paddingLeft: 12, marginLeft: -14, transition: "color 120ms" },
  tocLinkActive: { color: "var(--atlas-brand)", borderLeftColor: "var(--atlas-brand)" },
  tocNum: { fontFamily: "var(--font-mono)", fontSize: 10, color: "oklch(0.443 0 0)", letterSpacing: "0.04em", minWidth: 18 },

  body: { display: "flex", flexDirection: "column", gap: 64 },
  sec: { scrollMarginTop: 88 },
  secHead: { display: "flex", alignItems: "baseline", gap: 16, marginBottom: 24, paddingBottom: 16, borderBottom: "1px solid oklch(1 0 0 / 0.06)" },
  secNum: { fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--atlas-brand)", letterSpacing: "0.04em" },
  secTitle: { fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 },
  secGrid: { display: "grid", gridTemplateColumns: "1fr 280px", gap: 40 },
  legalCol: {},
  legalP: { fontSize: 14.5, lineHeight: 1.7, color: "oklch(0.871 0 0)", margin: "0 0 16px" },
  plainCol: { borderLeft: "1px dashed oklch(1 0 0 / 0.1)", paddingLeft: 24 },
  plainHead: { fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--atlas-brand)", letterSpacing: "0.06em", marginBottom: 12 },
  plainBody: { fontSize: 13, lineHeight: 1.6, color: "oklch(0.708 0 0)" },
};

window.LegalDoc = LegalDoc;
