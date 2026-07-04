# v4.0 Phase 4 — Reference Bible (F-16, Cast & Locations) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a project a "show bible" of recurring entities (characters, locations, objects), each with one AI-generated multi-view reference-sheet image; shots tagged with an entity condition their image generation on that entity's sheet so the same character/place looks consistent across every shot.

**Sequencing note:** built BEFORE Phase 3 (batch generate), deliberately — bulk generation should be entity-conditioned from its first run (decision 2026-07-04).

**Architecture:** The `entities` table and `shots.referencedEntityIds` column shipped in Phase 1 — no schema change. Server: entity CRUD + a reference-sheet generation endpoint (text-to-image, type-specific sheet prompt template) + a Claude auto-extract/auto-tag endpoint (same forced-tool-use pattern as `shot-recommendation.ts`). The shot-image route resolves the shot's tagged entities to ONE primary reference sheet (characters win over locations/objects; multi-entity compositing is deferred per spec §7) and `generateImage` gains an image-conditioned mode: with a reference it calls FLUX.1 Kontext's image+prompt endpoint instead of text-to-image. Client: entities join the editor store; the left-rail placeholder becomes the Cast & Locations panel; the inspector gains "In this shot" entity chips (writing `referencedEntityIds` via shot PATCH); storyboard cards display the chips.

**Tech Stack:** existing only — fal.ai `@fal-ai/client` (FLUX.1 Kontext), Anthropic SDK, Drizzle/Neon, R2, React context store, shadcn/ui. No new dependencies.

**Visual reference:** mockup `01-timeline-view.png` left rail (entity cards: thumbnail, name, "character · 18 shots", "+ Auto-extract from script") and inspector "IN THIS SHOT" chips; mockup `02-storyboard-view.png` entity chips on cards.

## Global Constraints

