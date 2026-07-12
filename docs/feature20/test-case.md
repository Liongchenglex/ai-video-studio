# F-20 AI Assistant Director — Test Cases

**Date:** 2026-07-12

Cases marked **PASS** were executed via `npm run test` (vitest, no network/
DB — pure logic only, per this repo's `vitest.config.ts` convention) or
were live-verified during the Task 9 Stage-1 gate (a real $0.25 director
run against a throwaway project, cited inline where applicable). Cases
marked **(paid — pending controller/user execution)** bill real
Anthropic + fal.ai usage and are specified here with acceptance criteria
and expected outcome but were not run in this pass — this is Task 15's
"hero run," gated on the user's explicit spend go-ahead per Task 15 Step
4. Cases marked **(manual — pending controller/user execution)** are free
but require a live browser/dev-server session and are likewise left for
that pass.

---

## 1. Unit — automated (vitest)

### TC-U-1: Budget metering (`tests/unit/director-budget.test.ts`)
- **Acceptance criteria:** `usageCostUsd` prices an Anthropic usage block
  at the Sonnet rate card ($3/M input tokens, $15/M output tokens),
  rounded to 4 decimals; `assertWithinBudget` refuses a spend that would
  push `spentUsd + estUsd` over `budgetUsd`, naming the concrete dollar
  amounts in the refusal text; an exact-fit spend (`spent + est ===
  budget`) is allowed, not refused.
- **Expected outcome:** all 3 assertions pass.
- **Edge cases covered:** the refusal message names spent/estimated/budget
  numbers verbatim (so it's safe to surface directly as a tool result /
  feed event without reformatting); the exact-fit boundary is inclusive.
- **Results:** PASS (3/3, `npm run test`, 2026-07-12).

### TC-U-2: Briefing text assembly (`tests/unit/director-context.test.ts`)
- **Acceptance criteria:** `buildBriefingText` renders all seven sections
  (Script, This beat, This shot, Neighbors, Cast & locations, Budget,
  Guidance) in fixed order; the Guidance section is omitted entirely when
  `guidance` is `null`, present after Budget when set; entities render
  `(sheet ready)`/`(no sheet)` correctly; the budget line shows
  `spent $X of $Y`; the scratch settings line renders camera/ends-on/
  model/duration, including all-unset state without throwing; neighbor
  lines show the prompt + `endsOn` when present and a placeholder when
  absent; project brief/style/script/beat text render verbatim, including
  when `null`.
- **Expected outcome:** all 10 assertions pass.
- **Edge cases covered:** null `projectBrief`/`styleString`/`script`
  (placeholder text, no throw); zero tagged/sheet-ready entities; unset
  camera/model/duration scratch fields.
- **Results:** PASS (10/10, `npm run test`, 2026-07-12).

### TC-U-3: Approve promotion mapping (`tests/unit/director-resolve.test.ts`)
- **Acceptance criteria:** `promotionPlan` maps every directing field
  (camera, ends-on, negative prompt, duration, refs, motion prompt) from
  a full `settingsSnapshot` onto the shot patch; `clipModel` in the patch
  always comes from `run.candidateModel`, never a `clipModel` key in the
  snapshot; the clip copy op (`clipCandidatePath` → shot's standard
  `clip.mp4` key) is always present; the image copy op is present only
  when `scratchImageEdited` is `true`; the SFX reset
  (`sfxPath: null, sfxStatus: "pending"`) is always included; an
  `endsOn: "custom"` snapshot copies the run-prefixed end frame to the
  shot's standard `end-frame.png` key, but is skipped when the snapshot's
  `endFramePath` already **is** the standard key (no self-copy); no
  end-frame copy op is emitted when `endFramePath` is absent; the
  function throws (not a partial plan) when the run has no
  `settingsSnapshot` or no `clipCandidatePath`.
- **Expected outcome:** all 10 assertions pass.
- **Edge cases covered:** candidateModel vs. snapshot's absent clipModel
  key (deliberate design, not an oversight — see feature.md); the
  self-copy guard for an inherited (not director-authored) custom end
  frame; both throw-paths (missing snapshot, missing candidate).
- **Results:** PASS (10/10, `npm run test`, 2026-07-12).

### TC-U-4: Tool registry invariants + all 16 tools (`tests/unit/director-tools.test.ts`)
- **Acceptance criteria:** the registry has exactly 16 tools; every entry
  satisfies the CI-enforced invariant (description ≥ 20 chars, truthy
  `inputSchema`, callable `estCostUsd`); enums are derived from app
  sources, not hand-copied (camera moves, clip models, entity types);
  `toAnthropicTools()`/`capabilityInventory()` cover every registered
  tool with no omissions; only `propose_entity_update` carries
  `sharedStateEdit: true`; setting tools (`set_camera_move`,
  `set_ends_on`, etc.) mutate `ctx.scratch` in place and cost $0; both
  Kontext tools (`edit_start_image`, `create_custom_end_frame`) estimate
  $0.04 and reject an empty/over-500-char instruction *before* any fal
  call; `set_ends_on` rejects `"custom"` when no scratch end frame exists;
  `create_entity` mirrors the entities-route guards (name required/≤80
  chars, valid type enum, description ≤500 chars, duplicate-name
  rejection scoped to the project) and returns the new id; `generate_
  entity_sheet` estimates $0.04, rejects a foreign entity, calls the
  existing `generateEntitySheet` with no wrapping, and returns
  `ok:false` (not a throw) when it fails; `tag_entity`/`untag_entity` are
  free, reject a foreign/untagged/already-tagged entity, perform a REAL
  `shots.referencedEntityIds` update AND sync `ctx.scratch`, and enforce
  the 8-tag cap; `propose_entity_update` is marked `sharedStateEdit`,
  performs **zero** DB writes (routes only to `ctx.addProposal`), rejects
  a foreign entity without proposing, and enforces its 500/300-char caps.
- **Expected outcome:** all 34 assertions pass.
- **Edge cases covered:** duplicate entity name (case-insensitive, scoped
  to project); tag cap boundary (8th tag succeeds, 9th refused); duplicate
  tag attempt (distinct message from the cap refusal); untag of a
  not-currently-tagged entity; `generateEntitySheet` throwing mid-call
  (caught, `ok:false`, not an unhandled rejection); every Kontext/entity
  tool's foreign-project rejection (ownership never assumed from the
  input alone, always re-checked against `ctx.project.id`).
