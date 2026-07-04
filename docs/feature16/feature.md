# Feature: F-16 Reference Bible (Character & Setting Consistency)

> **Status: SHIPPED 2026-07-04.**
> Branch `feat/v4-phase4-reference-bible`. Plan:
> [`docs/superpowers/plans/2026-07-04-v4-phase4-reference-bible.md`](../superpowers/plans/2026-07-04-v4-phase4-reference-bible.md).
> Authoritative design: [`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md) (Pillar C).
> **Supersedes** backlog item **F-07a** (Entity reference images).
> **Sequencing note:** shipped BEFORE v4.0 Phase 3 (batch "Generate all"),
> deliberately — bulk generation will call the same shot-image route this
> feature conditions, so batch generation is entity-conditioned from its
> first run rather than needing a later retrofit.

## Feature
- **Name:** Reference Bible
- **Purpose:** Give a project a "show bible" of recurring **entities**
  (characters, locations, objects), each rendered as one coherent
  multi-view reference-sheet image. Shots tagged with an entity condition
  their image generation (FLUX.1 Kontext) on that entity's sheet, so the
  same character/place looks consistent across every shot. This is the
  primary fix for the biggest quality gap — visual drift across shots.

## Why this is its own feature (not part of F-08)
The editor (F-08) owns the timeline and shots. The Reference Bible owns a
separate concern: the canonical visual identity of recurring entities and
the conditioning that enforces it. It has its own table, its own CRUD +
generation endpoints, and its own UI rail. The only coupling points are
`shots.referencedEntityIds` and the shot-image generation call.

## Directing-first flow (as built)
1. **Auto-extract** — Claude reads the full script (joined beat text) and
   proposes recurring entities (`src/lib/entity-extraction.ts:extractEntities`).
2. **Generate (user-triggered)** — each entity gets one multi-view
   reference-sheet image (FLUX, in project style, seeded from an editable
   description) when the user clicks "Redraw" / generate in the rail. This
   is **not** automatic after extract — see Deviations below.
3. **Auto-tag** — the same extract call also runs `tagShots`, inferring
   which shots each entity appears in from image prompt + spanned
   narration.
4. **Curate** — user renames, redraws, deletes entities, or toggles
   per-shot tag chips.
5. **Condition** — a tagged shot's image generation resolves one primary
   entity and passes its reference sheet to FLUX.1 Kontext.

Build order by payoff (characters → locations → objects) collapsed into one
implementation since the table/UI hold all three types from day one — no
later migration was needed.

## Key Files (as built)

Frontend:
- `src/components/editor/reference-bible-panel.tsx` — the "Cast &
  Locations" left rail: entity cards (thumbnail/spinner/failed state, name,
  `{type} · {shotCount} shots`), inline edit (name + description,
  blur-persist), `Redraw`, `Delete`, `+ Add entity` inline form,
  `✨ Auto-extract from script` button with transient result summary.
- `src/components/editor/inspector.tsx` — "In this shot" entity toggle
  chips on the shot panel (writes `referencedEntityIds` via shot PATCH);
  shows a muted hint when the primary tagged entity has no sheet yet.
- `src/components/editor/storyboard-view.tsx` — small outline badges below
  narration showing each card's tagged entity names.
- `src/components/editor/unified-editor.tsx` — mounts
  `<ReferenceBiblePanel />` in place of the old static left-rail copy;
  passes `initialEntities` into the store provider.
- `src/components/editor/editor-store.tsx` — owns `entities` state
  (`EditorEntity[]`) and the entity actions (below); `entitiesOfShot()`
  helper used by inspector + storyboard.
- `src/app/projects/[id]/page.tsx` — loads entities server-side
  (project-scoped, presigns `referenceSheetPath`, computes `shotCount` from
  the shots already loaded) into `initialEntities`.

Backend:
- `src/app/api/projects/[id]/entities/route.ts` — `GET` list (+ presigned
  `referenceSheetUrl` + computed `shotCount`), `POST` create.
- `src/app/api/projects/[id]/entities/[entityId]/route.ts` — `PATCH`
  (name/description; `type` is immutable in v1), `DELETE` (strips the id
  from every project shot's `referencedEntityIds`, deletes the R2 sheet
  object if present, then deletes the row).
- `src/app/api/projects/[id]/entities/[entityId]/reference/route.ts` —
  `POST` (re)generates the multi-view reference sheet via FLUX text-to-image.
- `src/app/api/projects/[id]/entities/extract/route.ts` — `POST` Claude
  auto-extract entities + auto-tag shots from the project's beat text.
- `src/lib/reference-sheet.ts` — pure `sheetPrompt(entity)`: type-specific
  multi-view prompt template (character / location / object).
- `src/lib/entity-extraction.ts` — `extractEntities(script, existingNames)`
  and `tagShots(entities, shots)`; forced tool-use Claude calls, same
  pattern as `shot-recommendation.ts`.
- `src/lib/image-generation.ts` — `generateImage()` gains optional
  `referenceImageUrl`; when present, calls `fal-ai/flux-pro/kontext`
  (image+prompt mode) instead of `fal-ai/flux-pro/kontext/text-to-image`.
- `src/app/api/projects/[id]/shots/[shotId]/image/route.ts` — resolves the
  shot's tagged entities to one primary entity and conditions generation on
  its presigned sheet URL.
- `src/app/api/projects/[id]/shots/[shotId]/route.ts` — `PATCH` accepts
  optional `referencedEntityIds` (validated independently of bounds/prompts).
- `src/lib/db/schema.ts` — `entities` table + `entityTypeEnum` +
  `shots.referencedEntityIds` (all shipped in Phase 1; no schema change in
  this phase).

## Data Models (as built)

**Table `entities`** (`src/lib/db/schema.ts`):

| Column | Type | Notes |
|---|---|---|
| id | uuid, PK, default random | |
| projectId | uuid, FK → `projects.id` `onDelete: cascade` | owner project |
| name | text NOT NULL | e.g. "Liu Bang", "Imperial Palace"; unique per project, case-insensitive (app-enforced, not a DB constraint) |
| type | `entityTypeEnum`: `character` \| `location` \| `object`, NOT NULL | immutable after create (v1) |
| description | text, nullable | user-editable; seeds the reference-sheet prompt |
| referenceSheetPath | text, nullable | R2 key of the multi-view sheet image |
| referenceStatus | `generationStatusEnum` (shared enum): `pending` / `generating` / `done` / `failed`, default `pending` | |
| createdAt / updatedAt | timestamp | `updatedAt` auto-bumped on update |

Index: `entities_project_id_idx` on `projectId`.

**Column on `shots`** (added in Phase 1, used here):

| Column | Type | Notes |
|---|---|---|
| referencedEntityIds | `jsonb<string[]>`, default `[]` | entity ids tagged on this shot; ≤8, validated to belong to the same project on every write |

Lifecycle: entities are owned by the project and cascade-deleted with it.
Deleting an entity directly (not via project delete) strips its id from
every shot's `referencedEntityIds` and deletes its R2 sheet object first.
Editing `description` does **not** auto-regenerate the sheet — the user
must explicitly click Redraw (cost control, see Deviations).

## APIs (as built)

All auth-required (`getSession()` → 401) and ownership-scoped
(`projects.userId` join, 404 on any project/entity/shot the caller doesn't
own — no distinct 403, matching the rest of the app's IDOR-hiding
convention).

- `GET /api/projects/:id/entities` — list entities + `referenceSheetUrl` +
  `shotCount`. No CSRF/rate-limit (read-only, mirrors `GET /beats`).
- `POST /api/projects/:id/entities` — create `{ name, type, description? }`.
  `mutation` rate-limit preset. 400s: missing/empty name, name >100 chars,
  invalid `type`, description >2000 chars, duplicate name (case-insensitive,
  same project), malformed/non-object JSON body.
- `PATCH /api/projects/:id/entities/:entityId` — update a subset of
  `{ name, description }`. `mutation` preset. 400s: same field caps as
  create, duplicate name (excluding self), empty body (no valid fields).
- `DELETE /api/projects/:id/entities/:entityId` — removes the row, strips
  the id from all project shots' tags, deletes the R2 sheet object
  (ignored if already missing). `mutation` preset.
- `POST /api/projects/:id/entities/:entityId/reference` — (re)generates the
  multi-view sheet. Sets `referenceStatus: "generating"` → `"done"` (+
  `referenceSheetPath`) or `"failed"` on error (502, generic message).
  `generation` preset.
- `POST /api/projects/:id/entities/extract` — Claude auto-extract +
  auto-tag. Loads all beats (joined for script text) + existing entities +
  all shots (image prompt + computed spanned narration); caps: script
  ≤60,000 chars, shots ≤400 (else 400 before any Claude call). Response:
  `{ entities, taggedShots, created, skipped, shotTags }` where `shotTags`
  is `{ [shotId]: string[] }` so the client store can apply tags without a
  refetch. `generation` preset.
- `PATCH /api/projects/:id/shots/:shotId` — (existing route, extended)
  accepts optional `referencedEntityIds: string[]`, validated independently
  of bounds/prompt fields: array, ≤8 entries, every entry a UUID, every id
  must resolve to an entity in this project (else 400 "entity does not
  belong to this project").
- `POST /api/projects/:id/shots/:shotId/image` — (existing route, extended)
  resolves the shot's primary conditioning entity and passes its sheet as
  `referenceImageUrl` to `generateImage()`.

## State & Ownership
- **Source of truth:** Neon `entities` table + R2 reference-sheet assets;
  `shots.referencedEntityIds` for the shot↔entity links.
- **Cached on client:** `entities: EditorEntity[]` (id, name, type,
  description, referenceStatus, referenceSheetUrl, shotCount) held in the
  same shared editor store (`editor-store.tsx`) that Timeline, Storyboard,
  and the inspector all read — one source of truth, no per-view state.

## Security
(Independently reviewed 2026-07-04 against `security-playbook.md`; see
`docs/feature16/security-review.md`. Verdict: SHIP WITH FIXES, both fixes
applied pre-merge in `ccf0363`.)

- **Auth required:** every endpoint (`getSession()` → 401 on missing session).
- **Ownership enforced on:** every entity read/write via a `projects.userId`
  join; the shot-image route resolves reference sheets only through a
  project-scoped entity query (`entities.projectId = this project`); the
  extract route writes tags only to project-scoped shots.
- **Cross-table authorization:** `shots.referencedEntityIds` is validated
  against this project's `entities` on every PATCH (400 if any id is
  foreign); Claude-returned shot ids in `tagShots` are checked against the
  batch's known id set before being trusted.
- **Rate limiting:** `generation` preset (5/min) on sheet generation,
  extract, and shot-image; `mutation` preset (30/min) on entity CRUD and
  shot tagging (shared with existing shot PATCH).
- **CSRF:** Origin-header verification (`verifyCsrf()`) on every mutation,
  fail-closed.
- **Input validation:** UUIDs on all path params; `name` 1–100 chars;
  `description` ≤2000 chars; `type` ∈ enum, immutable after create;
  `referencedEntityIds` ≤8 UUIDs, all validated to existing project
  entities; malformed/non-object JSON bodies → 400 (not 500) on entities
  POST, entities PATCH, and shots PATCH (hardening fix, see below).
- **Fan-out caps:** the extract endpoint's Claude call volume is bounded by
  script ≤60,000 chars and shots ≤400 — added as a hardening fix (below)
  after the initial implementation had no bound.
- **Secrets:** `FAL_KEY`, `ANTHROPIC_API_KEY` read server-side only.
- **R2 access:** reference sheets are private; clients receive presigned
  GET URLs only through owner-scoped routes (`getDownloadUrl`, 1h expiry —
  same pattern as shot images/clips).
- **Security-review findings, both fixed in `ccf0363` before merge:**
  - Non-object JSON bodies (literal `null`/array/scalar) previously passed
    the parse try/catch and threw on property access → unhandled 500
    instead of 400, in entities POST, entities PATCH, and shots PATCH.
    Fixed with an explicit body-shape guard.
  - The extract endpoint fanned out to `1 + ceil(shots/40)` paid Claude
    calls with no input bound. Fixed with the script/shot caps above.
    Per-user (vs per-IP) rate budgeting remains a pre-existing platform
    limitation, tracked in `docs/backlog.md`.

## Dependencies
- **External services:** fal.ai (FLUX.1 Kontext — sheet generation via
  `fal-ai/flux-pro/kontext/text-to-image`, and shot conditioning via
  `fal-ai/flux-pro/kontext` image+prompt mode — verified live 2026-07-04,
  no fallback endpoint needed), Anthropic Claude (`claude-sonnet-4-5-20250929`,
  auto-extract + auto-tag), Cloudflare R2.
- **Shared utilities:** `src/lib/r2.ts` (`getDownloadUrl`, `deleteObject`),
  `src/lib/image-generation.ts`, `src/lib/api-utils.ts` (session, CSRF,
  rate-limit, UUID validation), `src/lib/beat-timing.ts` +
  `src/lib/shot-beat-mapping.ts` (narration-span computation for tagging).
- **Feature coupling:** F-02 style profile (sheets generated in project
  style — textual conditioning only, see correction below), F-08 editor
  (tagging UI + the shared store), F-04 image generation.

## Correction to the pre-implementation doc
The PLANNED doc (and backlog item 7a before it) assumed style conditioning
already used FLUX's multi-image input, so entity references would "stack
onto the same multi-image input already used for style refs." **This was
wrong.** Style conditioning has always been **textual only** — a
`styleString` suffix appended to the prompt (`generateImage()` in
`src/lib/image-generation.ts`). The reference sheet is the *only* image
actually passed to FLUX.1 Kontext (via `image_url` in image+prompt mode).
This turned out to simplify v1: there is no per-call reference-image slot
contention to worry about (the open question flagged in the original doc),
because exactly one image is ever sent.

## Coding Patterns Used
- **One coherent multi-view sheet per entity** — all views/poses generated
  in a single FLUX frame so they are mutually consistent, used whole as the
  conditioning reference. Cheaper (one generation per entity, not per pose)
  and stronger anchoring than per-pose generation would be.
- **Forced tool-use extraction**, same pattern as `shot-recommendation.ts`
  — `messages.stream().finalMessage()`, `tool_choice` forced to a single
  named tool, `stop_reason === "max_tokens"` guarded, server-side
  validation/clamping of every field (never trust raw Claude output).
- **Deterministic alias-containment filter** — a second-layer,
  non-LLM backstop (`filterAliasOverlap` in `entity-extraction.ts`) that
  drops any newly-extracted candidate whose name mechanically contains, or
  is contained by, an already-registered entity's name. Added after a live
  run showed the prompt's own negative examples ("don't re-propose X")
  could prime Claude into proposing a name-containing variant of X.
- **Auto-with-curation** — Claude proposes (extract + tag); user disposes
  (rename/redraw/delete/re-tag). Matches the editor's "directing, not
  assembling" theme.
- **Single primary-entity resolution** — `resolvePrimaryEntity()` in the
  shot-image route: first tagged entity of type `character` with a `done`
  sheet, else the first tagged entity (in tag order) with a `done` sheet.
  Simple, deterministic, and sidesteps multi-reference compositing entirely
  for v1.

## Tradeoffs (honest)

- **Single-entity conditioning only (v1).** A shot tagged with both a
  character and a location conditions on the character's sheet only (the
  primary-entity rule); the location's look isn't enforced for that shot.
  Multi-entity compositing is deferred — backlog **#17** (formerly listed
  as #15 in the pre-implementation doc; renumbered when it moved to
  `docs/backlog.md` items 15–17).
- **Single multi-view sheet, not true per-pose turnarounds.** One coherent
  sheet image per entity; richer selectable per-pose anchoring (front/side/
  back/expression) is deferred — backlog **#16**.
- **Sheet generation is user-triggered, not automatic after extract.**
  Deviation from the original spec's "auto-generate each" — approved at the
  implementation gate 2026-07-04 for cost control (sheet generation costs
  ~$0.04 and 20–30s per entity; auto-firing 12 of them per extract run
  would be an unexpected charge). The rail makes it one click per entity
  instead.
- **Description edits don't auto-redraw the sheet.** Editing an entity's
  description invalidates the *prompt* used to generate its existing sheet,
  but the sheet itself isn't regenerated or marked stale — same cost-control
  reasoning. The user must notice and click Redraw.
- **No server-side concurrency guard on double Redraw.** Two rapid clicks
  on the same entity's Redraw button could both proceed server-side (no
  lock on `referenceStatus` transition). Mitigated client-side only: the
  rail panel disables the Redraw button while `referenceStatus ===
  "generating"`. A determined user hitting the raw API twice back-to-back
  could still trigger two concurrent generations (wasted cost, not a
  correctness bug — the row just ends up with whichever finishes last).
- **Alias-containment filter can over-suppress.** `filterAliasOverlap`
  drops any candidate whose name contains-or-is-contained-by an existing
  entity's name, case-insensitively. This is deliberately blunt: it will
  also drop a *genuinely distinct* entity that happens to share a substring
  with an existing name (e.g. an existing "Han Dynasty" location blocking a
  new, unrelated "Han River" location candidate). The escape hatch is the
  manual `+ Add entity` form, which bypasses extraction entirely.
- **Re-running extract can propose marginal entities on later runs.** The
  prompt asks Claude to be conservative ("fewer is better," empty array is
  a valid answer), but on a script with many minor recurring props, repeat
  runs may still surface entities that are only weakly worth a reference
  sheet. This is treated as by-design curation, not a bug — the user
  deletes what they don't want; nothing auto-generates a sheet for a
  proposed entity, so a marginal proposal costs nothing until the user
  chooses to draw it.
- **No per-project entity count cap.** Rows are cheap and sheet generation
  is separately gated behind an explicit, rate-limited action, so an
  unbounded entity list per project was accepted as a non-issue for v1
  (flagged as an INFO item in the security review, tracked in backlog).
- **`shotCount` is computed, not stored.** Every `GET /entities` and the
  extract response recompute shot-tag counts by scanning the project's
  shots in JS. Fine at current scale (tens to low hundreds of shots per
  project); would need an index/materialized count if projects grow much
  larger.

## Deviations from spec approved at the implementation gate
- Sheet generation: user-triggered per entity, not auto-fired after extract
  (cost control — see Tradeoffs).
- Description edits: no auto-redraw (cost control — see Tradeoffs).

## Deferred items
- **Multi-entity conditioning** — backlog #17.
- **Multi-pose / turnaround sheets** — backlog #16.
- **Timeline entity thumbnails** — shot blocks on the Timeline view don't
  show entity thumbnails (only the Storyboard cards show name badges);
  explicitly out of scope for this phase per the plan's Global Constraints.
- **Batch re-image after re-tagging** — no "stale shot" surfacing or batch
  re-image action when tags change after a shot already has an image;
  re-imaging is manual (click Generate again).

## Relationship to other features / backlog
- **Supersedes:** backlog **F-07a** (entity reference images) — folded here.
- **Feeds:** v4.0 Phase 3 (batch "Generate all") — batch generation must
  route through the same `POST /shots/:shotId/image` endpoint this feature
  conditions, so batch-generated images are entity-conditioned automatically
  with no extra work in Phase 3.
- **Strengthens:** backlog **#8** (multi-keyframe clips) — keyframes can
  condition on entity sheets once both exist.
- **Lives inside:** the F-08 v4.0 unified editor (left rail) over the
  shared Timeline/Storyboard store.
