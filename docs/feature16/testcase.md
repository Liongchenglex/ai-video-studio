# F-16 Reference Bible — Test Cases

**Date:** 2026-07-04

All cases below were verified live on 2026-07-04 via a combination of
browser e2e (signed-in session against the running dev server, Project T)
and curl / devtools `fetch()` calls against the same project. No unit-test
harness exists in this repo (house convention — see the v4.0 roadmap);
verification is curl/browser e2e per task, matching how Phases 1–2 were
verified. See the "Verified" line per case.

---

## 1. Entity CRUD

### TC-1.1: Create an entity
- **Action:** `POST /api/projects/:id/entities` with
  `{ name: "Liu Bang", type: "character", description: "..." }`.
- **Expected:** 201, row returned with `referenceSheetUrl: null`,
  `referenceStatus: "pending"`.
- **Verified:** live (curl + browser e2e via the rail's "+ Add entity" form).

### TC-1.2: Duplicate name rejected (case-insensitive, per project)
- **Action:** `POST /entities` with a `name` that already exists in the
  project, differing only in case (e.g. `"liu bang"` vs `"Liu Bang"`).
- **Expected:** 400 "An entity with this name already exists". No row
  created.
- **Verified:** live (curl).

### TC-1.3: Invalid type rejected
- **Action:** `POST /entities` with `type: "setting"` (not in the
  `character|location|object` enum).
- **Expected:** 400 "type must be one of character, location, object".
- **Verified:** live (curl).

### TC-1.4: Empty PATCH rejected
- **Action:** `PATCH /entities/:entityId` with `{}` (no `name` or
  `description`).
- **Expected:** 400 "No valid fields to update". Row unchanged.
- **Verified:** live (curl).

### TC-1.5: Malformed / non-object JSON body rejected (security fix F1)
- **Action:** `POST /entities` and `PATCH /entities/:entityId` with a body
  of literal `null`, a JSON array `[]`, or a bare scalar `"x"`.
- **Expected:** 400 "Invalid request body" in every case — not a 500. This
  was security finding F1, fixed in commit `ccf0363` before merge.
- **Verified:** live (curl, all three malformed shapes against both routes).

### TC-1.6: DELETE strips tags and deletes the sheet object
- **Action:** Tag an entity onto ≥2 shots, generate its reference sheet,
  then `DELETE /entities/:entityId`.
- **Expected:** 200 `{ ok: true }`; every shot that had the id in
  `referencedEntityIds` no longer does (verified via `GET` on those shots);
  the R2 object at `projects/{id}/entities/{entityId}/sheet.png` is deleted
  (`deleteObject`, best-effort — a second delete/missing object doesn't
  error the request); the entity row is gone from `GET /entities`.
- **Verified:** live (browser e2e — deleted an entity from the rail,
  confirmed its chips vanished from both the inspector and storyboard
  without a reload).

### TC-1.7: Name immutable via type, editable via name/description
- **Action:** `PATCH /entities/:entityId` with `{ description: "new desc"
  }` only.
- **Expected:** 200, `description` updated, sheet/`referenceStatus`
  untouched (no auto-redraw — see feature.md Tradeoffs).
- **Verified:** live (curl + browser e2e inline edit).

---

## 2. Reference-Sheet Generation Lifecycle

### TC-2.1: Generate transitions pending → generating → done
- **Action:** `POST /entities/:entityId/reference` on a `pending` entity.
- **Expected:** Row immediately flips to `referenceStatus: "generating"`;
  on fal.ai success, flips to `"done"` with `referenceSheetPath` set and
  the response includes a fresh presigned `referenceSheetUrl`.
- **Verified:** live — generated a character sheet for "Liu Bang" and a
  location sheet for the "Imperial throne room" on Project T; both came
  back visibly on-model in the project's style (multi-view character sheet
  with consistent face/hair/dress across views; multi-angle location sheet
  with consistent architecture/lighting).

### TC-2.2: Type-specific prompt template
- **Action:** Generate one sheet each for a `character`, a `location`, and
  an `object` entity; inspect the prompt sent (via server log).
- **Expected:** Each uses its own template from `sheetPrompt()` in
  `src/lib/reference-sheet.ts` — character requests front/side/
  three-quarter/close-up views; location requests wide/mid/detail views;
  object requests front/three-quarter/detail-close-up views. All append
  the project `styleString` (via `generateImage`'s existing style-suffix
  behavior, unchanged).
- **Verified:** live (log inspection during TC-2.1's two generations; a
  third object-entity generation was spot-checked via log only, not
  visually reviewed in this pass).

### TC-2.3: Failure sets referenceStatus: failed with a generic error
- **Action:** Trigger a generation failure on an entity's reference-sheet
  generation call.