- **Results:** PASS (34/34, `npm run test`, 2026-07-12).

### TC-U-5: Frame sampling (`tests/unit/frame-sampler.test.ts`)
- **Acceptance criteria:** `sampleVideoFrames(buffer, count)` returns
  exactly `count` JPEG frame buffers in order from a real short test
  video; a non-video buffer throws a descriptive error rather than
  hanging or crashing the process.
- **Expected outcome:** both assertions pass.
- **Edge cases covered:** the "non-video input" failure path (garbage
  bytes fed to ffmpeg).
- **Results:** PASS (2/2, `npm run test`, 2026-07-12; exercises the real
  bundled `ffmpeg-static` binary — not mocked).

### TC-U-6: Scratch settings mapping (`tests/unit/directing-settings.test.ts`)
- **Acceptance criteria:** `settingsFromShot` maps a shot row to
  `DirectingSettings` and computes `slotSeconds` from the shot's beat
  bounds; yields `slotSeconds: null` when bounds are missing rather than
  throwing or defaulting to 0.
- **Expected outcome:** both assertions pass.
- **Edge cases covered:** missing beat-bound data (the director's own
  duration-resolution and briefing text both depend on this not
  crashing).
- **Results:** PASS (2/2, `npm run test`, 2026-07-12).

**Director-relevant suite total:** 6 files (director-budget,
director-context, director-resolve, director-tools, frame-sampler,
directing-settings), 61 tests, 61 passed. **Whole-repo suite total:** 13
files, 103 tests, 103 passed, 0 failed (`npm run test`, 2026-07-12).

