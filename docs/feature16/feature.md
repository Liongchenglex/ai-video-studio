# Feature: F-16 Reference Bible (Character & Setting Consistency)

> **Status: PLANNED — design approved 2026-06-13, not yet implemented.**
> Authoritative design: [`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md) (Pillar C).
> **Supersedes** backlog item **F-07a** (Entity reference images), which is the
> earlier, narrower draft of this feature. File paths below are *planned*, not
> yet on disk — this doc is the pre-implementation navigation map per
> `feature-playbook.md`.

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
generation endpoints, and its own UI rail. The only coupling point is
`shots.referencedEntityIds` and the image-generation call.

## Directing-first flow (design intent)
1. **Auto-extract** — Claude reads the script and proposes recurring entities.
2. **Auto-generate** — each entity gets one multi-view reference-sheet image
   (FLUX, in project style, seeded from an editable description).
3. **Auto-tag** — Claude infers which beats/shots each entity appears in.
4. **Curate** — user renames, redraws, deletes, or fixes tags.
5. **Condition** — a tagged shot's image generation passes the entity's
   reference sheet to FLUX.1 Kontext.

Build order by payoff: **characters → locations → objects** (table + UI hold
all three from day one; no later migration).

## Key Files (PLANNED)

Frontend:
- `src/components/reference-bible-panel.tsx` — the left-rail "Cast & Locations"
  list: entity cards (thumbnail, name, type, shot count), add/auto-extract,
  per-entity regenerate-reference, curate.
- Editor inspector (`src/components/editor-prototype.tsx` successor) — the
  per-shot multi-select "Entities in this shot" chip field that writes
  `shots.referencedEntityIds`.

Backend:
- `src/app/api/projects/[id]/entities/route.ts` — list / create entities.
- `src/app/api/projects/[id]/entities/[entityId]/route.ts` — get / update /
  delete a single entity.
- `src/app/api/projects/[id]/entities/[entityId]/reference/route.ts` —
  generate / regenerate the entity's multi-view reference sheet (FLUX).
- `src/app/api/projects/[id]/entities/extract/route.ts` — Claude auto-extract
  entities + pre-tag shots from the script.
- `src/lib/image-generation.ts` — extend `generateImage(...)` to accept
  `entityReferencePaths` and stack them onto the FLUX.1 Kontext request
  alongside `styleRefPaths`.
- `src/app/api/projects/[id]/shots/[shotId]/image/route.ts` — resolve a
  shot's tagged entities → reference paths → pass to the service.

## Data Models (PLANNED)

**New table `entities`:**

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| projectId | uuid (FK cascade) | owner project |
| name | text NOT NULL | e.g. "Liu Bang", "Imperial Palace" |
| type | enum | `character` \| `location` \| `object` |
| description | text | user-editable; seeds the reference sheet |
| referenceSheetPath | text | R2 key of the multi-view sheet image |
| referenceStatus | enum | pending / generating / done / failed |
| createdAt / updatedAt | timestamp | |

**Change to `shots`:**

| Column | Type | Notes |
|---|---|---|
| referencedEntityIds | jsonb<string[]> | entity ids tagged in this shot |

Lifecycle: entities are owned by the project and cascade-deleted with it.
Editing an entity's `description` and regenerating produces a new
`referenceSheetPath`; tagged shots become "stale" and can be re-imaged.

## APIs (PLANNED)

All auth-required and ownership-scoped via `entities → projects.userId`.

- `GET  /api/projects/:id/entities` — list entities for the project.
- `POST /api/projects/:id/entities` — create one (name, type, description).
- `GET/PATCH/DELETE /api/projects/:id/entities/:entityId` — single entity CRUD.
- `POST /api/projects/:id/entities/:entityId/reference` — (re)generate the
  multi-view reference sheet via FLUX. Sets `referenceStatus` lifecycle.
- `POST /api/projects/:id/entities/extract` — Claude auto-extracts entities
  from `projects.script` (or beat text) and pre-populates
  `shots.referencedEntityIds`. User reviews.

## State & Ownership
- **Source of truth:** Neon `entities` table + R2 reference-sheet assets;
  `shots.referencedEntityIds` for the shot↔entity links.
- **Cached on client:** entity list + presigned `referenceSheetUrl` held in
  the editor's shared store (same single-source-of-truth store the Timeline
  and Storyboard views read — see F-08 v4.0 notice).

## Security
- **Auth required:** every endpoint.
- **Ownership enforced on:** all entity reads/writes (join to
  `projects.userId`); the shot-image endpoint must verify every tagged
  entity belongs to the same project before fetching its reference.
- **Rate limiting:** `generation` preset on reference-generation + extract;
  `mutation` preset on entity CRUD.
- **CSRF:** Origin-header verification on all mutations.
- **Input validation:** UUIDs on path params; `type` ∈ enum; non-empty name;
  `referencedEntityIds` validated to existing project entities.
- **Secrets:** `FAL_KEY`, `ANTHROPIC_API_KEY` server-side only.
- **R2 access:** reference sheets are private; client gets presigned GET URLs.

## Dependencies
- **External services:** fal.ai (FLUX.1 Kontext — sheet generation + shot
  conditioning), Anthropic Claude (auto-extract + auto-tag), Cloudflare R2.
- **Shared utilities:** `src/lib/r2.ts`, `src/lib/image-generation.ts`,
  `src/lib/api-utils.ts` (session, CSRF, rate-limit, validation).
- **Feature coupling:** F-02 style profile (sheets generated in project
  style), F-08 editor (tagging UI + the shared store), F-04 image generation.

## Coding Patterns Used (PLANNED)
- **One coherent multi-view sheet per entity** — all poses/angles generated
  in a single FLUX frame so they are mutually consistent, then used whole as
  the conditioning reference. Cheaper (one generation per entity, not per
  pose) and stronger anchoring.
- **Conditioning reuse** — entity references stack onto the *same* FLUX.1
  Kontext multi-image input already used for style refs; same mechanism,
  different semantics.
- **Auto-with-curation** — Claude proposes (extract + tag); user disposes.
  Matches the editor's "directing, not assembling" theme.

## Tradeoffs (honest)
- **Multi-entity-per-shot conditioning is the hard part.** A shot featuring
  both a character *and* a location needs both references; FLUX.1 Kontext is
  strongest with a single reference. **Build single-entity conditioning
  first (rock-solid); layer multi-entity after** (composite references, or
  primary-reference + describe-the-rest fallback). Also verify the Kontext
  per-call reference-image cap — style refs already consume some slots
  (carried over from F-07a's open question).
- **Single multi-view sheet, not true per-pose turnarounds (v1).** We start
  with one coherent sheet image; richer per-pose anchoring is deferred.
- **Sheet regeneration orphans tagged shots' images.** Editing an entity
  invalidates the look of shots that used it; surfaced as a "stale" state +
  batch re-image, not auto-regenerated (cost control).

## Relationship to other features / backlog
- **Supersedes:** backlog **F-07a** (entity reference images) — folded here.
- **Strengthens:** backlog **#8** (multi-keyframe clips) — keyframes can
  condition on entity sheets once both exist.
- **Lives inside:** the F-08 v4.0 unified editor (left rail) over the shared
  Timeline/Storyboard store.
