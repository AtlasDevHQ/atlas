# Notebook surface — elevation audit

**Prep for a `/grill-with-docs` session on elevating the notebook surface.**

Phase 1 ("Notice") of `docs/agents/workflow.md`. This is a briefing, not a plan — the grill, PRD, and issue slicing happen downstream with the user in the loop.

- **Surface:** `packages/web/src/app/(workspace)/notebook` + `packages/web/src/ui/components/notebook/**` + the conversation/notebook-state API (`packages/api/src/lib/conversations.ts`, `packages/api/src/api/routes/conversations.ts`) + the shared-report viewer (`packages/web/src/app/shared/**`).
- **Dimensions that ran (4):** end-user UX · the agent/AI path · data model & persistence · lifecycle & integration seams (fork/branch, share-as-report, export, dashboard bridge, chat↔notebook conversion).
- **UX dimension ran CODE-ONLY** — no dev server was available (Docker daemon absent in this environment). No runtime/Playwright verification was possible; every UX finding stands on code-reading anchors only.
- **Hand-verified anchor findings** (re-read at the cited lines by the collator): all four CRITICALs (C1 rerun-truncation, C2 fork-metadata erasure + server blind-overwrite, C3 share-transcript, C4 deleted-cells-not-deleted) and the top HIGHs H1 (no stop), H2 (dead streaming branch — confirmed `cell.status` is only ever `"idle"`, so the live-render path is unreachable), and the schema-strip bug filed as #4535. Marked `verified` inline below.
- **Issues filed (Step 4):** #4535 (the one fix-invariant bug — see below). Everything else stays in this doc because its fix is entangled with a design decision the grill exists to settle.

---

## Verdict

**Strong engine, unfinished cockpit — and the cockpit lies to the pilot about what it saved and what it shared.**

What is genuinely good and should be **preserved wholesale** (these constrain the grill as much as the problems do):