---

## 2. API — routes & validation

### TC-API-1: 409 double-start guard
- **Action:** `POST .../director` with a valid budget while the shot
  already has an active (`running`) run; repeat with an
  `awaiting_approval` run.
- **Acceptance criteria:** both cases 409 `"A director run is already
  active for this shot"` — the app-level pre-check
  (`activeRunForShot`) catches the ordinary case; a true race (two starts
  passing the pre-check simultaneously) is caught by the
  `director_runs_one_active_per_shot` partial unique index, whose 23505
  is mapped to the same 409 by `isActiveRunUniqueViolation`.
- **Expected outcome:** 409, no second `director_runs` row inserted, no
  second `shot/director.run` event sent.
- **Edge cases:** a `stopped` or terminal (`approved`/`rejected`/
  `failed`) run does NOT block a fresh start (only `running`/
  `awaiting_approval` count as active).
- **Results:** PASS — live-verified in the Task 9 Stage-1 gate (real run
  `8afa0b6a` against throwaway shot; a second start while it was active
  409'd as expected, per `.superpowers/sdd/progress.md`'s AD Task 9
  entry).

### TC-API-2: Budget allow-list validation
- **Action:** `POST .../director` with `budgetUsd` of: `0.10` (below
  min), `5.01` (above max), `"1.50"` (string, not number), missing
  entirely, `0.25` (min boundary), `5.00` (max boundary); also with
  `guidance` of 501 chars.
- **Acceptance criteria:** `budgetUsd` must be a finite number in
  `[0.25, 5.00]` inclusive; `guidance`, if provided, must be a string of
  at most 500 chars (empty string normalizes to `null` guidance, not an
  empty string).
- **Expected outcome:** `0.10`/`5.01`/`"1.50"`/missing → 400 with the
  specific message (`"budgetUsd must be a number"` or `"budgetUsd must
  be between 0.25 and 5"`); `0.25`/`5.00` → 202, run created; 501-char
  guidance → 400 `"guidance must be a string of at most 500 characters"`.
- **Edge cases:** a shot with no done still (`imageStatus !== "done"`)
  → 400 `"Generate the shot's still before starting the director"`,
  checked before the budget body is even parsed.
- **Results:** (paid-adjacent — pending controller/user execution; the
  400 paths are free via `curl`, the 202 paths incur real spend once the
  Inngest function runs, so they're deferred to the same pass as the hero
  run below).

### TC-API-3: Resolve preconditions — no run to resolve
- **Action:** `POST .../director/resolve {"action":"approve"}` on a shot
  with no run at all, or whose only run is `running` (not yet
  resolvable).
- **Acceptance criteria:** the route only acts on
  `resolvableRunForShot` (`awaiting_approval` or `stopped`); anything
  else is a 400, not a 404 or a silent no-op.
- **Expected outcome:** 400 `"No director run awaiting resolution for
  this shot"`.
- **Edge cases:** a `failed` run is also not resolvable (400, same
  message) — a failed run has no promotable state.
- **Results:** (free — pending controller/user execution via `curl`
  against a seeded throwaway shot).

### TC-API-4: Resolve preconditions — approve without a candidate
- **Action:** `POST .../director/resolve {"action":"approve"}` on an
  `awaiting_approval` run that finished via `finish("best_effort")` with
  no `generate_candidate_clip` call ever having succeeded (settings-only
  run, `clipCandidatePath` is `null`).
- **Acceptance criteria:** approve is refused *before* the claim is
  attempted — `run.clipCandidatePath` is checked first, so a candidate-
  less run's status is never touched by a failed approve attempt.
- **Expected outcome:** 400 `"This run has no candidate clip to
  approve"`; the run's status remains `awaiting_approval` afterward
  (verifiable by a follow-up `GET`).
