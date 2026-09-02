#!/usr/bin/env bun
/**
 * `bun scripts/collect-eval-corpus.ts` — collect the episodes a human will
 * label into #5338's scoring set.
 *
 * ## Why this is not a prod cut
 *
 * `atlas-operator ops heldout-manifest` cuts the real thing and cannot produce
 * this one: measured 2026-09-02, the `us` region holds **36 episodes lifetime**
 * against a Wilson floor of 110 positives, and that is a ceiling rather than a
 * running total. The issue's own answer applies — the number is set on a
 * labelled set and prod is the smoke test.
 *
 * ## The licence question this DOES and does NOT engage
 *
 * `.claude/research/extractor-corpus-acquisition.md` holds two decision cards,
 * both about **training inputs and shipped weights**. An evaluation set
 * produces no weights, so ADR-0044's prohibition is not engaged and this needs
 * only that document's *"store in our infra"* column — the `apache/*` rows are
 * yes there on the ALv2 reading, and collection through the API sidesteps the
 * scraping clause (*"Scraping does not refer to the collection of information
 * through our API"*).
 *
 * ⚠️ **The data-protection axis is NOT answered by that.** The text carries
 * personal data. `pseudonymise` rewrites handles and addresses and **does not
 * remove names from free text** — see `eval-corpus.ts`. Read that before
 * treating a collected sheet as anonymous.
 *
 * ## Usage
 *
 *   GITHUB_TOKEN=… bun scripts/collect-eval-corpus.ts \
 *     --repo apache/kafka --repo apache/airflow \
 *     --from 2026-06-01T00:00:00Z --to 2026-07-01T00:00:00Z \
 *     -o scripts/heldout/fixtures/apache-2026-06.sheet.json
 *
 * Exit codes: 0 written · 1 refused (window too large) · 3 bad input or API failure.
 */
import {
  SHEET_MAX_EPISODES,
  SHEET_LABEL_GUIDE,
  RAW_BODY_NOTE,
  checkSheetSize,
  pseudonymise,
  type EvalSheet,
  type PseudonymMap,
  type SheetEpisode,
} from "@atlas/api/lib/brain/eval-corpus";

const TAG = "[collect-eval-corpus]";

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  const value = process.argv[idx + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/** Every `--repo` occurrence, so two repos is two flags rather than a delimiter to escape. */
function repoFlags(): string[] {
  const out: string[] = [];
  for (const [index, arg] of process.argv.entries()) {
    if (arg !== "--repo") continue;
    const value = process.argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) out.push(value);
  }
  return out;
}

interface IssueComment {
  readonly id: number;
  readonly body?: string;
  readonly created_at: string;
  readonly html_url?: string;
}

/**
 * One repo's issue comments in the window, oldest first.
 *
 * `sort=created&direction=asc` plus `since` is the whole selection rule: no
 * ranking, no filtering on content, no "interesting thread" heuristic. The
 * operator chooses a repo and a window; the tool chooses nothing.
 *
 * ⚠️ `since` is the API's own filter and it is on UPDATED time, so it is a
 * superset of the window — the `to` bound and the `from` bound are both
 * re-applied here against `created_at`, which is the field the window actually
 * means.
 */
async function fetchRepoComments(
  repo: string,
  from: string,
  to: string,
  token: string,
): Promise<IssueComment[]> {
  const out: IssueComment[] = [];
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  for (let page = 1; page <= 40; page += 1) {
    const url =
      `https://api.github.com/repos/${repo}/issues/comments` +
      `?since=${encodeURIComponent(from)}&sort=created&direction=asc&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "atlas-eval-corpus",
      },
    });
    if (!res.ok) {
      // The body is read for the message and the read itself may fail on a
      // truncated response — that catch is the one place a swallow is right,
      // because the status line is already the actionable part.
      const detail = await res.text().catch(() => ""); // intentionally ignored: status is the signal
      throw new Error(`${repo} page ${page}: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const batch = (await res.json()) as IssueComment[];
    if (batch.length === 0) break;
    for (const comment of batch) {
      const at = Date.parse(comment.created_at);
      if (Number.isNaN(at) || at < fromMs || at >= toMs) continue;
      out.push(comment);
    }
    if (batch.length < 100) break;
  }
  return out;
}

async function main(): Promise<number> {
  const repos = repoFlags();
  const from = flag("--from");
  const to = flag("--to");
  const out = flag("-o") ?? flag("--out");
  const max = Number(flag("--max") ?? SHEET_MAX_EPISODES);
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  if (repos.length === 0 || !from || !to || !out) {
    console.error(`${TAG} usage: --repo <owner/name> [--repo …] --from <iso> --to <iso> -o <sheet.json>`);
    return 3;
  }
  if (!token) {
    // Unauthenticated is 60 requests/hour, which cannot page a real window —
    // and failing halfway through would produce a sheet that is a prefix of the
    // window, which is the sampled-by-sort-order set this whole lane refuses.
    console.error(`${TAG} set GITHUB_TOKEN (or GH_TOKEN). Unauthenticated quota cannot page a window.`);
    return 3;
  }
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    console.error(`${TAG} --from and --to must be ISO timestamps`);
    return 3;
  }
  if (Date.parse(to) <= Date.parse(from)) {
    console.error(`${TAG} --to must be after --from`);
    return 3;
  }

  const map: PseudonymMap = new Map();
  const episodes: SheetEpisode[] = [];
  for (const repo of repos) {
    let comments: IssueComment[];
    try {
      comments = await fetchRepoComments(repo, from, to, token);
    } catch (err) {
      console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
      return 3;
    }
    console.error(`${TAG} ${repo}: ${comments.length} comment(s) in window`);
    for (const comment of comments) {
      const body = comment.body ?? "";
      // An empty body is not an episode — nothing was ingested, so nothing
      // could be triaged. Dropped here rather than labelled `negative`, which
      // would be a free correct answer padding the denominator.
      if (body.trim() === "") continue;
      episodes.push({
        id: `gh-${repo.replace("/", "-")}-${comment.id}`,
        body: pseudonymise(body, map),
        class: null,
      });
    }
  }

  const refusal = checkSheetSize(episodes.length, max);
  if (refusal) {
    console.error(`${TAG} ${refusal}`);
    return 1;
  }
  if (episodes.length === 0) {
    console.error(`${TAG} the window yielded no episodes — widen it`);
    return 1;
  }

  const sheet: EvalSheet & { _guide: unknown; _note: string } = {
    sheet: 1,
    source: { corpus: "github-issue-comments", repos, from, to },
    collectedAt: new Date().toISOString(),
    _guide: SHEET_LABEL_GUIDE,
    _note: RAW_BODY_NOTE,
    episodes,
  };
  await Bun.write(out, `${JSON.stringify(sheet, null, 2)}\n`);
  console.error(
    `${TAG} wrote ${episodes.length} unlabelled episode(s) to ${out}, ` +
      `${map.size} identifier(s) pseudonymised. Set every \`class\`, then: ` +
      `bun scripts/build-eval-fixture.ts --sheet ${out} -o <fixture.json>`,
  );
  return 0;
}

process.exit(await main());