- Security stack on every mutation (order): `applyRateLimit` → `verifyCsrf` → `getSession` → ownership via `projects.userId` join → UUID path validation → body validation → generic errors.
- **Cross-table authorization:** entity ids written to `shots.referencedEntityIds` MUST be validated to belong to the same project; the shot-image route resolves reference sheets only through a project-scoped entity query.
- Rate limits: `generation` preset on sheet generation, extract, and shot image; `mutation` preset on entity CRUD and shot tagging.
- Validation caps: entity `name` 1–100 chars; `description` ≤ 2000 chars; `type` ∈ {character, location, object}; `referencedEntityIds` ≤ 8 ids, all UUIDs.
- R2 keys: `projects/{projectId}/entities/{entityId}/sheet.png`. Sheets are private; clients get presigned URLs (same `getDownloadUrl` pattern).
- **Single-entity conditioning only (v1):** a shot with multiple tagged entities uses the primary = first tagged entity of type `character`, else the first tagged entity with a `done` sheet. Multi-entity compositing is deferred (spec §7, backlog #17).
- Deferred (do NOT build): batch generate (Phase 3), multi-pose/turnaround sheets (backlog #16), stale-shot batch re-image UX (surface nothing; re-image is manual), entity thumbnails in the timeline shot blocks.
- No unit-test harness: verify via `npx tsc --noEmit`, `npm run lint`, authenticated browser-console calls, and browser e2e. Commit per task: `feat(v4-p4): …`.
- File header comments; functions < ~150 LOC; match existing naming/idioms.

## File Structure

```
src/
├── lib/
│   ├── image-generation.ts               # MODIFY — optional referenceImageUrl → Kontext image+prompt mode
│   ├── entity-extraction.ts              # CREATE — Claude extract entities + tag shots (2 forced-tool calls)
│   └── reference-sheet.ts                # CREATE — type-specific sheet prompt template + generation wrapper
├── app/api/projects/[id]/
│   ├── entities/route.ts                 # CREATE — GET list / POST create
│   ├── entities/[entityId]/route.ts      # CREATE — PATCH / DELETE
│   ├── entities/[entityId]/reference/route.ts  # CREATE — POST (re)generate sheet
│   ├── entities/extract/route.ts         # CREATE — POST auto-extract + auto-tag
│   ├── shots/[shotId]/route.ts           # MODIFY — PATCH accepts referencedEntityIds (validated)
│   └── shots/[shotId]/image/route.ts     # MODIFY — resolve primary entity sheet → conditioned generation
├── components/editor/
│   ├── editor-store.tsx                  # MODIFY — EditorEntity state + actions
│   ├── reference-bible-panel.tsx         # CREATE — left rail: cards, add, auto-extract, curate
│   ├── inspector.tsx                     # MODIFY — "In this shot" chips on the shot panel
│   ├── storyboard-view.tsx               # MODIFY — entity chips on cards
│   └── unified-editor.tsx                # MODIFY — mount the panel; pass initialEntities
└── app/projects/[id]/page.tsx            # MODIFY — load entities server-side (presigned sheet URLs)
```

Task order: 1 (CRUD) → 2 (sheet generation) → 3 (extract/tag) → 4 (conditioned images) are server-side and console-testable; 5 (store) → 6 (rail panel) → 7 (chips in inspector/storyboard + shell/page wiring) build the UI; 8 = e2e + security review + docs.

---

## Task 1: Entity CRUD endpoints

**Files:** Create `src/app/api/projects/[id]/entities/route.ts` (GET list, POST create), `src/app/api/projects/[id]/entities/[entityId]/route.ts` (PATCH, DELETE).

**Interfaces (consumed by the store, Task 5):**
- `GET /entities` → `{ entities: [{...row, referenceSheetUrl: string | null, shotCount: number}] }` ordered by `createdAt`. `shotCount` = number of shots whose `referencedEntityIds` contains the id (computed in JS over the project's shots — one query, project-scoped).
- `POST /entities` body `{ name, type, description? }` → 201 row (+ `referenceSheetUrl: null`). Duplicate name (case-insensitive, same project) → 400 "An entity with this name already exists".
- `PATCH /entities/:entityId` body subset of `{ name, description }` (type is immutable in v1) → 200 row + fresh `referenceSheetUrl`. Editing `description` does NOT auto-regenerate the sheet (explicit redraw only).
- `DELETE /entities/:entityId` → `{ ok: true }`; also removes the id from every shot's `referencedEntityIds` (project-scoped update loop) and deletes the sheet object from R2 (`deleteObject`, ignore missing).

All handlers follow the beats/shots route idioms exactly (session → ownership join → UUID checks → caps from Global Constraints; `mutation` rate-limit preset; GET has no CSRF/rate-limit, mirroring `GET /beats`).

Steps: create both files → `npx tsc --noEmit` + lint → console-verify (create/list/patch/duplicate-400/delete) → commit `feat(v4-p4): entity CRUD endpoints`.

---

## Task 2: Reference-sheet generation

**Files:** Create `src/lib/reference-sheet.ts`; create `src/app/api/projects/[id]/entities/[entityId]/reference/route.ts`.

**`reference-sheet.ts`** exports `sheetPrompt(entity: { name, type, description }): string` — a pure template:
- character: `Character reference sheet of ${name}: ${description}. One single coherent sheet showing the same character from multiple views — full-body front view, side profile view, three-quarter view, and a close-up portrait — identical face, hair, build and clothing in every view, arranged side by side on a plain neutral background. No scene, no text labels.`
- location: `Location reference sheet of ${name}: ${description}. One single coherent sheet showing the same place from multiple angles — wide establishing view, mid-distance view, and a characteristic detail view — consistent architecture, landscape and lighting, arranged side by side. No people, no text labels.`
- object: `Object reference sheet of ${name}: ${description}. One single coherent sheet showing the same object from multiple angles — front, three-quarter and detail close-up — identical materials and proportions, arranged side by side on a plain neutral background. No text labels.`
(Description falls back to the empty string; the project `styleString` is appended by `generateImage` as today.)

**Route** (`generation` rate-limit preset): ownership + entity-belongs-to-project; sets `referenceStatus: "generating"`; calls `generateImage({ r2Key: projects/{id}/entities/{entityId}/sheet.png, stillImagePrompt: sheetPrompt(entity), styleString: project.styleString })`; on success persists `referenceSheetPath` + `"done"` and returns the row + presigned `referenceSheetUrl`; on failure sets `"failed"` and returns a generic 502 (mirror the revoice route's failure shape).

Steps: create both files → tsc/lint → console-verify one real sheet generation (~$0.04, 20–30s) and eyeball the sheet URL → commit `feat(v4-p4): entity reference-sheet generation`.

---

## Task 3: Auto-extract + auto-tag

**Files:** Create `src/lib/entity-extraction.ts`; create `src/app/api/projects/[id]/entities/extract/route.ts`.

**`entity-extraction.ts`** (model + patterns copied from `shot-recommendation.ts`: `claude-sonnet-4-5-20250929`, `messages.stream(...).finalMessage()`, forced `tool_choice`, count-mismatch tolerance):
- `extractEntities(script: string): Promise<Array<{ name, type, description }>>` — one forced-tool call. System prompt: identify RECURRING visual entities (characters, locations, objects) that appear in ≥2 distinct moments of the script; max 12; for each return a name (≤100 chars), type, and a 1–3 sentence VISUAL description suitable for an image generator (appearance, age, dress, materials — no plot). Validate/clamp the response (drop invalid types, truncate over-caps).
- `tagShots(entities: Array<{ id, name, type }>, shotsInput: Array<{ id, imagePrompt, narration }>): Promise<Map<string, string[]>>` — second forced-tool call: given the entity list and every shot's visual prompt + narration, return per-shot entity NAME arrays (empty allowed); the lib maps names → ids case-insensitively, drops unknowns, caps 8/shot. Shots are sent in batches of 40 per call to bound tokens; batches run sequentially.

**Route** (`generation` preset): loads script beats (joined text) + existing entities + all shots with their spanned-beat narration (reuse `computeBeatOffsets` + the overlap filter server-side — same logic as `beatsSpanned`). Flow: extract → insert entities whose lowercased name isn't already present → generate NOTHING (sheets are explicit) → tag → overwrite `referencedEntityIds` for every shot the tagger returned. Response: `{ entities: [...all rows + urls], taggedShots: n, created: n, skipped: n }`.

Steps: create both → tsc/lint → console-verify on Project T (expect Liu Bang, Xiang Yu, Qin Shi Huang, palace/battlefield-type locations; spot-check a handful of taggings) → commit `feat(v4-p4): Claude auto-extract entities and auto-tag shots`.

---

## Task 4: Entity-conditioned shot images

**Files:** Modify `src/lib/image-generation.ts`, `src/app/api/projects/[id]/shots/[shotId]/route.ts` (PATCH tagging), `src/app/api/projects/[id]/shots/[shotId]/image/route.ts`.

**`image-generation.ts`:** `GenerateImageInput` gains `referenceImageUrl?: string | null`. When absent → current `fal-ai/flux-pro/kontext/text-to-image` call unchanged. When present → call `fal-ai/flux-pro/kontext` (image+prompt editing endpoint) with `{ image_url: referenceImageUrl, prompt }` where prompt = `Using the reference sheet as the exact appearance of the subject, render: ${stillImagePrompt}. Style: ${styleString}`. Same download-and-store tail. **Implementation checkpoint:** verify the exact fal endpoint id/params against the installed `@fal-ai/client` + one live call before wiring the route; if `fal-ai/flux-pro/kontext` rejects the shape, fall back to `fal-ai/flux-pro/kontext/max` — record the outcome in the task report.

**Shot PATCH:** accept optional `referencedEntityIds: string[]` — array, ≤8, all UUIDs, every id must exist in THIS project's entities (one project-scoped query; else 400 "entity does not belong to this project"). Written independently of bounds/prompts.

**Shot image route:** after loading shot+project, resolve `shot.referencedEntityIds` → project-scoped entities with `referenceStatus === "done"` → primary (first tagged character, else first with a sheet) → presigned sheet URL (1h — fal fetches immediately) → pass as `referenceImageUrl`. Log which entity conditioned the shot. No tagged/ready entity → unconditioned generation exactly as today.

Steps: edits → tsc/lint → console-verify: tag a shot with a sheeted entity, generate its image, confirm visual consistency vs the sheet; PATCH with a foreign/unknown entity id → 400 → commit `feat(v4-p4): shot images condition on the primary entity's reference sheet`.

---

## Task 5: Store — entities as first-class state

**Files:** Modify `src/components/editor/editor-store.tsx`.

Add `EditorEntity` type (`id, name, type, description, referenceStatus, referenceSheetUrl, shotCount`), `entities: EditorEntity[]` in state + reducer actions (`setEntities`, `addEntity`, `patchEntity`, `removeEntity` — removeEntity also strips the id from every shot's `referencedEntityIds` locally), provider prop `initialEntities`, and async actions following the existing optimistic/revert idiom: `createEntity(name, type, description?)`, `updateEntity(id, patch)`, `deleteEntity(id)`, `generateReference(id)` (optimistic `"generating"` status), `extractEntities()` (posts extract; on success `setEntities` + refreshes shots' `referencedEntityIds` from the response or `router`-free re-fetch of `GET /entities` + patching returned tag map — the extract response includes `shotTags: { [shotId]: string[] }` for this purpose; add that field to the Task 3 route), `tagShot(shotId, entityIds)` (delegates to `updateShot` with `referencedEntityIds` — extend `updateShot`'s patch type). Export `entitiesOfShot(shot, entities)` helper.

Steps: edits → tsc/lint (component not yet fed `initialEntities` — keep prop optional-default `[]` until Task 7) → commit `feat(v4-p4): entities in the editor store`.

---

## Task 6: Cast & Locations rail panel

**Files:** Create `src/components/editor/reference-bible-panel.tsx`.

Replaces the static `LeftRail` copy (mounted in Task 7). Per mockup 01, width `w-56`: heading "Cast & Locations"; one card per entity — sheet thumbnail (or type icon placeholder / spinner while generating / red ring on failed), name, `{type} · {shotCount} shots`; click card → expand inline: editable name + description (blur-persist via `updateEntity`), buttons `Redraw` (`generateReference`, disabled while generating), `Delete` (confirmless — entities are cheap; removes tags via store). Footer: `+ Add entity` (inline mini-form: name, type select, description) and `✨ Auto-extract from script` (runs `extractEntities`, spinner state, disabled while running; shows "n found · m shots tagged" transiently). Empty state: the current explanatory copy + the auto-extract button. All state via `useEditor()`; no direct fetches.

Steps: create → tsc/lint → commit `feat(v4-p4): Cast & Locations rail panel`.

---

## Task 7: Chips + wiring (inspector, storyboard, shell, page)

**Files:** Modify `inspector.tsx`, `storyboard-view.tsx`, `unified-editor.tsx`, `src/app/projects/[id]/page.tsx`.

- **Inspector shot panel:** an "In this shot" block above the image prompt — each project entity rendered as a toggle chip (selected = tagged); toggling calls `tagShot` with the updated array; chips show a tiny type glyph (🧍/🏔/⚱ equivalent via lucide icons User/Mountain/Box). When the tagged primary entity has no sheet, show a muted hint "no reference sheet yet — Redraw in the rail".
- **Storyboard cards:** below narration, small outline badges with the tagged entities' names (via `entitiesOfShot`).
- **Shell:** `<LeftRail />` → `<ReferenceBiblePanel />`; `UnifiedEditor` accepts `initialEntities` and passes to the provider.
- **page.tsx:** load entities server-side (project-scoped, presign `referenceSheetPath`, compute `shotCount` from the shots already loaded) → `initialEntities`.

Steps: edits → tsc fully green + lint → commit `feat(v4-p4): entity chips and rail wired into the editor`.

---

## Task 8: E2E, security review, docs

- **E2E (browser, Project T):** auto-extract → entities appear in rail with counts; generate 2–3 sheets (1 character + 1 location); tag/untag a shot via chips (persists across reload); re-image a tagged shot → visibly on-model vs the sheet; storyboard shows chips; delete an entity → tags disappear everywhere; entity with failed sheet shows failed state + Redraw retries.
- **Independent security review** (fresh agent, `security-playbook.md`) over the phase diff — focus: entity CRUD ownership, `referencedEntityIds` cross-project validation, extract endpoint prompt-injection surface (script text reaches Claude — user's own data, no privilege boundary), presigned sheet URL scoping, rate limits. Findings fixed before merge; recorded in `docs/feature08/security-review.md` (new section) or `docs/feature16/security-review.md`.
- **Docs:** `docs/feature16/feature.md` → SHIPPED (update Key Files to actual paths, data model "as built", the single-entity-v1 + text-style-conditioning reality — the doc's old claim that style refs already use multi-image input is corrected); `docs/feature16/testcase.md` (new, per feature-playbook); roadmap table Phase 4 ✅ (note: built before Phase 3, and Phase 3's batch fan-out must route through the entity-conditioned image path); PRD header note; backlog — mark F-16 shipped, keep #17 (multi-entity) + #16 (multi-pose) deferred, add "re-image existing shots after tagging" note.
- Pre-commit checklist walk → commit `feat(v4-p4): Phase 4 ships — docs, test cases, security review`.

## Self-Review (against spec Pillar C / feature16)

- Auto-extract ✅ T3; auto-generate sheets — explicit per-entity (spec's "auto-generate each" softened to user-triggered to control cost; the rail makes it one click per entity) — deliberate deviation, noted for the gate.
- Auto-tag ✅ T3; curate (rename/redraw/delete/fix tags) ✅ T6+T7; condition at generation ✅ T4 (single-entity v1 per spec §7).
- Characters → locations → objects build-order collapses into one implementation since the table/UI handle all three from day one (per feature16).
- Open question from feature16 (Kontext per-call reference cap): resolved by v1 design — exactly one reference image is passed; style stays textual, so no slot contention.