- **Edge cases:** the UI-level guard (`DirectorVerdictCard`'s Approve
  button `disabled={busy || !run.candidateUrl}`) prevents this from being
  reachable through normal use — this TC exercises the server-side
  backstop directly.
- **Results:** (free — pending controller/user execution via `curl`).

### TC-API-5: Resolve — lost race returns 409, not a silent overwrite
- **Action:** issue two concurrent `POST .../director/resolve` calls
  against the same `awaiting_approval` run — one `{"action":"approve"}`,
  one `{"action":"dismiss"}` — fired back-to-back with no serialization.
- **Acceptance criteria:** `claimRunApproval`/`claimRunRejection`'s
  conditional `UPDATE … WHERE status IN (...)` guarantees exactly one of
  the two requests has its `WHERE` clause match (the other's status is
  already flipped by the winner); the loser gets a 409, never a second
  silent status flip or a second promotion attempt.
- **Expected outcome:** exactly one request returns 200 (either
  `status: "approved"` or `status: "rejected"`), the other returns 409
  `"This run was already resolved"`; the shot's real row reflects
  promotion iff the winner was `approve`.
- **Edge cases:** two concurrent `approve` calls racing each other — same
  guarantee, only one executes `promotionPlan`'s copies/patch; a
  same-request retry after a genuine promotion failure (mid-copy R2
  error) is the one case that's expected to eventually succeed on retry,
  since the compensation path restores the pre-claim status rather than
  leaving the run stuck `approved` with a half-applied patch.
- **Results:** (free — pending controller/user execution; reachable via
  two near-simultaneous `curl` calls against a seeded `awaiting_approval`
  run, no paid spend required for the race itself).

---

## 3. UI — inspector, feed, verdict card, storyboard

### TC-UI-1: Feed event rendering (all 5 event types)
- **Action:** Start a director run on a shot with a done still; observe
  the "AI Director" group's live feed as it fills in.
