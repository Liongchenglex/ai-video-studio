# AI Assistant Director

**Date:** 2026-07-11
**Status:** Approved design, pending implementation plan
**Scope decision:** one feature (docs/feature20), one plan with three shippable stages: (1) foundations — loop + free tools + candidate generation, (2) full powers — Kontext/entity tools, (3) approval polish. Per-shot feature.

## Problem

Improving a shot today is manual: the user watches the clip, diagnoses (wrong staging, off-model cast, weak camera, bad ending), adjusts the directing controls, regenerates, and repeats. The AI Assistant Director automates that loop: an agent that can *see* the still and the clip, holds whole-project context, wields every directing control plus entity creation, and iterates autonomously within a user-set budget until it has a candidate clip the user approves.

## Decisions (settled interactively)

1. **Autonomy:** autonomous within a per-run budget; streams its notes live; stoppable anytime; ends with one candidate for approve/reject; a rejection note feeds the next round.
2. **Candidate slot:** the director never touches the shot's real clip or settings mid-run. It works on a scratch settings copy (in the run record) and writes attempts to a candidate R2 key. Approval promotes; rejection discards.
3. **Entities:** CREATE new entities (+sheets) and tag/untag this shot autonomously (additive); UPDATES to existing shared entities are proposals applied only if the user approves them.
4. **Runtime:** Inngest function + polled activity feed (house patterns).
5. **Extensibility (hard requirement):** all abilities live in one declarative tool registry; a future directing control hooks up by adding one entry.

## Data model

`director_runs`: `id uuid pk`, `shotId` (fk cascade), `projectId` (fk cascade), `status` (`running | awaiting_approval | approved | rejected | stopped | failed`), `budgetUsd double`, `spentUsd double default 0`, `guidance text` (user note; rejection notes append), `verdict text`, `clipCandidatePath text`, `candidateDurationSeconds integer`, `candidateModel text`, `settingsSnapshot jsonb` (scratch directing settings the candidate was made with), `proposals jsonb` (shared-entity edit proposals `[{entityId, field, from, to, rationale}]`), `createdAt/updatedAt`.

`director_events`: `id`, `runId` (fk cascade), `seq integer`, `type` (`note | critique | action | cost | error`), `payload jsonb`, `createdAt`. Append-only; the feed the inspector polls. Candidate sample frames (first/last) are stored under the run's R2 prefix and referenced from `critique` payloads so the user sees what the AI saw.

One active run per shot (409 guard, batch idiom). Candidate key: `projects/{p}/shots/{s}/director/{runId}/candidate.mp4`; frames `…/frame-{i}.png`.

### Lifecycle

start(budget, guidance?) → `running` → loop appends events, accumulates `spentUsd` → `awaiting_approval` (verdict + candidate) | `stopped` (user; candidate-so-far still approvable if present) | `failed` (unrecoverable only; spend recorded).
**Approve** → promote candidate to shot `clip.mp4` (+`clipDurationSeconds`, `clipModel`), write `settingsSnapshot` onto the shot (controls match what produced the clip), promote the scratch still to the shot's `image.png` when the director edited it (`settingsSnapshot.scratchImagePath` set; standard re-image staleness semantics apply), reset SFX (standard regen semantics), apply CHECKED proposals → `approved`.
**Reject & retry** → note appends to guidance; new round with a fresh budget.
**Dismiss** → `rejected`; nothing applied; feed collapses to a history row showing spend.

## The tool registry (`src/lib/director/director-tools.ts`)

```ts
interface DirectorTool {
  name: string;                          // "set_camera_move"
  description: string;                   // what Claude reads — when/why to use it
  inputSchema: Record<string, unknown>;  // JSON Schema; enums DERIVED from app sources
  estCostUsd: (input: unknown) => number;// 0 for setting changes; real for paid calls
  sharedStateEdit?: boolean;             // true → recorded as a proposal, never executed mid-run
  execute(ctx: DirectorRunCtx, input: unknown): Promise<DirectorToolResult>;
}
export const DIRECTOR_TOOLS: DirectorTool[];
```

