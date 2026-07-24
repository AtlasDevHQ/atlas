import type { Metadata } from "next";

import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";
import {
  Article,
  BackToBlog,
  H2,
  InlineCode,
  Lead,
  P,
  PostActions,
  PostHeader,
  PullQuote,
  Signoff,
  StatStrip,
} from "../../../components/prose";
import { Divider, TopGlow } from "../../../components/shared";
import { StickyNav } from "../../../components/sticky-nav";
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "The Last Mile",
  description:
    "Launch is days away, and one item is still standing. What the month since the beta recap actually contained: backups that prove themselves, residency deletion that executes, an honest carve-out, and six releases forced by MCP clients I don't control.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "The Last Mile",
    description:
      "Launch is days away, and one item is still standing. What the month since the beta recap actually contained: backups that prove themselves, residency deletion that executes, and six releases forced by MCP clients I don't control. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/the-last-mile",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-07-23",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "The last mile",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "The Last Mile",
    description:
      "Launch is days away, and one item is still standing. What the month since the beta recap actually contained: backups that prove themselves, residency deletion that executes, and six releases forced by MCP clients I don't control.",
    images: ["/og.png"],
  },
  alternates: { canonical: "https://www.useatlas.dev/blog/the-last-mile" },
};

export default function TheLastMile() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("the-last-mile")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="Road to launch"
          isoDate="2026-07-23"
          dateLabel="July 23, 2026"
          readingTime="5 min read"
          title="The last mile"
          dek="A month ago I published the beta recap and said v0.1.0 lands in July. It's launch week. The month in between went to a different kind of work."
        />

        <Lead>
          A month ago I published{" "}
          <a href="/blog/announcing-atlas" className="link-accent">
            the beta recap
          </a>{" "}
          and put a month on the launch: Atlas goes public in July. That&apos;s
          now. Launch is days away, and a single item stands between here and
          the <InlineCode>v0.1.0</InlineCode> tag.
        </Lead>
        <P>
          From the outside, the month since looked like more of the same
          cadence. The release train that hit 29 tags by late June kept
          rolling:
        </P>

        <StatStrip
          items={[
            { value: "67", label: "releases since May 28" },
            { value: "592", label: "commits since the recap" },
            { value: "1", label: "blocker standing" },
          ]}
        />

        <P>
          But the feature list barely moved. The recap already described the
          product I&apos;m launching. What the last month went to is harder to
          put on a landing page: taking every promise Atlas makes to a paying
          customer and backing it with code that enforces it, or admitting
          where it can&apos;t.
        </P>

        <H2>Making the promises mechanical</H2>
        <P>
          The docs said Atlas Cloud takes scheduled backups of its internal
          database. In mid-July I went looking for the scheduler behind that
          sentence and found a cron loop with zero production callers. Nothing
          had ever invoked it. A sold entitlement and a clause in the data
          processing agreement, resting on dead code.
        </P>
        <P>
          The replacement is the kind of machinery the sentence deserved from
          the start. A scheduler fiber takes the backup on cadence, writes it
          to per-region object storage, then restores it into a scratch
          Postgres to prove the file is actually a database and marks it
          verified only after the restore succeeds. The health endpoint now
          watches the result: if the newest verified backup is older than the
          cadence allows, <InlineCode>/api/health</InlineCode> reports the
          degradation to my status monitoring.
        </P>

        <PullQuote>A promise in prose is a bug that hasn&apos;t surfaced yet.</PullQuote>

        <P>
          Data residency got the same treatment. Atlas Cloud runs in three
          regions, and moving a workspace between them promised that the
          source region&apos;s copy would be deleted after a seven-day grace
          period. That deletion never executed; the code to find due cleanups
          existed and nothing called it. Now every internal table is
          classified in a registry: exported with the workspace, stays in the
          source region, or belongs to the platform. A CI tripwire fails the
          build if someone adds a table without classifying it, and an hourly
          job performs the deletions in one transaction per migration, so a
          partial failure rolls back to &ldquo;still due&rdquo; instead of
          leaving half a workspace behind.
        </P>
        <P>
          One promise went the other way. Atlas&apos;s sandboxed analysis
          tools run on infrastructure that has no region primitive, so
          sandboxed execution happens in the US regardless of where a
          workspace&apos;s data lives. I couldn&apos;t make that true by
          writing code, so the residency pages, the{" "}
          <a href="https://www.useatlas.dev/security" className="link-accent">
            security page
          </a>
          , and the DPA now state the carve-out plainly, and the durable fix
          is tracked in public issues.
        </P>

        <H2>Clients I don&apos;t control</H2>
        <P>
          The other lesson of the month arrived through the MCP server at{" "}
          <a href="https://mcp.useatlas.dev" className="link-accent">
            mcp.useatlas.dev
          </a>
          . It had soaked in staging for weeks and behaved. Then real AI
          clients started connecting, and over two days in mid-July I cut
          nine release tags, six of them fixes to the hosted MCP surface.
        </P>
        <P>
          Every one of those bugs was invisible until software I don&apos;t
          ship dialed in. The connection config Atlas generates pointed
          clients at an SSE endpoint without declaring the transport type;
          Claude Code rejected it with a 400 before a single tool call.
          Queries that ran past two minutes died at a proxy, because the
          in-protocol progress heartbeat I was emitting doesn&apos;t count as
          traffic at the transport layer, so the stream needed its own
          keepalive. And <InlineCode>describeEntity</InlineCode> was showing
          filenames from disk where display names belonged, which no internal
          test noticed because the fixtures happened to agree.
        </P>
        <P>
          Staging can simulate load. It can&apos;t simulate strangers.
        </P>

        <H2>What&apos;s still standing</H2>
        <P>
          One blocker remains: a live security pass against the running
          product, in dev and on staging. Adversarial testing, aimed at the
          deployed system rather than the source. It&apos;s sequenced last on
          purpose. Atlas&apos;s query pipeline has been hardened since day
          one, and I&apos;ve written up{" "}
          <a href="/blog/seven-layers-and-a-sandbox" className="link-accent">
            the seven layers
          </a>{" "}
          that stand between the model and your database. But a security pass
          run before the promises above became mechanical would have audited
          claims, and I want it auditing behavior. Alongside it, a load-test
          re-run against current production, the same suite that already runs
          weekly in CI, pointed at the real thing one more time.
        </P>
        <P>
          When those are green, I cut <InlineCode>v0.1.0</InlineCode>. The
          first minor version has been reserved for this since the versioning
          scheme was written down: sixty-seven releases banked in the patch
          position, and the minor only moves when Atlas goes public. That
          moment is days away now. Until then, the live demo is the part you
          don&apos;t have to take on faith: no signup, nothing to install.
        </P>

        <PostActions />
        <Signoff />

        <BackToBlog />
      </Article>

      <Divider />
      <Footer />
    </div>
  );
}
