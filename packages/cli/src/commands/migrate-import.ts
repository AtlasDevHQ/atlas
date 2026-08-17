/**
 * atlas migrate-import -- Import an export bundle into a hosted Atlas instance.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import * as fs from "fs";
import pc from "picocolors";
import { getFlag } from "../../lib/cli-utils";

/**
 * The vocabulary section as a FOREIGN response may actually contain it (#5112).
 *
 * Every member optional, and `refusalDetails` a `Partial<...>` array — because this
 * value comes from an unchecked `as` cast of another server's `resp.json()`, and
 * this file already reasons about cross-version targets and proxies everywhere else.
 * Declaring the payload fully-shaped here while `residency/migrate.ts` screens the
 * identical value entry-by-entry ("every field is foreign input") would be one
 * payload with two opposite policies, which is what review round 1 found.
 */
interface CrossVersionVocabularySection {
  imported?: number;
  skipped?: number;
  refused?: number;
  refusalDetails?: Array<Partial<import("@useatlas/types").VocabularyRefusalDetail>>;
}

/**
 * Print the refusal disclosure for one import response.
 *
 * Extracted from the handler and given an injectable sink so its branches are
 * reachable from a test. They are the ONLY operator-facing surface for a dropped
 * human review decision, and before this they had no test at all: deleting the
 * "target did not return the refused edges" branch collapsed two different states
 * into silence, and deleting the "N more not listed" line made the CLI report a
 * smaller loss than happened. Both were green.
 */
export function renderRefusalNotice(
  vocabulary: CrossVersionVocabularySection | undefined,
  write: (line: string) => void = console.log,
): void {
  if (!vocabulary) return;

  // ⚠️ THREE STATES, not two. `refused` ABSENT is a target between #5022 and #5036:
  // it folded contradictory decisions into `skipped` and cannot tell us. Rendering
  // that as `0` — which `?? 0` did — is the most misleading value available, because
  // it is a positive claim that nothing was refused AND it silences the whole block
  // below. This is the same absent-vs-zero distinction the table's `-` filler makes
  // for sections that have no refusal outcome at all.
  if (typeof vocabulary.refused !== "number") {
    write(
      pc.yellow(
        "  ! This target build does not report refused alias edges. A dropped review decision",
      ),
    );
    write(
      "    would be counted under Skipped — compare the source region's brain_vocabulary_edge",
    );
    write("    rows before its cleanup grace period expires.");
    return;
  }

  const refused = vocabulary.refused;
  if (refused <= 0) return;

  const details = vocabulary.refusalDetails ?? [];
  write("");
  write(
    pc.yellow(
      `  ! ${refused} curated alias edge(s) were REFUSED — approved review decisions the ` +
        "destination did not apply.",
    ),
  );

  if (details.length === 0) {
    // A count with no payloads, which is NOT "nothing to recover" — the difference
    // is a build. A target between #5036 and #5112 reports the count and carries no
    // details at all.
    write("    The target did not return the refused edges (its build predates them). Retrieve them");
    write("    from the SOURCE region's brain_vocabulary_edge rows before its cleanup grace period");
    write("    expires.");
  } else {
    // ⚠️ RENDERED DEFENSIVELY, field by field. `d.approvedBy ?? "auto-approval"` was
    // the defect: `null` means auto-approved and ABSENT means the target did not say,
    // and `??` collapses them — inventing an attribution, which is verbatim the
    // misread `residency/migrate.ts` refuses by treating `undefined` as malformed.
    let unreadable = 0;
    for (const d of details) {
      if (typeof d.fromNorm !== "string" || typeof d.toNorm !== "string") {
        unreadable++;
        continue;
      }
      const held =
        d.existingTarget === null || d.existingTarget === undefined
          ? ""
          : ` (destination holds "${d.existingTarget}")`;
      const position = typeof d.slotPosition === "string" ? d.slotPosition : "unknown position";
      const reason = typeof d.refusal === "string" ? d.refusal : "unreported reason";
      write(`    - [${position}] "${d.fromNorm}" → "${d.toNorm}" — ${reason}${held}`);
      const approver =
        d.approvedBy === null
          ? "auto-approval"
          : typeof d.approvedBy === "string"
            ? d.approvedBy
            : "(approver not reported)";
      const when = typeof d.approvedAt === "string" ? d.approvedAt : "(time not reported)";
      write(`      approved by ${approver} at ${when}`);
    }
    if (unreadable > 0) {
      write(
        pc.yellow(
          `    ! ${unreadable} refusal record(s) were unreadable — a bug in the target region; ` +
            "check its logs.",
        ),
      );
    }
    // Both numbers whenever they differ. Printing only the list would report a
    // smaller loss than happened. Two causes read alike from here — the response's
    // cap, or a target that truncated for its own reason — so the wording names the
    // consequence rather than guessing the cause.
    if (details.length < refused) {
      write(`    ... ${refused - details.length} more were refused but not listed here.`);
    }
  }
  write("    Re-author them here, or export them from the source region's vocabulary.");
}