Launch set: `set_camera_move` (enum from `CAMERA_MOVES`), `set_ends_on`, `create_custom_end_frame` (~$0.04 Kontext, scratch), `edit_start_image` (~$0.04 Kontext, scratch copy of the still — the shot's real image is untouched; the candidate generates from the scratch still, and approval promotes it to the shot's `image.png` alongside the clip), `set_negative_prompt`, `set_clip_duration` (validated against the scratch model's `durations`), `set_clip_model` (enum + whenToUse text from `CLIP_MODELS`), `set_use_entity_refs`, `create_entity`, `generate_entity_sheet` (~$0.04), `tag_entity`/`untag_entity` (this shot only), `propose_entity_update` (`sharedStateEdit: true`), `generate_candidate_clip` (scratch settings through the existing `generateShotClip` pathway, redirected to the candidate key; est = `estClipUsd(scratch model, resolved duration)`), `record_critique` (structured assessment; free), `finish` (verdict; free).

**Derivation rule (the extensibility guarantee):** the Claude `tools` array, the system prompt's capability inventory, feed `action` events, and the budget meter are generated from `DIRECTOR_TOOLS` at runtime. Adding a future control = adding one entry. A unit test asserts every entry has a non-trivial description, a schema, and a cost function.

**Budget enforcement is in the executor:** before `execute`, refuse when `spentUsd + estCostUsd(input) > budgetUsd`, returning a structured over-budget tool result the model sees (it should then `finish` best-effort). Setting changes are free. Anthropic vision/tokens are metered into `spentUsd` per call (estimated from usage at ~public pricing) so the budget is all-inclusive.

**Tool input validation:** the same guards as the human PATCH routes (`isCameraMove`, `isCameraStrength`, ends-on enum, registry model ids, duration bounds, 500-char text caps). The model has no capability a user PATCH doesn't have, except writing its own run's candidate assets.

## Context & vision (`src/lib/director/director-context.ts`, `director-critic.ts`)

Briefing text: project brief + style string; full script; this beat's text + VO line; this shot's prompts and scratch settings; prev/next shots' prompts and `endsOn` (timeline order via `orderShotsByTimeline`); entity roster with sheet status; budget state; guidance incl. rejection notes.

Briefing images (base64 blocks to Claude): scratch still; custom end frame if any; prev/next stills; after each candidate generation, **4 frames sampled at 0/33/66/100%** via `ffmpeg-static` (new dependency) extracted in the Inngest step; the 0%/100% frames are persisted to the run's R2 prefix and shown in the feed.

## The loop (`direct-shot` Inngest function)

Steps (each Claude call in its own step for replay memoization):
1. `briefing` — assemble context.
2. Per iteration N (cap 5): `assess-N` — vision critique against the beat's intent (subject action vs VO, continuity with neighbors, cast on-model, camera/pacing, artifacts), forced `record_critique` with per-dimension pass/fail. All pass → `finish`.
3. `act-N` — tool-use conversation; free settings changes and budget-checked paid calls execute and land in the feed.
4. `generate-N` — when `generate_candidate_clip` was called, regenerate the candidate; next iteration re-watches it. If an iteration changes nothing actionable, exit (stuck-guard) instead of re-assessing the same state.
5. Terminal → `awaiting_approval` (or budget-exhausted with a "best within budget" verdict; a stop flag is checked between steps → `stopped`).

First iteration is cheap by design: with no existing clip it critiques the still + settings and fixes staging before paying for video; with an existing clip it starts by watching that (already on R2, free).

Claude model: Sonnet (vision) via the existing `@anthropic-ai/sdk`. Inngest nondeterminism on mid-step retries is accepted and documented (same class as chain suggestions).

## Routes

- `POST /api/projects/[id]/shots/[shotId]/director` `{ budgetUsd, guidance? }` → creates run, sends Inngest event. 409 if a run is active. Budget allow-list 0.25–5.00.
- `GET …/director` → active/latest run + events after `?since=seq` (poll).
- `POST …/director/stop` → sets stop flag.
- `POST …/director/resolve` `{ action: "approve" | "reject" | "dismiss", note?, approvedProposalIds? }` → approval semantics per Lifecycle.
All with the full house security stack; notes/guidance ≤500 chars, forwarded only into prompts, never into keys/logs.

## UI (inspector fifth group: `AI Director`)

- **At rest:** budget picker ($0.75 / $1.50 / $3.00, default $1.50), optional guidance line (placeholder `e.g. "the dog should react to the lantern"`), `Direct this shot` button showing the budget. Disabled without a done image or while a run is active.
- **Running:** live activity feed (polls run + events): 🎬 critiques with pass/fail dimensions, 🔧 actions, 💸 spend ticks with running total, candidate first/last frames per attempt. **Stop** button.
- **Verdict card** (`awaiting_approval`): candidate playing inline (labeled *Candidate — your current clip is untouched*), verdict text, settings diff (`Camera: none → push-in · …`), proposal checkboxes (default unchecked), buttons **Approve** / **Reject & retry** (note field) / **Dismiss**. Dismissed/approved runs collapse to a history row with spend.
- **Timeline/storyboard:** pulse badge while running; static badge on `awaiting_approval`.

## Error handling

Tool failures → feed `error` event + structured tool result (model adapts or finishes). fal failure inside candidate generation touches only the candidate. Budget can never be exceeded (executor-enforced). Unrecoverable errors (e.g. Anthropic outage) → `failed` with spend recorded. Stop is honored between steps.

## Testing

- **Vitest (pure):** registry invariants (description/schema/cost per tool; enums match `CAMERA_MOVES`/`CLIP_MODELS`); budget-gate math incl. refusal; context text assembly; critique/verdict parsing; proposal routing (`sharedStateEdit` never executes); promote-on-approve settings mapping.
- **Paid smoke (user-gated):** one real run on a throwaway shot with a deliberate VO/still mismatch — assert the director notices in `assess-1`, stages a fix, and lands an approvable candidate within budget.
- **Live UI pass:** feed rendering, stop, verdict card, approve-promotes, reject-retry.

## Known limitations (documented, accepted)

- The budget cap is the hard guarantee; the quality bar is Claude's judgment.
- Frame sampling (4 frames) can miss brief mid-clip artifacts between samples.
- Inngest mid-step retries may re-roll an AI decision (accepted).
- One run per shot at a time; runs are per-shot (no cross-shot batch directing in v1).
- Vision/token costs (~$0.02–0.05/iteration) are metered into `spentUsd`.

## Rejected alternatives

- **Agent drives HTTP routes** — auth/CSRF friction inside Inngest for zero benefit over direct service calls with identical validation.
- **Client-side loop (SSE)** — dies with the tab; contradicts the Inngest decision.
- **Checkpoint-every-iteration / fully-autonomous-unbounded** — rejected for click fatigue / cost control respectively.
- **Work-in-place candidates or full version history** — candidate-slot chosen (protects spent money without variant-system scope).
- **Full autonomous entity edits** — shared-state blast radius; proposals instead.