- **Acceptance criteria:** 🎬 critique events show the summary text plus
  per-dimension ✓/✗ + name (+ note when present) and, once a candidate
  exists, two frame thumbnails; 🔧 action events show the tool's plain-
  English message; 💸 cost events show `+$X.XX → $Y.YY / $Z.ZZ`; ❌ error
  events show the failure message in destructive-colored text; 📝 note
  events (the stuck-guard's "No further actionable changes — stopping.")
  render in muted text.
- **Expected outcome:** all five event shapes render without throwing on
  malformed/missing payload fields (each `DirectorFeedLine` case
  defensively type-checks its payload before rendering).
- **Edge cases:** a critique event before any candidate exists renders
  with zero frame thumbnails (frames only appear once `frameUrls` is
  non-empty).
- **Results:** PASS — live-verified in the Task 9 Stage-1 gate (run
  `8afa0b6a`: "vision critique → 3 free tool actions … → generate_
  candidate_clip REFUSED by budget executor with named numbers → invalid
  LTX duration rejected w/ durations list → best_effort finish …" — critique,
  action, cost, and error event shapes all observed live, plus the 409
  double-start and `GET` poll returning 14 correctly-presigned events).

### TC-UI-2: Verdict card copy — verbatim
- **Action:** Reach `awaiting_approval` on a run that produced a
  candidate clip; open the verdict card.
- **Acceptance criteria:** the note under the candidate video reads
  **exactly** `"Candidate — your current clip is untouched"` (the spec's
  required verbatim copy, an em dash, no trailing period).
- **Expected outcome:** string match, not just "similar" copy.
- **Edge cases:** a `best_effort` run with no candidate at all shows the
  alternate copy `"No candidate clip was produced — the director
  finished with settings changes only."` instead — this is the correct,
  distinct message for that state, not a bug.
- **Results:** (manual — pending controller/user execution; source
  confirmed verbatim by code inspection —
  `director-verdict-card.tsx:266-268`).

### TC-UI-3: No-candidate approve guard (UI level)
- **Action:** Reach `awaiting_approval` on a `best_effort` run with no
  candidate clip; observe the Approve button.
- **Acceptance criteria:** Approve is disabled (`disabled={busy ||
  !run.candidateUrl}`) whenever `run.candidateUrl` is falsy — the UI
  guard in front of the server-side backstop in TC-API-4.
- **Expected outcome:** the button is visibly disabled/unclickable;
  Reject & retry and Dismiss remain available (only Approve is gated on
  candidate presence).
- **Edge cases:** none beyond the boundary itself.
- **Results:** (manual — pending controller/user execution; source
  confirmed by code inspection — `director-verdict-card.tsx:305`).

### TC-UI-4: Proposal checkboxes default unchecked
- **Action:** Reach `awaiting_approval` on a run whose feed shows at
  least one `propose_entity_update` tool call (`run.proposals.length >
  0`); observe the proposal rows before touching anything.
- **Acceptance criteria:** every proposal checkbox renders unchecked by
  default (`checkedProposals` initializes as an empty `Set`); approving
  without checking any box approves the clip candidate but applies zero
  proposals.
- **Expected outcome:** `checkedProposals.has(index)` is `false` for
  every index on first render; the reset effect also re-clears to empty
  whenever `run.id` changes (a fresh retry run never inherits a prior
  run's checked state).
- **Edge cases:** checking a box, then the run changing underneath (a
  retry produced a new `awaiting_approval` run) — the effect keyed on
  `run.id`/`run.budgetUsd` resets to unchecked, not carrying the stale
  selection forward.
- **Results:** (manual — pending controller/user execution; source
  confirmed by code inspection — `director-verdict-card.tsx:190,
  201-209`).

### TC-UI-5: Stop
- **Action:** Start a run with a small budget; click **Stop** while it's
  `running`.
- **Acceptance criteria:** `stopDirector` posts to `.../director/stop`,
  which flags `stopRequested` on the active run; the loop honors it at
  the next iteration boundary (before the next `assess-N` or `act-N`);
  the run transitions to `stopped`, and — if a candidate already existed
  from a prior iteration — it remains approvable via the verdict card.
- **Expected outcome:** the feed stops accumulating new events shortly
  after Stop is clicked (not instantly — cooperative, not synchronous);
  `directorHistoryLabel`/the verdict card render once the poll picks up
  `status: "stopped"`.
- **Edge cases:** clicking Stop when no run is active is unreachable
  through the UI (the button only renders while `run?.status ===
  "running"`); the server-side 400 (`"No active director run for this
  shot"`) is the backstop for a stale client state.
- **Results:** (manual — pending controller/user execution).

### TC-UI-6: Storyboard badges
- **Action:** Start a run on one shot; observe that shot's storyboard
  tile while `running`, then again once `awaiting_approval`.
- **Acceptance criteria:** a pulsing 🎬 badge (title "AI Director
  running") renders while `directorState[shot.id]?.run?.status ===
  "running"`; a static 🎬 badge (title "Director verdict waiting") renders
  while `"awaiting_approval"`; no badge in any other state.
- **Expected outcome:** exactly one of the two badge states (or neither)
  at a time, matching the polled run status.
- **Edge cases:** a shot the user hasn't selected this session shows no
  badge even if a run is active on it — `directorState` is populated
  lazily per selected shot, not eagerly for the whole project (documented
  in feature.md Tradeoffs, not a bug).
- **Results:** (manual — pending controller/user execution; source
  confirmed by code inspection — `storyboard-view.tsx:128-141`).

---

## 4. Paid — end-to-end (throwaway project, user-gated)

### TC-PAID-1: Hero run — VO/still mismatch, director catches it and fixes it within budget
- **Action:** On a throwaway shot, seed a deliberate mismatch: the beat's
  VO/motion prompt says the subject "raises the lantern," but the shot's
  still shows the lantern already lowered/at rest. Start a director run
  with `budgetUsd: 1.50` and no extra guidance (the mismatch alone should
  be enough for the vision critique to catch it).
- **Acceptance criteria:**
  1. The director's **first** critique (`assess-1`) flags the
     subject-action-vs-VO mismatch as a failing dimension (dimension
     `pass: false` with a note referencing the lantern's position vs. the
     VO), not a later iteration — this is the "first iteration is cheap
     by design" claim from the spec: with no existing clip, the very
     first assess looks at the still + settings and should catch a
     static-frame mismatch without having spent anything on video yet.
  2. The `act-1` step stages a fix — either `create_custom_end_frame`
     (the lantern-raised end state) or `edit_start_image` (correcting the
     still itself) — visible in the feed as a 🔧 action event, before any
     `generate_candidate_clip` call.
  3. A `generate_candidate_clip` call lands an approvable candidate
     (`clipCandidatePath` set, `awaiting_approval` reached) **within**
     the $1.50 budget — `spentUsd <= budgetUsd` at every point, verified
     by the feed's 💸 running totals never exceeding $1.50.
  4. Approve promotes correctly: the shot's `clip.mp4`/`clipModel`/
     `clipDurationSeconds` update to the candidate's, the directing
     settings columns match the run's `settingsSnapshot`
     (camera/ends-on/duration/negative-prompt/refs), and — if
     `edit_start_image` was the fix used — `image.png` updates too
     (only when `scratchImageEdited` is `true`); a follow-up `GET
     /shots/:shotId` reflects all of this.
- **Expected outcome:** 202 on start, feed shows the mismatch-catching
  critique first, then a staged fix, then a successful candidate render,
  then `awaiting_approval` with a verdict mentioning the lantern
  correction; approve returns `200 {status: "approved"}`; total spend
  ≈ $1.50–2.00 (Anthropic vision/token calls across up to 5 iterations +
  one Kontext fix (~$0.04) + one clip render, per the model/duration
  chosen).
- **Edge cases:** if the director instead reaches `finish("best_effort")`
  without fully resolving the mismatch (budget exhausted before a clean
  candidate), that is an accepted "best within budget" outcome per the
  spec's Known limitations ("the budget cap is the hard guarantee; the
  quality bar is Claude's judgment") — the acceptance bar for this TC is
  that the mismatch was *caught and at least attempted*, not that every
  run guarantees a perfect fix.
- **Results:** PENDING — Task 15 Step 4 (STOP — user gate). Requires the
  controller to seed a throwaway shot with the described VO/still
  mismatch, get explicit user go-ahead on the ~$1.50–2.00 estimate, run
  it live, and record the actual feed transcript + spend + approve
  outcome here.

---

## Summary

Section 1 (TC-U-1..6, 61 director-relevant tests across 6 vitest files;
103/103 across the whole repo's 13 files) executed and PASS on
2026-07-12 via `npm run test` — pure logic + the real bundled `ffmpeg-
static` binary for frame-sampler, no network/DB/Anthropic/fal calls
elsewhere, per this repo's `vitest.config.ts` convention. Section 2
(API) is fully specified with acceptance criteria, expected outcomes,
and edge cases; TC-API-1 (409 double-start) is PASS, live-verified
during the Task 9 Stage-1 gate; TC-API-2 is partially free (400 paths)
but its 202 paths are deferred alongside paid spend; TC-API-3/4/5 are
free and reachable via `curl` against a seeded throwaway shot, left for
the controller's live pass. Section 3 (UI) is fully specified; TC-UI-1
(feed rendering) is PASS, live-verified during the Task 9 Stage-1 gate;
the rest require a live browser session and are left for the
controller's Task 15 Step 4 pass. Section 4 (paid end-to-end, the hero
run) requires real Anthropic + fal.ai spend and explicit user
go-ahead — left PENDING for Task 15 Step 4.