- **Output parity with chat by construction (#4301).** Finished cells render through the exact same `partitionTurn` → `AssistantTurn`/`AgentTurn` seam as the chat transcript, so the two surfaces cannot drift in formatting. `notebook-cell-output.tsx:49-61`, corroborated across three dimensions. *This is the single best structural decision on the surface — extend it (to streaming), don't touch it.*
- **Tool results re-hydrate verbatim from the message record.** `transformMessages` maps persisted `tool-invocation` parts to `dynamic-tool` with `output: p.result`, so `executeSQL` `{columns, rows}` tables and charts survive reload without re-querying. `packages/types`/`use-conversations` `transformMessages` (`conversation.ts:233-263`).
- **The tenant-authz boundary is solid.** `scopeClause` (`conversations.ts:54-75`) is threaded through every notebook CRUD helper; `updateNotebookState` is scoped (`conversations.ts:985-991`) — user A cannot PATCH user B's `notebook_state`. Public shares strip internal conversation IDs (`routes/conversations.ts:1548-1551`) and org shares fail closed on null `orgId` (`:1526`, #1727).
- **Per-cell `ErrorBoundary` with in-place Retry** so one cell's render crash never takes down the notebook. `notebook-shell.tsx:304-314`.
- **Fork carries the full execution context forward** — `connection_id`, `connection_group_id`, `routing_mode`, reach, and `answer_style` are inherited by branches, and both fork & convert delete the half-created row on failure (no orphans). `conversations.ts:1044-1071,1093-1102,1224-1276`.
- **The dashboard bridge is real and end-to-end** (not vestigial): `DashboardBridgeProvider` → `sql-result-card` → `AddToDashboardDialog` → `onDashboardCardAdded`. `notebook-cell.tsx:42-46,115`, `sql-result-card.tsx:78-98,271-281`.
- **Careful hygiene throughout** — thorough dark-mode + a11y (`role`/`aria-label`/`sr-only`/focus rings), responsive toolbar that collapses to a kebab, clipboard fallbacks, per-cell export isolation with placeholders, backslash-before-pipe markdown-table escaping, and stale-write `cancelled` guards on async loads.

**Where the problems live:** at the seams, and specifically in the gap between *what the notebook shows the user locally* and *what is actually persisted / shared*. The notebook is a curation layer (reorder, hide, delete, add text, fork) painted on top of a raw chat transcript — but the curation is largely **display-only illusion**. Deletes don't delete server-side, reorders don't reach the agent, the save wire drops fork and dashboard metadata, and "Share as Report" throws the entire projection away and ships the raw transcript. Every CRITICAL is a variant of the same root: **the notebook projection and the persisted/shared truth have diverged, silently.**

---

## Ranked findings

### CRITICAL

#### C1 — Editing or re-running an earlier cell silently destroys every downstream cell `verified`
- **Anchors:** `use-notebook.ts:43-50` (`truncateMessagesForRerun` = `messages.slice(0, index)`), `use-notebook.ts:561-596` (`rerunCell` → `setMessages(truncated)` → re-send), `use-notebook.ts:620-643` (`deleteCell` truncates + drops all cells with `number >= cell.number`), `notebook-cell.tsx:77-82,100,103` (both the Run ▶ button and edit-submit call `onRerun`), `notebook-cell-input.tsx:35-40,69` (Enter runs), `delete-cell-dialog.tsx:31-33` (the *delete* path has a cascade-warning dialog; rerun/edit has none).
- **Failure scenario:** A business user builds a 10-cell analysis, fixes a typo in the prompt of cell 3, and presses Enter (or Run). `rerunCell` truncates the message array to everything *before* cell 3 and re-sends — cells 4–10 and all their SQL, tables, and charts are **permanently gone, with no dialog and no undo**. The destructive *delete* path shows a clear cascade warning; the far more common *edit/rerun* path shows none. This breaks the defining promise of a notebook — that cells are independently re-runnable — and to a trial admin evaluating the product it reads as data loss on a routine edit. (Found independently by the UX and agent-path dimensions.)
- **Fix direction:** Re-run should regenerate only the target cell's assistant turn in place (splice `[userMsg, assistantMsg]`, re-insert), preserving downstream messages; or, if history-coherence forces truncation, gate rerun behind the same "this removes N downstream cells" confirmation the delete path already has. **Entangled with the rerun-semantics design (see grill agenda) — doc-only.**

#### C2 — Ordinary notebook edits erase fork/branch metadata; server does a blind full-column overwrite `verified`
- **Anchors:** `use-notebook.ts:462-469` (client save wire — includes only `cellOrder`/`cellProps`/`textCells`/`dashboardCards`; **omits `branches`, `forkRootId`, `forkPointCellId`**), `use-conversations.ts:177-187` (full-body PATCH), `conversations.ts:986-990` (`UPDATE ... SET notebook_state = $1` — blind whole-document replace, no merge, no version guard), wire type `types/src/conversation.ts:147-163`.
- **Failure scenario:** The first real edit (collapse a cell, reorder, add a text cell) after the ~1s suppression window rebuilds the wire *without* the fork fields and the server overwrites the whole column. On a **root** with forks → `branches[]` is wiped, the branch switcher vanishes, and the forks become unreachable orphan rows. On a **fork child** → `forkRootId`/`forkPointCellId` are wiped, so `loadRootBranches` (`page.tsx:148-176`) never runs and the lineage is silently gone. Permanent — localStorage doesn't carry these fields either. A user who forks to explore a variant, then tweaks a cell, loses the entire branch structure. **This is the CRITICAL because it converts the headline feature (branching) into a data-loss trap on the most ordinary action.**
- **Fix direction:** Server-side read-modify-write that preserves `branches`/`forkRootId`/`forkPointCellId`, or have the client seed the wire from `initialServerState` and carry those three fields through every save. **The fix touches the persistence model the grill is redesigning — doc-only.** (The narrow sibling — a schema field the server strips — *was* fix-invariant and is filed as #4535.)

#### C3 — Share-as-Report renders the raw chat transcript, discarding the entire notebook projection `verified`
- **Anchors:** `notebook/page.tsx:271-277` (`handleShareAsReport`), `shared/[token]/page.tsx:122-127` (filters `messages` to text-only user/assistant turns), `:209-217` (everything else collapses into an "N steps not shown" footnote), `embed/view.tsx:40-88`, `shared/lib.ts:11-25` (the API *does* ship `SharedNotebookState` with `cellOrder`/`textCells`/`cellProps` — neither the page nor the embed reads it).
- **Failure scenario:** A business user curates a notebook — reorders cells, adds explanatory text cells, collapses noise, deletes a bad query — then "Share as Report" to a stakeholder. The shared page **ignores `notebookState` entirely**: it drops every SQL result table, chart, and Python output, and loses cell order, text/markdown cells, and collapse state. The stakeholder sees a bare Q&A transcript with no data — the literal opposite of a "report." For a surface whose sharing affordance is named "Share as **Report**," this is the highest-leverage disappointment in the product.
- **Fix direction:** Render the shared view from `notebookState` when `surface === "notebook"`: apply `cellOrder`, interleave `textCells`, serialize tool outputs (reuse `notebook-export.ts`'s serializers), honor hidden/deleted cells. Fall back to the transcript for chat surfaces. **Entangled with C4 (what "hidden/deleted" means) and the projection design — doc-only.**

#### C4 — "Deleted" cells are not deleted server-side; they reappear on reload and leak in public shares `verified`
- **Anchors:** `use-notebook.ts:600-646` (query-cell `deleteCell` only calls `chat.setMessages(truncated)` — local React state), `use-notebook.ts:442-469` (server save persists only `cellProps`/`textCells`/`cellOrder`/`dashboardCards` — never a message deletion), `shared/lib.ts:5-9` + `shared/[token]/page.tsx:123-127` (the public share reads the raw `messages` table directly).
- **Failure scenario:** A user deletes a cell containing a wrong or sensitive query/result, believes it's gone, then shares the notebook or reloads. `deleteCell` truncates messages only in local state and never persists a deletion; the `messages` rows survive. On reload, `buildCellsFromMessages` rebuilds the "deleted" cells from the server. On a **public share** (unauthenticated link), the share endpoint reads `messages` directly and exposes exactly the content the user thought they removed. Silent data leak on a public link, plus a broken mental model ("I deleted that").
- **Fix direction:** Either persist deletions (truncate `messages` server-side, or store a deleted/hidden message-id set in `notebookState` that both the loader *and* the share endpoint honor), or relabel the action as local-only. **The fix is the deletion-model design itself — doc-only, but it is the security-flavored one; flag prominently in the grill.**

### HIGH

#### H1 — No way to stop or cancel a running agent turn; the whole surface freezes behind one request `verified`
- **Anchors:** `notebook/page.tsx:116` (`useChat` destructures `messages, setMessages, sendMessage, status, error` — **no `stop`**; chat wires `stop`), no `stop`/`abort` anywhere under `components/notebook/` (grep returns only `e.stopPropagation`), `notebook-shell.tsx:62,360` (composer `disabled={anyRunning}`), `notebook-cell-toolbar.tsx:49,59,84` + `notebook-cell.tsx:101,129` (every cell toolbar disabled while any cell runs).
- **Failure scenario:** A user fires a heavy or runaway turn (multi-step fanout, a slow 30s query, a retry loop). The composer is disabled, every cell's toolbar is disabled, the fork pill is disabled, and there is no Stop button. The only escape is a full page reload — which drops the stream and can leave an orphaned running cell, and the agent is metered for work the user already knows they don't want.
- **Fix direction:** Pull `stop` from `useChat`, thread it through `useNotebook`, and surface a Stop button on the running cell (the toolbar is already `status`-aware). At minimum keep the composer usable to queue the next question.

#### H2 — The notebook never shows a live "working" feed; the live-render branch is dead code `verified`
- **Anchors:** `use-notebook.ts:534-542` (`isRunning = chat.status !== "ready" && !assistantMsg && isLastCell`; the cell's `status` is `isRunning ? "running" : cell.status`), `use-notebook.ts` (verified: `cell.status` in `cellState` is only ever `"idle"` — set at `:28,308,381,524,796`, never `"running"`), `notebook-cell-output.tsx:55-61` (finished branch calls `<AgentTurn>` **without** a `streaming` prop the instant the assistant message exists), `notebook-cell-output.tsx:63-92` (live part-by-part branch, reachable only when `status === "running" && assistantMessage` — a state that can never occur), vs chat `atlas-chat.tsx:1332,1362` (`streaming={isStreamingTurn}`).
- **Failure scenario:** During an agent run the notebook shows a typing indicator, then — the moment the first token arrives — jumps straight to the **finished** turn shape. The live working-activity feed (#4300) never renders, "Copy answer" appears while the stream is still open, and the layout churns exactly the way #4300 fixed for chat. Watching the agent think — the marquee moment of an agentic notebook — is simply missing. Meanwhile `notebook-cell-output.tsx:63-92` is unreachable dead code and its explanatory comment (`:49-54`) describes behavior that doesn't happen.
- **Fix direction:** Derive a real streaming flag (e.g. `status === "streaming" && isLastCell`) independent of whether the assistant message object exists, keep the running state true through the stream, pass `streaming` into `<AgentTurn>`, and delete the dead branch. **Note the seam:** this is the natural extension of the #4301 parity win — the same convergence, applied to the running cell.

#### H3 — Blind last-write-wins overwrite: two tabs / a fork-in-flight clobber each other silently
- **Anchors:** `conversations.ts:986-990` (`updateNotebookState` — no version/etag), fork read-modify-write **outside any transaction** at `routes/conversations.ts:988-1019`.
- **Failure scenario:** `notebook_state` has no concurrency token. Two tabs on the same notebook → last debounced save wins, silently discarding the other tab's text cells / reorder. Worse, the **fork route** reads source state (`:988`) then writes it back (`:1017`) with no transaction: a debounced save landing between the read and write clobbers the newly-appended branch, or the fork's write clobbers the user's concurrent edit. All lost updates are silent.
- **Fix direction:** Add an optimistic-concurrency token (a `notebook_version` in the JSONB or a column) and reject stale writes; move the fork's branch-append into a single `UPDATE ... jsonb_set` or a transaction.

#### H4 — Debounced fire-and-forget save loses the last edit on navigation and fails silently
- **Anchors:** `use-notebook.ts:442-473` (debounce `return () => clearTimeout(timer)` on unmount/dep-change), `use-conversations.ts:177-187` (`catch` → `console.warn` only), `page.tsx:225-229` (`saveToServer` fire-and-forget).
- **Failure scenario:** Navigating away < 500ms after the last edit clears the pending timer and **that edit never reaches the server** — only localStorage has it, so another device or a cache-cleared reload loses it. When a save *does* fire and fails (network/500), the error is `console.warn`-only — for a surface users treat as a saved document, this is silent data loss with no "not saved" signal.
- **Fix direction:** Flush the pending save on unmount / `beforeunload` (or `keepalive` fetch), and surface persistent save failures as a visible "not saved" indicator.

#### H5 — Branch/fork pointers are dangling-by-design; deleting a conversation directly strands them
- **Anchors:** branches stored only on root (`types/src/conversation.ts:153`); `deleteBranch` cleans the root array (`conversations.ts:1105-1156`) but generic `deleteConversation` is a plain scoped `DELETE` with **no branch reconciliation** (`conversations.ts:1281-1299`); JSONB `branches[].conversationId` / `forkRootId` are app-level pointers with **no FK/cascade** (`schema.ts:186`); `loadRootBranches` swallows the root-fetch 404 into an empty list (`page.tsx:166-171`).
- **Failure scenario:** (a) Delete a fork from the sidebar (not via `deleteBranch`) → the root's `branches[]` still lists it; clicking it 404s ("Failed to load conversation"). (b) Delete the **root** directly → every fork child keeps `forkRootId` pointing at a dead conversation; the branch switcher silently disappears on the survivors and siblings become mutually invisible. Nothing ever reconciles these orphan pointers.
- **Fix direction:** On `deleteConversation`, if the row is a fork child, prune it from the root's `branches[]`; if it's a root, relink/cascade children (or block deletion). Or model branches relationally with a real FK. Surface a user-visible message when root branches can't load instead of hiding the selector.

#### H6 — Multi-level fork trees fragment: grandchild branches are invisible and unnavigable
- **Anchors:** `conversations.ts:1008-1013` (child `forkRootId = sourceRoot ?? id` → always the *top* root, but branch metadata is written to the *immediate* source's `notebook_state.branches` at `:988-1006`), `notebook/page.tsx:119-176` (`buildForkInfo` + `loadRootBranches` load branches only from `forkRootId`).
- **Failure scenario:** Fork A → B, then fork a cell of B → C. C's `forkRootId` is A, but C's branch metadata lands on **B's** state. Any conversation's selector loads branches only from its `forkRootId` (A), so A shows B but never C. Grandchild C is orphaned from the tree UI — reachable only via the flat sidebar. Branch structure silently collapses beyond one level.
- **Fix direction:** Either always register branch metadata on the true root (walk to `forkRootId` before appending), or make `buildForkInfo` assemble a real tree across intermediate parents.

#### H7 — Export silently drops charts and every non-SQL/Python tool output
- **Anchors:** `notebook-export.ts:67-102` (`extractToolData` handles only `executeSQL` and `executePython`), `:104-156` (serializers emit SQL/table/code/stdout only), `:31-36` (tables capped at 100 rows with no full-set option).
- **Failure scenario:** A trial admin exports a notebook to share offline. Charts render client-side from row data and are **never emitted** (only the raw table is), so a chart-heavy analysis exports as bare tables. Outputs from `querySalesforce`, `searchKnowledge`, `createDashboard`, `createLinearIssue` are dropped entirely with no placeholder — the doc looks like steps are missing.
- **Fix direction:** Emit an image/placeholder for chartable results, and add a generic `default` branch in `extractToolData` that serializes tool name + a summary so no step disappears silently.

### MEDIUM

#### M1 — Reordered cells are a display-only illusion; the LLM sees raw chronological order `verified`
- **Anchors:** `use-notebook.ts:504-510` (display order applied only to `orderedCellState` for rendering), `:546-559` (`appendCell` → `sendMessage` sends `chat.messages` in message order), `page.tsx:116` (transport sends the raw `messages`). `cellOrder` is persisted for display (`conversation.ts:149`) but never reorders the message array.
- **Failure scenario:** A user drags cells to build a narrative (moves "costs" above "revenue"), then asks "summarize the trend above." The agent receives the original chronological order, not the visual order the user is reading — its context and the user's mental model diverge, and it references the wrong "above."
- **Fix direction:** Either send messages in display order when a custom `cellOrder` exists, or make explicit in-product that reordering is presentation-only.

#### M2 — "Re-run" is non-deterministic LLM regeneration, not query re-execution
- **Anchors:** `use-notebook.ts:561-596` (`rerunCell` → truncate → `sendMessage`), `:159-184` (`extractExecutionMetadata` snapshots old rowCount/executionMs for the comparison badge).
- **Failure scenario:** The `previousExecution` comparison badge frames re-run as "refresh this result," but re-run re-asks the LLM from scratch — it can emit different SQL, a different chart, or a different narrative for the same prompt. A user re-running "revenue by month" to pick up new data may get a structurally different cell. There is no path to re-execute the exact persisted SQL.
- **Fix direction:** Offer a deterministic "re-run query" that re-executes the cell's last `executeSQL` input against the datasource (the SQL is already in the persisted tool part), distinct from "regenerate with the agent."

#### M3 — Switching conversations shows the previous notebook's cells with no loading state `verified`
- **Anchors:** `notebook/page.tsx:181-222` (on `conversationId` change it fires async `load()` but never clears `messages`/`serverNotebookState` before the fetch resolves; only the empty-id "New" path clears at `:185-192`), `notebook/loading.tsx:1-3` (`return null` — no route skeleton).
- **Failure scenario:** Clicking conversation B while viewing A keeps rendering **A's cells** until B resolves — no spinner, no skeleton, no dimming. On a slow network the click looks like a no-op, or worse, like B contains A's content.
- **Fix direction:** Set a loading flag on `conversationId` change and render a skeleton until the fetch settles, or optimistically clear cells on switch.

#### M4 — A failed conversation load strands the user with a Dismiss-only banner and no retry `verified`
- **Anchors:** `notebook/page.tsx:207-214` (sets `error`, does *not* advance `lastLoadedIdRef` on failure), `:336-343` (banner offers only **Dismiss**), `:222` (load effect keyed solely on `[conversationId]`, so nothing re-triggers it).
- **Failure scenario:** A transient 500/network blip on load leaves a red "Failed to load conversation. Please try again." banner whose only action is Dismiss — and because the id hasn't changed, nothing re-runs the load. The user must pick a different conversation and come back, or reload the page. "Please try again" has no "try again."
- **Fix direction:** Add a Retry button that re-invokes the load (key the effect on a retry nonce).

#### M5 — Keyboard navigation index desyncs from real focus; a document-level listener fires from a stale cell `verified`
- **Anchors:** `use-keyboard-nav.ts:34` (`focusedIndex` starts at 0), `:44-48` (`focusCell` is the only writer), `:62-100` (document-level `keydown` drives Arrow/Enter/Delete from `focusedIndex.current`), `notebook-cell.tsx:54` + `notebook-text-cell.tsx:80` (`tabIndex={0}` but **no `onFocus`** to update the index).
- **Failure scenario:** A keyboard user Tabs/clicks to cell 5 and presses ArrowDown → focus jumps from the stale index 0, not from 5. Because the listener is on `document`, pressing **Enter while focus is on any non-input element** drops an unrelated cell into edit mode.
- **Fix direction:** Set `focusedIndex.current` on each cell's `onFocus`; scope the listener to the notebook container rather than `document`.

#### M6 — Chat→notebook conversion is a one-way duplicate with no backref, no reverse, and no idempotency
- **Anchors:** `conversations.ts:1201-1266` (copies all messages into a new `surface:"notebook"` conversation, leaves the original untouched, stores no link), `use-conversations.ts:220-231`, `conversation-item.tsx:85-86` (button hidden only when already a notebook).
- **Failure scenario:** Converting produces two conversations with identical content and no link; the original chat lingers in the sidebar and must be deleted by hand. There is no notebook→chat path, and converting twice makes two independent copies. History bloat and confusion. (Also: `convertToNotebook` copies messages but not the source's `notebook_state`, so a notebook→notebook convert drops text cells / reorder.)
- **Fix direction:** Record `converted_from`/`converted_to` for a "go to notebook" affordance + source archiving; guard against re-converting; carry `notebook_state` when the source has one.

#### M7 — Sidebar gives forks/notebooks/chats no visual distinction; branches clutter one flat list
- **Anchors:** `conversation-item.tsx:112-117` (title + relative time only; no surface icon/badge), `conversations.ts:1053` (`${title} (fork)`), `workspace-shell.tsx:115,151` (the whole unfiltered list feeds both surfaces).
- **Failure scenario:** A user who forks a notebook 5 times sees 5 extra sidebar rows all titled "… (fork)", indistinguishable from chats and from the parent, with no nesting under the root and no icon telling a notebook from a chat.
- **Fix direction:** Add a surface icon/badge to `conversation-item`; group branches under their root or filter them out of the top-level list (they're reachable via the branch selector).

#### M8 — No size or cardinality limits on `notebook_state`; unbounded JSONB is persistable
- **Anchors:** `routes/conversations.ts:67-75` (no `.max()` on `cellOrder`/`branches`; `textCells[].content` is an unbounded `z.string()`; `cellProps` an unbounded record), stored as `jsonb` with no DB size guard (`schema.ts:186`).
- **Failure scenario:** A client can persist an arbitrarily large document — megabytes of `textCells`, thousands of branches — bloating the `conversations` row and every `getConversation` read (which returns the full column). No per-request cap at the route seam.
- **Fix direction:** Add `.max()` bounds on arrays and a length cap on `textCells` content, and/or a total serialized-size check in `updateNotebookState`.

#### M9 — `notebook_state` shape permits orphan/duplicate cell references; no referential validation against messages
- **Anchors:** `types/src/conversation.ts:147-163` + schema `:67-75`. `cellOrder` may list nonexistent or duplicated cell IDs; `cellProps`/`textCells`/`dashboardCards` keyed by arbitrary strings; `forkPointCellId` not validated to reference a real message.
- **Failure scenario:** When messages are deleted/compacted (ADR-0020), cell IDs in `cellOrder`/`cellProps` become dead keys that accumulate forever (no GC). A duplicated `cellOrder` entry makes `orderedCellState` render the same cell twice → React key collision. `forkPointCellId` can point at a compacted-away message.
- **Fix direction:** De-dupe/validate `cellOrder` on save; prune keys that no longer correspond to live cells during a reconcile pass.

### LOW

#### L1 — The notebook agent has no notebook-awareness — it is chat with a different frame
- **Anchors:** `chat.ts:1423` (`surface: "web"` hardcoded on conversation creation), `conversation.ts:4` (`"notebook"` is a defined `Surface` value this path never sets). Answer-style/prompt resolve to the web default, identical to chat.
- **Failure scenario:** Nothing breaks, but the agent never knows it is authoring a cell in a persistent document — it won't title outputs, reference prior cells as cells, or adopt a document voice. The plumbing (`Surface = "notebook"`) exists and is unused.
- **Fix direction:** Send `surface: "notebook"` from the notebook transport and give it a surface default (voice/prompt addendum), the way Slack gets `conversational`.

#### L2 — Fork is discoverable only as an ambiguous "What if?" ghost pill
- **Anchors:** `notebook-cell.tsx:123-137` (low-contrast ghost button labeled "What if?", shown only after output), `notebook-cell-toolbar.tsx:24` ("Fork is intentionally absent" from the toolbar).
- **Failure scenario:** Branching is a headline capability, but the entry point reads as a generic suggestion prompt, not "create a branch." A user exploring alternatives is unlikely to connect "What if?" with the branch selector that later appears.
- **Fix direction:** Label it "Branch from here" (or a `GitBranch` tooltip), and/or surface fork in the cell toolbar.

#### L3 — Text-cell "done editing" affordance is non-obvious
- **Anchors:** `notebook-text-cell.tsx:63-68` (only Escape commits — Enter inserts a newline), `:105,132-140` (the ✓ button appears only on hover; no hint text).
- **Failure scenario:** A user inserts a text cell, types a note, presses Enter expecting to finish, gets a newline, and nothing tells them Escape (or the hover-only ✓) commits — they may think the cell is stuck.
- **Fix direction:** Add an "Esc to finish" caption, mirroring the query cell's "Enter to run" hint.

#### L4 — Branch identity is opaque to non-technical users
- **Anchors:** `fork-branch-selector.tsx:26-29,168-170` (`formatForkPoint` shows the first 8 chars of a raw message UUID — "from a1b2c3d4"), default label `Fork from cell N` (`use-notebook.ts:706`).
- **Failure scenario:** The branch dropdown shows "Branch 1 — from a1b2c3d4", conveying nothing about where or why the branch diverged. Branch management is guesswork without renaming each one.
- **Fix direction:** Show the fork-point cell number and/or a snippet of the originating question instead of the UUID.

#### L5 — Notebook routes ignore the `deleted_at` soft-delete column
- **Anchors:** `deletedAt` exists (`schema.ts:190`) and the memory route references a soft-delete guard (`routes/conversations.ts:1307-1311`), but `getConversation`/`updateNotebookState`/`scopeClause` never filter `deleted_at IS NULL` (`conversations.ts:54-75,862-865,986-990`).
- **Failure scenario:** Notebook state can be read/written on a soft-deleted conversation. Low impact today because `deleteConversation` hard-deletes, so the column is effectively vestigial for conversations — but it's a latent bug if soft-delete is ever activated.
- **Fix direction:** Either drop the column for conversations or add `AND deleted_at IS NULL` consistently.

---

## Issues filed (Step 4)

Only one finding met the bar (broken today **and** fix invariant under any grill outcome):

- **#4535** — `fix(notebook): NotebookStateWireSchema omits dashboardCards, so the server strips notebook→dashboard associations on every save`. This is the narrow, fix-invariant sibling of C2: the client sends `dashboardCards` (`use-notebook.ts:467`), the type declares it (`conversation.ts:161-162`), but the server Zod schema (`routes/conversations.ts:67-75`) omits it, so `z.object` strips it and cross-device / post-cache-clear loads lose the association. The fix — add the field to the schema and pin it against the type — is correct no matter what the grill decides about the notebook↔dashboard bridge. *(Milestone should be set to "Architecture Backlog" to match the sibling elevation filings; the filing tool couldn't resolve the milestone by name — set it manually or via `/tidy`.)*

Everything else stays in this doc: each broken finding's fix is entangled with a design decision the grill exists to settle (the deletion model, the share projection, the fork data model, the rerun semantics). Filing them standalone would pre-decide the design — exactly the boundary Step 4 draws.

---

## Grill agenda

The findings force these design questions. Phrased as questions — the grill walks this list.

1. **What is a cell, really — a view of a message, or an editable unit?** Today reorder/delete are display-only illusions (C1, C4, M1). Does the notebook become a true document model (cells are the source of truth, messages are an implementation detail), or does it stay an honest projection where the UI stops offering edits it can't persist?
2. **What does "re-run" mean?** Regenerate-with-the-agent (non-deterministic, current behavior) vs re-execute-the-saved-SQL (deterministic refresh) — and if editing an upstream cell must truncate, is truncation the right model at all, or should edits branch? (C1, M2)
3. **What does a viewer of a shared notebook see?** The curated projection (order, text cells, hidden cells, tool outputs) or the transcript? And what is the contract that a "deleted" cell is *not* in the share? (C3, C4 — the security-flavored one.)
4. **What is the fork/branch data model?** JSONB pointers with app-level reconciliation (current, and dangling-by-design — C2, H5, H6) vs a relational branch model with real FKs? This decision cascades into the save-merge question, multi-level trees, and delete cascades.
5. **How does a notebook save — and how does the user know it saved?** Debounced fire-and-forget with silent failure and last-edit loss (H4), no concurrency control (H3), a blind full-column overwrite that drops fields the wire doesn't send (C2). Does the notebook get a real document-save model (explicit save state, optimistic concurrency, field-preserving merge)?
6. **Is the agent a first-class citizen of this surface?** No `surface:"notebook"`, no notebook-aware voice, no live streaming feed (the #4301 parity win stops at the finished state; the running cell is dead code — H2, L1). Is the marquee "watch the agent build your notebook" moment in scope?
7. **Where does the agent's context end and the user's curation begin?** If the user reorders/hides/adds text cells, does any of that reach the agent on the next turn, or is the agent forever anchored to raw chronological history? (M1)

---

## Handoff

**Next: run `/grill-with-docs` with this doc.** The findings are not purely presentational and not page-scoped — they turn on load-bearing design decisions (the cell/document model, the share projection, the fork data model, save semantics), so the grill is warranted. Do not slice these into issues yet; `/to-issues` will cut different slices than the audit found, and the grill will settle the model first.
