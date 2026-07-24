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
} from "../../../components/prose";
import { Divider, TopGlow } from "../../../components/shared";
import { StickyNav } from "../../../components/sticky-nav";
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "A security pass against the running product",
  description:
    "Atlas is read-only by construction, and I wanted that checked against a deployed system rather than a source tree. The pass found an egress guard that trusted hostnames and a containment claim on my own security page that was wrong. Here's both, and the fixes.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "A security pass against the running product",
    description:
      "The pass found an egress guard that trusted hostnames, and a containment claim on my own security page that was wrong. Here's both, and the fixes.",
    url: "https://www.useatlas.dev/blog/the-live-security-pass",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-07-29",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "A security pass against the running product",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "A security pass against the running product",
    description:
      "An egress guard that trusted hostnames, and a containment claim on my own security page that was wrong.",
    images: ["/og.png"],
  },
  alternates: {
    canonical: "https://www.useatlas.dev/blog/the-live-security-pass",
  },
};

export default function TheLiveSecurityPass() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("the-live-security-pass")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How it works"
          isoDate="2026-07-29"
          dateLabel="July 29, 2026"
          readingTime="6 min read"
          title="A security pass against the running product"
          dek="The last thing standing between Atlas and its launch tag was an adversarial pass aimed at a deployed system. It found two things worth writing down."
        />

        <Lead>
          A model writes every query Atlas runs, which puts the whole safety
          burden on the structure around it. A seven-layer pipeline stands
          between what the model emits and your database, and only tables named
          in your semantic layer are reachable at all. I took that pipeline
          apart layer by layer in{" "}
          <a href="/blog/seven-layers-and-a-sandbox" className="link-accent">
            Seven layers and a sandbox
          </a>
          , and none of it changed this month.
        </Lead>
        <P>
          What changed is that I finally pointed an adversarial pass at the
          running product. It was sequenced last on purpose. A pass run three months ago would have audited a set of
          claims; I wanted one that audited a deployed system with all of this
          month&apos;s promises already made mechanical. Reading the source
          tells you what should happen. A live system tells you what does.
        </P>

        <H2>Finding one: the guard that trusted a hostname</H2>
        <P>
          Atlas makes outbound requests on your behalf in several places. A REST
          datasource calls an API. A knowledge connector pulls from Confluence.
          A webhook fires at a URL somebody typed into a form. Each of those
          takes a destination that a user supplied, which makes them the classic
          shape for server-side request forgery: convince the server to fetch
          something on the internal network it would never expose directly.
        </P>
        <P>
          There was a guard for this, and it worked the way most of them do. It
          parsed the URL, looked at the host, and rejected the addresses nobody
          should be dialing: loopback, link-local, the private ranges, the cloud
          metadata endpoint. Hand it{" "}
          <InlineCode>http://169.254.169.254/</InlineCode> and it said no.
        </P>
        <P>
          It said yes to a hostname. The check ran against the literal text of
          the host, so a name that resolved to an internal address passed
          inspection and then got fetched, because the DNS lookup that would
          have exposed it happened afterward inside the HTTP client. Anyone who
          can point a DNS record at{" "}
          <InlineCode>127.0.0.1</InlineCode> gets a request originating inside
          the perimeter.
        </P>

        <PullQuote>
          The guard checked the name. The request used the address.
        </PullQuote>

        <P>
          The fix inverts the order: resolve the hostname first, then run every
          returned address through the same rejection rules, and make the
          request against what was actually validated. That closed the hole in
          the shared helper every outbound caller already used, so the
          connectors, the REST datasources, and the webhook publisher all
          inherited it at once. The work is public as issue{" "}
          <InlineCode>#4779</InlineCode>.
        </P>

        <H2>Finding two: a claim on my own security page</H2>
        <P>
          The second finding wasn&apos;t a vulnerability. It was a sentence I
          had written about Atlas that didn&apos;t match how Atlas behaves.
        </P>
        <P>
          The agent has a shell tool for reading the semantic layer, and the
          security page described its containment as a path jail: writes
          blocked, directory traversal blocked, access confined to the semantic
          directory. Somebody checking that claim against the running product
          finds it&apos;s wrong. There is no command allowlist and no path
          check. A write inside the sandbox succeeds. So does{" "}
          <InlineCode>..</InlineCode>.
        </P>
        <P>
          The containment is real, and it comes from somewhere else entirely.
          Each backend is structurally read-only: an ephemeral microVM on Atlas
          Cloud, read-only bind mounts under nsjail, an in-memory overlay in the
          sidecar. Writes land in a throwaway layer that evaporates when the
          sandbox stops, and the host filesystem is never in reach to begin
          with. The isolation does the work that the imagined path guard was
          getting credit for.
        </P>
        <P>
          Both descriptions end at &ldquo;your files are safe.&rdquo; That is
          why the wrong one lasted as long as it did. They fail differently
          under audit, though: a reader who tests the path claim finds it false
          and reasonably stops believing the rest of the page. The docs and the{" "}
          <a href="https://www.useatlas.dev/security" className="link-accent">
            security page
          </a>{" "}
          now describe the containment that actually exists. That version has
          the advantage of being both true and the stronger claim. The issue is{" "}
          <InlineCode>#4781</InlineCode>.
        </P>

        <H2>The governance edge</H2>
        <P>
          A related question came up during the pass: the agent can edit the
          semantic layer and write knowledge documents, so what stops a bad
          suggestion from becoming what everyone reads?
        </P>
        <P>
          Publishing is a separate, gated step. Agent-authored changes land as
          drafts, and drafts are promoted only through a single endpoint that
          does the promotion inside one transaction. Dashboards behave the same
          way, and every knowledge document a connector syncs arrives as a draft
          regardless of what the source system says. The review gate is built
          into the path a change takes, so it holds on the day everyone forgets
          it exists.
        </P>

        <H2>What I won&apos;t claim</H2>
        <P>
          One pass against one deployment doesn&apos;t make a system secure, and
          I&apos;m not going to write that sentence. What it does is move two
          specific things from believed to checked, and correct a third that I
          had described wrongly in public for months.
        </P>
        <P>
          The findings are tracked as public issues, the fixes are in the
          history, and the carve-outs I can&apos;t engineer away are written on
          the security page in plain language. More will be found. What I
          control is whether it gets written down where you can read it.
        </P>
        <P>
          Tomorrow: what happens when an AI client I&apos;ve never seen connects
          to Atlas and starts asking your data questions.
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