- **Expected:** 502 `{ error: "Reference sheet generation failed" }`;
  `referenceStatus` persists as `"failed"`; no partial `referenceSheetPath`
  write; the rail shows the failed state with a Redraw retry affordance.
- **Verified:** live 2026-07-04.

### TC-2.4: Redraw regenerates and replaces the sheet
- **Action:** Click "Redraw" on an entity that already has a `done` sheet.
- **Expected:** New `referenceStatus: "generating"` → `"done"`; a new image
  at the same R2 key (overwritten); the rail thumbnail updates to the new
  image once the response returns.
- **Verified:** live (browser e2e, redrew the Liu Bang sheet once).

---

## 3. Auto-Extract + Auto-Tag

Auto-extract was run **3 times** live on Project T during implementation:
the first two runs surfaced the alias-priming bug (below), the third ran
clean.

### TC-3.1: Extract proposes recurring entities from the script
- **Action:** Click "Auto-extract from script" on an empty (no-entity)
  project, or `POST /entities/extract`.
- **Expected:** 200; `entities` includes newly created rows (e.g. Liu Bang,
  Xiang Yu, Qin Shi Huang, and location-type entities for recurring
  settings); `created` reflects the count of genuinely new entities;
  response also includes `shotTags` (`{ [shotId]: string[] }`) so the
  client applies tags without a refetch.
- **Verified:** live — 3rd (clean) run produced 12 entities on Project T
  with no duplicate/overlapping proposals.

### TC-3.2: Existing-entity exclusion (exact-string dedup)
- **Action:** Run extract a second time on a project that already has
  entities from a prior run, where the script contains no new recurring
  subjects.
- **Expected:** Every candidate whose lowercased name exactly matches an
  existing entity's name is skipped (`skipped` count increments, `created`
  stays low or zero for those). The system prompt is also given the
  pre-insert list of existing names so Claude is asked not to re-propose
  them or their aliases in the first place.
- **Verified:** live (2nd of the 3 runs).

### TC-3.3: Alias-containment filter catches prompt-priming failures
- **Bug found live:** the 1st/2nd extract runs on Project T showed Claude
  proposing a name-containing variant of an already-registered entity (the
  negative-example instruction "don't re-propose X" in the system prompt
  inadvertently primed a variant like "Emperor Gaozu (Liu Bang as emperor)"
  against an existing "Liu Bang"). The exact-string dedup (TC-3.2) does not
  catch this because the names aren't identical strings.
- **Fix:** `filterAliasOverlap()` in `src/lib/entity-extraction.ts` —
  deterministic, non-LLM backstop: drops any candidate whose
  lowercased/trimmed name contains, or is contained by, any existing
  entity's lowercased/trimmed name.
- **Expected (post-fix):** the containing-variant candidate is dropped
  before insertion; a `console.warn` logs the drop.
- **Verified:** live — 3rd run (post-fix) produced no alias-overlap
  candidates; confirmed via server log that the filter fired zero times on
  the clean run (no false positives against the real, distinct entity
  names in that script).
- **Known limitation (documented, not a bug):** the filter is
  substring-based and can over-suppress a genuinely distinct entity whose
  name happens to contain/be-contained-by an existing one (e.g. an existing
  location name blocking an unrelated candidate that shares a word). The
  manual "+ Add entity" form is the escape hatch — it bypasses extraction
  entirely.

### TC-3.4: Tag batching (40 shots/batch)
- **Action:** Run extract on a project with >40 shots.
- **Expected:** `tagShots()` splits shots into sequential batches of 40;
  each batch is one forced-tool Claude call; results are merged into one
  combined map before being written to `shots.referencedEntityIds`.
- **Verified:** live — Project T's shot count exercised the batching path
  (confirmed via server log showing multiple `[entity-tag] batch of N`
  lines for one extract call).

### TC-3.5: Fan-out caps reject oversized inputs (security fix F2)
- **Action:** `POST /entities/extract` on a project whose joined beat text
  exceeds 60,000 characters, or whose shot count exceeds 400.
- **Expected:** 400 "Script too large for auto-extract" / "Too many shots
  for auto-extract" — rejected before any Claude call is made (no partial
  spend). This was security finding F2, fixed in `ccf0363`.
- **Verified:** live (curl) 2026-07-04.

### TC-3.6: Zero-script / zero-shot projects don't crash
- **Action:** `POST /entities/extract` on a project with no beats
  (`fullScript` empty) or no shots.
- **Expected:** 200 with `created: 0, taggedShots: 0` and no entities
  array mutation — the extract/tag Claude calls are skipped entirely
  (`fullScript.length > 0` and `allEntities.length > 0 && shotRows.length >
  0` guards), not a 500.
