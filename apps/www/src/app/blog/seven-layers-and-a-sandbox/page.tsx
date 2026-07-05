import type { Metadata } from "next";

import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";
import {
  Article,
  BackToBlog,
  CodeBlock,
  DefItem,
  DefList,
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
  title: "Seven Layers and a Sandbox",
  description:
    "Every query Atlas runs was written by a language model. Here is each layer between that output and your database — and why the shell tools get the opposite treatment.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Seven Layers and a Sandbox",
    description:
      "Every query Atlas runs was written by a language model. Here is each layer between that output and your database — and why the shell tools get the opposite treatment. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/seven-layers-and-a-sandbox",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-07-05",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Seven layers and a sandbox",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Seven Layers and a Sandbox",
    description:
      "Every query Atlas runs was written by a language model. Here is each layer between that output and your database — and why the shell tools get the opposite treatment.",
    images: ["/og.png"],
  },
  alternates: {
    canonical: "https://www.useatlas.dev/blog/seven-layers-and-a-sandbox",
  },
};

export default function SevenLayersAndASandbox() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("seven-layers-and-a-sandbox")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How it works"
          isoDate="2026-07-05"
          dateLabel="July 5, 2026"
          readingTime="6 min read"
          title="Seven layers and a sandbox"
          dek="Every query Atlas runs was written by a language model. Here is each layer between that output and your database, and why the shell tools get the opposite treatment."
        />

        <Lead>
          Every query Atlas runs against a customer&apos;s database was written
          by a language model. Customers are right to pause at that sentence.
          The whole execution path is designed around the pause.
        </Lead>
        <P>
          The model writes good SQL on a normal day. The semantic layer sees to
          that: before writing a line, it reads a YAML file that says what your
          tables actually mean (I made that case in{" "}
          <a href="/blog/why-the-semantic-layer-is-yaml" className="link-accent">
            Why the semantic layer is a YAML file
          </a>
          ). But good on a normal day is a quality bar. Safety is about the bad
          day, when a prompt injection rides in on a pasted document, or the
          model hallucinates a table, or someone talks it into being helpful in
          a way it shouldn&apos;t be. So Atlas treats the model&apos;s SQL the
          way it would treat SQL typed by a stranger: as untrusted input to a
          pipeline that does not care who the author was.
        </P>

        <StatStrip
          items={[
            { value: "7", label: "validation layers" },
            { value: "28", label: "forbidden functions" },
            { value: "1", label: "AST parse per query" },
          ]}
        />

        <H2>The cheap layers</H2>
        <P>
          The first checks are fast and unsophisticated on purpose. Empty input
          is rejected. A regex guard scans for mutation keywords,{" "}
          <InlineCode>INSERT</InlineCode>, <InlineCode>UPDATE</InlineCode>,{" "}
          <InlineCode>DELETE</InlineCode>, <InlineCode>DROP</InlineCode>,{" "}
          <InlineCode>TRUNCATE</InlineCode>, <InlineCode>GRANT</InlineCode>,{" "}
          <InlineCode>KILL</InlineCode>, and a dozen more, and refuses the
          query on sight. Comments are stripped before that scan runs, so
          hiding a keyword behind <InlineCode>/* a comment */</InlineCode> buys
          nothing. One statement per query; a semicolon does not get you a
          second one.
        </P>
        <P>
          A regex is a first pass. It rejects the obvious garbage cheaply and
          hands the interesting cases to the parser.
        </P>

        <H2>The query that passes all of that</H2>
        <CodeBlock title="postgres">{`SELECT pg_read_file('/etc/passwd');`}</CodeBlock>
        <P>
          This query mutates nothing. It is a single, well-formed{" "}
          <InlineCode>SELECT</InlineCode>. It touches no table at all, so a
          table whitelist has nothing to object to. Every check described so
          far waves it through, and it reads your database server&apos;s
          filesystem.
        </P>
        <P>
          Postgres and MySQL both carry families of functions like this:{" "}
          <InlineCode>pg_read_file</InlineCode> and{" "}
          <InlineCode>lo_export</InlineCode> for the filesystem,{" "}
          <InlineCode>dblink</InlineCode> for opening a fresh connection to
          another server (where the read-only session on this one no longer
          applies), <InlineCode>pg_sleep</InlineCode> and{" "}
          <InlineCode>benchmark</InlineCode> for burning a core on demand,{" "}
          <InlineCode>load_file</InlineCode> and{" "}
          <InlineCode>sys_eval</InlineCode> on the MySQL side. Atlas keeps a
          list of twenty-eight of them and walks the parsed syntax tree looking
          for function-call nodes whose name matches. Walking the tree matters:
          a regex would also fire on the string literal{" "}
          <InlineCode>&apos;pg_sleep&apos;</InlineCode> sitting harmlessly
          inside a <InlineCode>WHERE</InlineCode> clause, and it would miss the
          schema-qualified spelling{" "}
          <InlineCode>pg_catalog.pg_read_file</InlineCode>. The tree walk gets
          both right.
        </P>

        <H2>The comment that executes</H2>
        <CodeBlock title="mysql">{`SELECT id FROM orders
/*!50000 UNION SELECT user, password FROM mysql.user */;`}</CodeBlock>
        <P>
          To almost every SQL parser, the block on the second line is a
          comment. To MySQL it is code: version-gated executable comments run
          their body on any server newer than the stated version, and{" "}
          <InlineCode>50000</InlineCode> means any server since 2005. A
          validator that parses the comment away approves a query the database
          will then execute in full.
        </P>
        <P>
          So in MySQL mode, before anything else runs, Atlas unwraps executable
          comments and validates the result, looping until the query stops
          changing so nested wrappers peel too. Every layer downstream sees the
          SQL MySQL will actually execute. And if a query collapses to nothing
          once the wrappers come off, meaning its only real content was hiding
          inside comment syntax, it is rejected and logged as a probe, because
          honest queries do not look like that. The rule underneath: validate
          the SQL the database will actually run, even when that differs from
          the string you were handed.
        </P>

        <H2>One parse, shared everywhere</H2>
        <P>
          The pipeline parses each query exactly once, and every guard reads
          that same parse: the single-<InlineCode>SELECT</InlineCode> shape
          check, the forbidden-function walk, the table whitelist, and the
          classifier that decides whether a query touches tables governed by
          approval rules or PII masking. That last consumer is the point of the
          discipline. If the whitelist parsed the query one way and the
          classifier parsed it another, the set of tables being checked could
          drift from the set of tables being governed, and drift in a security
          seam is how bypasses are born. With one parse there is one table set,
          and the guards agree by construction instead of by test coverage.
        </P>
        <P>
          Two decisions in this layer fail closed. A query the parser cannot
          parse is rejected outright; a string that passes the regex but
          confuses the parser is exactly the shape a crafted bypass would take,
          so confusion means no. And if scanning the semantic layer fails, the
          whitelist for the affected connection comes back empty, which rejects
          everything. An outage shows up as refused queries and nothing worse.
        </P>
        <P>Put together, each class of bad query meets a specific wall:</P>
        <DefList>
          <DefItem term="A write">
            The regex guard and the single-<InlineCode>SELECT</InlineCode>{" "}
            shape check refuse it, and the connection itself was opened
            read-only: Postgres sessions run{" "}
            <InlineCode>SET default_transaction_read_only = on</InlineCode>,
            MySQL sessions run{" "}
            <InlineCode>SET SESSION TRANSACTION READ ONLY</InlineCode>. A write
            that somehow reached the database would still bounce.
          </DefItem>
          <DefItem term="A sneaky read">
            <InlineCode>pg_read_file(&apos;/etc/passwd&apos;)</InlineCode> and
            its twenty-seven relatives are caught by the function walk over the
            syntax tree, schema-qualified spellings included.
          </DefItem>
          <DefItem term="An off-limits table">
            Only tables defined in the semantic layer are queryable, and the
            whitelist fails closed when its source does.
          </DefItem>
          <DefItem term="A runaway query">
            Every query gets a <InlineCode>LIMIT</InlineCode> appended (default
            1,000 rows) and a statement timeout (default 30 seconds).{" "}
            <InlineCode>pg_sleep</InlineCode> is on the forbidden list for good
            measure.
          </DefItem>
          <DefItem term="A tenant crossing">
            With row-level security enabled, the acting member&apos;s claims
            are injected as <InlineCode>WHERE</InlineCode> conditions. A caller
            who cannot supply the required claim is blocked before the query
            runs.
          </DefItem>
        </DefList>

        <PullQuote>
          The semantic layer guides; the whitelist enforces.
        </PullQuote>
        <P>
          That line is from Atlas&apos;s design records, and it explains a
          policy choice that surprises people: workspace members can submit raw
          SQL of their own over the CLI or the MCP server, and it runs through
          this exact pipeline. Same whitelist, same row-level security, same
          approval classification. Writing your own SQL removes the
          model&apos;s self-restraint and nothing else, and self-restraint was
          never a security control. There is also only one pipeline to run: the
          agent path and the raw-SQL path are thin wrappers over a single
          shared core, so a governance fix cannot land on one and silently
          skip the other.
        </P>

        <H2>And then there is the shell</H2>
        <P>
          Atlas has a second tool with a very different posture. The{" "}
          <InlineCode>explore</InlineCode> tool lets the agent browse the
          semantic layer with a real shell: <InlineCode>ls</InlineCode>,{" "}
          <InlineCode>grep</InlineCode>, <InlineCode>awk</InlineCode>, pipes,
          whatever it wants. There is no command allowlist. After seven layers
          of SQL scrutiny, that can sound like a scandal.
        </P>
        <P>
          The difference is where the code runs. SQL executes inside the
          customer&apos;s database, a machine Atlas does not control. There is
          no Atlas-side process to wrap in a sandbox, so the validation
          pipeline and the read-only session have to carry the entire boundary,
          and they are built to. Shell runs on infrastructure Atlas does
          control, and validating arbitrary shell is a losing game, because any
          allowlist rich enough to be useful contains tools that can do
          anything (<InlineCode>awk</InlineCode> alone is a programming
          language). So the shell gets zero validation and total containment
          instead: an ephemeral sandbox with read-only mounts of the semantic
          layer, writes landing in throwaway layers that evaporate when the
          command exits, network egress denied by default, and output capped at
          one megabyte. On Atlas Cloud that sandbox is a fresh per-request
          microVM that starts with deny-all networking, and if one cannot be
          obtained, the tool refuses to run at all.
        </P>
        <P>
          Both halves follow one rule: put the enforcement where it holds by
          construction. A read-only session, a whitelist that comes back empty
          when its source fails, a parse shared by every guard, a filesystem
          that cannot be written. None of these depend on the model behaving,
          on a prompt staying clean, or on anyone staying careful. The model
          gets to be brilliant. The pipeline assumes it might not be. The
          plain-language version of this whole model lives on the{" "}
          <a href="https://www.useatlas.dev/security" className="link-accent">
            security page
          </a>
          , and the code is open if you want to check my work.
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
