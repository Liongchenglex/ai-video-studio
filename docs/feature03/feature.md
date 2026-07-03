# Feature: F-03 Script Generation (v4.0 Phase 2 — generation in setup, beats own editing)

> **✅ v4.0 Phase 2 SHIPPED 2026-07-03.** The separate Script step is gone:
> `step-script.tsx` and the Script → Editor stepper hop are deleted. Script
> **generation** still happens as the unified editor's first-run gate (style
> + brief → script, same Claude call as before); script **editing** no
> longer happens on a whole-script textarea — once the script is segmented
> into beats (F-08/F-05 Phase 1), editing happens **inline, per beat**, in
> the editor's script strip, and each edit re-voices only that beat. See
> [`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md)
> for the full design and [`docs/feature08/feature.md`](../feature08/feature.md)
> for the editor that now hosts this.
>
> **What changed vs. the v3.0 implementation documented below:**
> - Generation: unchanged mechanically (`POST /script/generate`, same
>   Claude Sonnet 4.5 + web-search call, same `projects.script` persistence)
>   but the UI trigger moved from a dedicated Script step to
>   `unified-editor.tsx`'s first gate ("no script → Generate script card").
>   Regenerating an already-segmented script is intentionally **not**
>   offered once beats exist — beats own the text from that point on.
> - Editing: `PATCH /api/projects/:id` with a whole `script` field is no
>   longer how users edit narration day-to-day — see F-05/F-08 for the
>   per-beat edit path (`POST /beats/:beatId/revoice` with `{ text }`).
>   The whole-script PATCH still exists at the API level (used once, right
>   after generation, before beats exist) but the textarea UI that drove it
>   (`step-script.tsx`) is deleted.
> - **Cast & Locations tie-in still pending.** The Reference Bible (F-16)
>   auto-extract from the script is **Phase 4**, not built yet — see
>   [`docs/feature16/feature.md`](../feature16/feature.md).
>
> The sections below are the original v3.0 documentation and remain
> accurate for the parts that didn't change (generation mechanics, Claude
> call, data model). Historical UI references (`step-script.tsx`, the
> 4-step stepper) describe what has been removed — see F-08's feature doc
> for the current stepper (Concept → Style → Editor).

## Feature
- **Name:** Script Generation
- **Purpose:** Generate a full narrated script from the user's brief as
  plain prose with paragraph breaks — no scene structure, no per-scene
  metadata. The script becomes the authoritative source of narration; all
  downstream features (VO, shots, editor) derive from it.

## v3.0 architectural shift

This feature was restructured during the editor-first pivot (PRD v3.0):

- **v2.0:** Claude emitted a structured JSON array of scenes, each with its
  own voiceover, scene description, image prompt, duration, etc.
- **v3.0:** Claude emits one plain-text script with paragraph breaks. No
  scene structure — shots are user-defined on the editor timeline instead.

The `scenes` table was dropped. `projects.script` (plain text) is now the
source of truth for narration.

## Key Files

Frontend:
- `src/components/step-script.tsx` — textarea editor with auto-save on blur,
  live word count + estimated duration (at 150 wpm baseline)
- `src/components/project-workspace.tsx` — orchestrates the Concept → Style
  → Script → Editor stepper; owns the `script` state

Backend:
- `src/lib/script-generation.ts` — Claude Sonnet 4.5 with web search tool
  use; streams the final message; validates `stop_reason`; retries on
  transient failures
- `src/app/api/projects/[id]/script/generate/route.ts` — persists Claude's
  output to `projects.script`; invalidates any existing VO on the project
- `src/app/api/projects/[id]/route.ts` — PATCH accepts `script` edits;
  invalidates VO on script change (VO, timestamps, duration all null-ed)

## Data Models

- `projects.script` — text, nullable. Plain prose with paragraph breaks.
  Replaces the deprecated `scenes` table entirely.
- `projects.brief`, `targetDuration`, `tone` — inputs consumed by script
  generation (unchanged from v2.0).
- VO fields on `projects` (voiceoverPath, voiceoverStatus,
  voiceoverTimestamps, durationSeconds) are invalidated on any script
  change — user re-generates VO from the Editor step.

## APIs

- `POST /api/projects/:id/script/generate` — auth-required, rate-limited
  (`generation` preset: 5/min). Generates script, persists to
  `projects.script`, invalidates VO fields. Returns `{ script }`.
- `PATCH /api/projects/:id` — accepts a `script` field (max 50,000 chars).
  On change, sets `voiceoverPath = null`, `voiceoverStatus = 'pending'`,
  clears timestamps and duration.

## State & Ownership

- **Source of truth:** `projects.script` in Neon.
- **Cached on client:** The Script step holds a local textarea value which
  is flushed to the server on blur via `PATCH /api/projects/:id`.
- **Invalidation:** Any script update cascades to VO invalidation (VO is
  re-derived from the script when the user enters the Editor).

## Security

- **Auth required:** All endpoints require a valid BetterAuth session.
- **Ownership enforced on:** Every query scoped by `userId`.
- **Rate limiting:** `generation` preset (5/min) on script/generate.
  `mutation` preset (30/min) on PATCH /projects/:id.
- **Input validation:** script max 50,000 chars; brief max 5,000 chars;
  target duration whitelist (3/5/8/10); tone whitelist.
- **CSRF:** Origin header verification on all mutation endpoints via
  `verifyCsrf()` helper.
- **Error handling:** Generic client-facing error messages. Detailed error
  logging server-side only.

## Dependencies

- **External services:** Anthropic API (Claude Sonnet 4.5) with the
  `web_search_20250305` server-side tool.
- **Libraries:** `@anthropic-ai/sdk`.
- **Shared utilities:** `src/lib/api-utils.ts` (session, CSRF, rate-limit,
  validation helpers).

## Coding Patterns Used

- **Streaming for long generations:** Anthropic SDK requires streaming for
  operations that might exceed 10 minutes. Script + web search combined
  reliably triggers the limit, so we use `anthropic.messages.stream().finalMessage()`.
- **Web search via server-side tool:** Claude runs 2–4 searches before
  writing the script for factual grounding; no client-side tool plumbing
  needed.
- **Invalidation cascade:** writing `projects.script` wipes dependent VO
  fields in the same transaction so the Editor can detect staleness.
- **150 wpm baseline:** client-side word-count-to-duration estimation uses
  this average; actual duration comes from ElevenLabs after VO generation.

## Tradeoffs

- **No per-paragraph regeneration.** v2.0 supported "regenerate this scene";
  v3.0 regenerates the whole script. Consequence of dropping scene
  structure. Users can still manually edit single paragraphs in the textarea.
- **No structured hook marker.** v2.0 marked the first ~30s as `is_hook`;
  v3.0 relies on Claude to put the dramatic opener in paragraph 1 by
  instruction alone. No enforcement.
- **Duration drift not auto-corrected.** PRD v3.0 AC calls for a
  "tighten/expand" regen action when actual VO duration drifts >10% from
  target. Not yet implemented — see `docs/backlog.md` #11.
- **Rate-limit cost of expansion pass:** when the first-pass script is too
  short, the generator re-prompts Claude — two generations counted as one
  user click.