- **Verified:** live (curl against a freshly created project with no beats
  yet).

---

## 4. Entity-Conditioned Shot Image Generation

### TC-4.1: Primary-entity resolution — character wins over other tagged types
- **Action:** Tag a shot with both a `character` entity and a `location`
  entity, both with `done` sheets, then `POST /shots/:shotId/image`.
- **Expected:** `resolvePrimaryEntity()` selects the character entity as
  primary (character type takes priority over tag order); the log line
  reads `conditioned on entity=<id> (<character name>)`.
- **Verified:** live (browser e2e + server log inspection on Project T,
  tagging a shot with both the Liu Bang character and the Imperial throne
  room location).

### TC-4.2: No sheet-ready tagged entity → unconditioned generation
- **Action:** Tag a shot only with entities whose `referenceStatus` is not
  `"done"` (e.g. `pending` or `failed`), then generate the shot's image.
- **Expected:** `resolvePrimaryEntity()` returns `null`; generation proceeds
  exactly as unconditioned (text-to-image, no `image_url`); log line reads
  `unconditioned`.
- **Verified:** live (tagged a shot with a `pending` entity before drawing
  its sheet; confirmed unconditioned generation via log, then re-ran after
  drawing the sheet and confirmed the log switched to `conditioned on
  entity=...`).

### TC-4.3: Conditioned image is visibly on-model
- **Action:** Generate a shot's image while tagged with a `done`-sheet
  character entity.
- **Expected:** The resulting image's depiction of that character
  (face/hair/dress) visibly matches the reference sheet, not a freshly
  reinterpreted appearance.
- **Verified:** live — a Liu Bang-tagged shot's generated image was visibly
  on-model against the character sheet (same face, hair, and dress
  consistent with the sheet's front/three-quarter views).

### TC-4.4: Foreign / unknown entity id on shot PATCH rejected
- **Action:** `PATCH /shots/:shotId` with `referencedEntityIds` containing
  a UUID that doesn't belong to any entity in this project (either a
  well-formed random UUID or an entity id from a different project).
- **Expected:** 400 "entity does not belong to this project". No write.
- **Verified:** live (curl, tested with a random valid UUID not present in
  the project's entity table).

### TC-4.5: `referencedEntityIds` shape validation
- **Action:** `PATCH /shots/:shotId` with `referencedEntityIds` as a
  non-array, or an array of >8 entries, or an array containing a
  non-UUID string.
- **Expected:** 400 "referencedEntityIds must be an array of at most 8
  UUIDs" in all three cases.
- **Verified:** live (curl, all three malformed shapes).

---

## 5. Chips — Tag/Untag Persistence + Live Rail Counts

### TC-5.1: Toggling a chip in the inspector persists via shot PATCH
- **Action:** Open a shot's inspector panel, click an entity chip in "In
  this shot" to tag it (or click again to untag).
- **Expected:** `tagShot(shotId, entityIds)` fires a `PATCH
  /shots/:shotId` with the updated `referencedEntityIds`; the chip's
  selected state updates immediately (optimistic); a page reload shows the
  same tagged state (server-persisted).
- **Verified:** live (browser e2e, tagged and untagged a shot, reloaded,
  confirmed state survived).

### TC-5.2: Rail shot counts update live after tagging
- **Action:** Tag/untag a shot with an entity via the inspector chips,
  without navigating away.
- **Expected:** The Cast & Locations rail's card for that entity shows an
  updated `{type} · {shotCount} shots` count immediately — no refetch or
  page reload needed (both the inspector and rail read `entities`/`shots`
  from the same shared `editor-store.tsx`).
- **Verified:** live (browser e2e — watched the rail's shot count increment
  from tagging a second shot with the same entity, and decrement on
  untagging, both without a reload).

### TC-5.3: Storyboard badges reflect the same tags
- **Action:** Tag a shot via the inspector, switch to the Storyboard view.
- **Expected:** The shot's card shows an outline badge with the tagged
  entity's name, via the shared `entitiesOfShot()` helper — no separate
  fetch.
- **Verified:** live (browser e2e, confirmed badge appears immediately
  after toggling a chip and switching views).

### TC-5.4: No-sheet hint in the inspector
- **Action:** Tag a shot with an entity whose sheet is not yet `done`.
- **Expected:** The inspector shows a muted hint ("no reference sheet yet —
  Redraw in the rail") instead of implying the tag will condition
  generation.
- **Verified:** live (browser e2e, tagged a shot with a `pending` entity
  before its sheet was drawn).

---

## Summary

All sections above were verified live on 2026-07-04, via a combination of
browser e2e and curl against the running dev server on branch
`feat/v4-phase4-reference-bible`, using Project T as the live test project.