export async function handleMigrateImport(
  args: string[],
): Promise<void> {
  const bundlePath = getFlag(args, "--bundle");
  const targetUrl =
    getFlag(args, "--target") ?? "https://app.useatlas.dev";
  const apiKey =
    getFlag(args, "--api-key") ?? process.env.ATLAS_API_KEY;

  if (!bundlePath) {
    console.error(pc.red("--bundle <path> is required."));
    console.error(
      "  Example: atlas migrate-import --bundle atlas-export-2026-04-02.json --target https://app.useatlas.dev",
    );
    process.exit(1);
  }

  if (!apiKey) {
    console.error(pc.red("Authentication required."));
    console.error("  Set ATLAS_API_KEY or pass --api-key <key>.");
    process.exit(1);
  }

  // Read and validate the bundle file
  if (!fs.existsSync(bundlePath)) {
    console.error(
      pc.red(`Bundle file not found: ${bundlePath}`),
    );
    process.exit(1);
  }

  let bundle: unknown;
  try {
    const raw = fs.readFileSync(bundlePath, "utf-8");
    bundle = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`Failed to parse bundle: ${detail}`));
    process.exit(1);
  }

  // Basic validation -- mirror server-side checks to fail fast before upload
  const b = bundle as Record<string, unknown>;
  if (
    !b ||
    typeof b !== "object" ||
    !b.manifest ||
    !Array.isArray(b.conversations) ||
    !Array.isArray(b.semanticEntities) ||
    !Array.isArray(b.learnedPatterns) ||
    !Array.isArray(b.settings)
  ) {
    console.error(
      pc.red(
        "Invalid bundle format. Expected an Atlas export bundle with manifest and all data arrays.",
      ),
    );
    process.exit(1);
  }

  const manifest = b.manifest as {
    version: number;
    counts: Record<string, number>;
  };
  // Mirror the server: every version the importer accepts, oldest still
  // supported. v1 = pre-#4460 (no dashboards/knowledge/tasks/memory sections),
  // v2 = pre-#5035 (brain facts carry no identity), v3 = current.
  // Local constants (not `EXPORT_BUNDLE_VERSION` from @useatlas/types) so a
  // CLI built against an older published types package can't silently shrink
  // the accept set — same rationale as the server's admin-migrate.ts. The
  // `satisfies` tether (type-only, scaffold-safe) pins them to the wire union.
  //
  // ⚠️ And deliberately NO exhaustiveness pin, unlike `admin-migrate.ts`, which
  // has one. The asymmetry is the point: a pin here would force this list to
  // cover the union of whatever `@useatlas/types` version got installed, so a
  // CLI built against a NEWER package would claim to read a version its own code
  // has never seen. Drift in the other direction — this list falling behind the
  // server's — is what actually costs a cutover, and that is guarded lexically
  // by `bundle-identity-v3.test.ts`'s CLI-parity arm.
  const SUPPORTED_BUNDLE_VERSIONS = [1, 2, 3] as const satisfies readonly import("@useatlas/types").SupportedBundleVersion[];
  // The version at which the #4460 pillar sections appear, which is what the
  // summary below is really asking about. Deliberately not "the current
  // version": reading it that way would stop printing the pillar counts for
  // every bundle newer than v2.
  const PILLAR_SECTIONS_FROM_VERSION = 2 satisfies import("@useatlas/types").SupportedBundleVersion;
  if (!(SUPPORTED_BUNDLE_VERSIONS as readonly number[]).includes(manifest.version)) {
    console.error(
      pc.red(
        `Unsupported bundle version: ${manifest.version}. This CLI supports versions ${SUPPORTED_BUNDLE_VERSIONS.join(", ")}.`,
      ),
    );
    process.exit(1);
  }

  console.log(
    `\nAtlas Migrate-Import -- sending bundle to ${pc.bold(targetUrl)}\n`,
  );
  console.log(`  Bundle: ${bundlePath}`);
  console.log(
    `  Conversations: ${manifest.counts.conversations}`,
  );
  console.log(
    `  Entities:      ${manifest.counts.semanticEntities}`,
  );
  console.log(
    `  Patterns:      ${manifest.counts.learnedPatterns}`,
  );
  console.log(`  Settings:      ${manifest.counts.settings}`);
  if (manifest.version >= PILLAR_SECTIONS_FROM_VERSION) {
    console.log(`  Dashboards:    ${manifest.counts.dashboards ?? 0}`);
    console.log(`  Knowledge:     ${manifest.counts.knowledgeDocuments ?? 0}`);
    console.log(`  Sched. tasks:  ${manifest.counts.scheduledTasks ?? 0}`);
    console.log(`  Memory slots:  ${manifest.counts.agentSessionMemory ?? 0}`);
  }
  console.log();

  const importUrl = `${targetUrl.replace(/\/$/, "")}/api/v1/admin/migrate/import`;

  try {
    const resp = await fetch(importUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.error(
          pc.red(
            "Import failed: authentication or authorization error.",
          ),
        );
        console.error(
          "  Ensure your API key has admin access to the target workspace.",
        );
      } else if (resp.status === 413) {
        console.error(
          pc.red(
            "Import failed: bundle too large. Try exporting a smaller dataset.",
          ),
        );
      } else {
        let errorMsg = `HTTP ${resp.status}`;
        try {
          const json = (await resp.json()) as {
            message?: string;
            error?: string;
          };
          errorMsg =
            json.message ?? json.error ?? errorMsg;
        } catch {
          // intentionally ignored: JSON parse failed
          errorMsg = await resp.text().catch(() => errorMsg);
        }
        console.error(
          pc.red(`Import failed: ${errorMsg}`),
        );
      }
      process.exit(1);
    }

    // Cross-version view of the response: an older target server (pre-#4460)
    // omits the v2 sections entirely, so they are optional HERE even though
    // the current ImportResult wire type requires them — the cast must not
    // claim more than the runtime guards below check.
    //
    // `brainVocabularyEdges` joins the optional set at #5112. It was absent from
    // BOTH halves before then, so this table never printed a vocabulary counter at
    // all — including `refused`, the one counter in the whole response that means
    // a human's approved decision was dropped. Its nested `refusalDetails` is
    // #5112's payload and a target between #5036 and #5112 omits it, which is why
    // the render below treats an empty list beside a non-zero count as a distinct
    // case rather than as "nothing to recover".
    type CrossVersionImportResult =
      Pick<import("@useatlas/types").ImportResult, "conversations" | "semanticEntities" | "learnedPatterns" | "settings"> &
      Partial<Pick<import("@useatlas/types").ImportResult, "dashboards" | "knowledgeDocuments" | "scheduledTasks" | "agentSessionMemory" | "brainEpisodes" | "brainFacts" | "brainEdges" | "factAudienceMembers">> &
      {
        brainVocabularyEdges?: CrossVersionVocabularySection;
      };
    let result: CrossVersionImportResult;
    try {
      result =
        (await resp.json()) as CrossVersionImportResult;
      // Guard every section the cast claims as required (all four base
      // sections are accessed unconditionally below).
      if (
        !result?.conversations ||
        !result?.semanticEntities ||
        !result?.learnedPatterns ||
        !result?.settings
      ) {
        throw new Error("Unexpected response shape");
      }
    } catch (parseErr) {
      console.error(
        pc.red(
          "Import appeared to succeed (HTTP 200) but the response was not in the expected format.",
        ),
      );
      console.error(
        "  Check the target Atlas instance version compatibility.",
      );
      console.error(
        `  Detail: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
      process.exit(1);
    }

    // THREE columns since #5112. The third exists for one section today, and the
    // two possible fillers for the rest are NOT interchangeable:
    //
    //   - `-` means the section HAS NO refusal outcome. There is nothing it could
    //     report there, in any build.
    //   - `0` would be a positive claim that it refused nothing — a different
    //     sentence, and one those sections cannot make.
    //
    // Same distinction the target-side refusal warn makes by writing an explicit
    // `null` for `existingTarget` rather than omitting the key: a blank and a zero
    // read identically to someone skimming, and only one of them is true here.
    const NO_REFUSAL_OUTCOME = "-";
    /** The section CAN refuse, but this target's build does not report the counter. */
    const REFUSAL_NOT_REPORTED = "?";
    const row = (
      label: string,
      counts: { imported?: number; skipped?: number },
      // Three cell kinds, and they are three different sentences: a NUMBER is what
      // the target reported, `-` means the section has no refusal outcome in any
      // build, and `?` means this section HAS one but the target's build cannot
      // report it. Collapsing any pair loses a distinction an operator acts on.
      refused: number | typeof NO_REFUSAL_OUTCOME | typeof REFUSAL_NOT_REPORTED,
    ): void => {
      console.log(
        `  ${label.padEnd(17)} ${String(counts.imported ?? 0).padStart(8)}  ${String(counts.skipped ?? 0).padStart(7)}  ${String(refused).padStart(7)}`,
      );
    };

    console.log(`${pc.green("✓")} Import complete!\n`);
    console.log(
      "  Entity            Imported  Skipped  Refused",
    );
    console.log(
      "  ────────────────  ────────  ───────  ───────",
    );
    row("Conversations", result.conversations, NO_REFUSAL_OUTCOME);
    row("Semantic entities", result.semanticEntities, NO_REFUSAL_OUTCOME);
    row("Learned patterns", result.learnedPatterns, NO_REFUSAL_OUTCOME);
    row("Settings", result.settings, NO_REFUSAL_OUTCOME);
    // v2 sections (#4460) — absent from an older server's response.
    if (result.dashboards) row("Dashboards", result.dashboards, NO_REFUSAL_OUTCOME);
    if (result.knowledgeDocuments) row("Knowledge docs", result.knowledgeDocuments, NO_REFUSAL_OUTCOME);
    if (result.scheduledTasks) row("Scheduled tasks", result.scheduledTasks, NO_REFUSAL_OUTCOME);
    if (result.agentSessionMemory) row("Session memory", result.agentSessionMemory, NO_REFUSAL_OUTCOME);
    // Company brain (#4767). Reported per-section so a migration that moved
    // ZERO brain rows can't print a summary identical to one that moved
    // everything — the operator-visible half of "silent loss is worse than
    // loud failure".
    if (result.brainEpisodes) row("Brain episodes", result.brainEpisodes, NO_REFUSAL_OUTCOME);
    if (result.brainFacts) row("Brain facts", result.brainFacts, NO_REFUSAL_OUTCOME);
    if (result.brainEdges) row("Brain edges", result.brainEdges, NO_REFUSAL_OUTCOME);
    if (result.factAudienceMembers) row("Fact audiences", result.factAudienceMembers, NO_REFUSAL_OUTCOME);
    // The curated identity vocabulary (#5036, #5112). Absent from this table
    // ENTIRELY until #5112 — so the one counter in the whole response that reports
    // a dropped human decision was the one counter the operator who pressed the
    // button never saw.
    const vocabulary = result.brainVocabularyEdges;
    // `?` for a target that cannot report the counter at all — distinct from `0`
    // ("refused nothing") and from `-` ("has no refusal outcome"). Three states,
    // three cells; `?? 0` collapsed the first into the second.
    if (vocabulary) {
      row(
        "Alias edges",
        vocabulary,
        typeof vocabulary.refused === "number" ? vocabulary.refused : REFUSAL_NOT_REPORTED,
      );
    }

    // ⚠️ NOT A TABLE CELL. A number in a column is something to skim past. This is
    // the only outcome in the response that says a human's approved review decision
    // was discarded and the destination will never hold it, so it gets prose and the
    // payloads. Extracted so its branches are testable — see `renderRefusalNotice`.
    renderRefusalNotice(vocabulary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (
      detail.includes("ECONNREFUSED") ||
      detail.includes("fetch failed")
    ) {
      console.error(
        pc.red(
          `Cannot reach Atlas API at ${targetUrl}.`,
        ),
      );
      console.error(
        "  Check the --target URL and ensure the Atlas API is running.",
      );
    } else {
      console.error(pc.red(`Import failed: ${detail}`));
    }
    process.exit(1);
  }
}
