# Feature: F-03 Script Generation

## Feature
Name: Script Generation
Purpose: Let users write a video brief and generate a structured, research-backed scene-by-scene script via Claude — with inline editing, per-row image prompt regeneration, add/delete scenes, and duration tracking.

## Key Files

Frontend:
- `src/components/video-brief.tsx` — brief textarea + duration/tone selectors, auto-saves on blur
- `src/components/script-table.tsx` — editable scene table with duration counter and drift warning
- `src/components/scene-row.tsx` — single inline-editable row with regenerate/delete actions
- `src/components/project-workspace.tsx` — integrates brief + script table below style profile
- `src/app/projects/[id]/page.tsx` — server component passing brief and scene data to workspace

Backend:
- `src/app/api/projects/[id]/route.ts` — PATCH extended for brief, targetDuration, tone
- `src/app/api/projects/[id]/script/generate/route.ts` — triggers full script generation
- `src/app/api/projects/[id]/scenes/route.ts` — list scenes (GET), add scene (POST)
- `src/app/api/projects/[id]/scenes/[sceneId]/route.ts` — update scene (PATCH), delete scene (DELETE)
- `src/app/api/projects/[id]/scenes/[sceneId]/regenerate/route.ts` — regenerate image prompt only
- `src/app/api/projects/[id]/scenes/reorder/route.ts` — reorder scenes by ID array

Services:
- `src/lib/script-generation.ts` — Claude web search + tool use for script generation, image prompt regeneration
- `src/lib/scene-utils.ts` — word count, duration estimation, drift calculation helpers

## Data Models
- `projects` table — added: `brief` (text), `target_duration` (integer, default 5), `tone` (enum: educational/entertaining/documentary/satirical)
- `scenes` table — `id`, `project_id` (FK, cascade delete), `sort_order`, `voiceover`, `scene_description`, `image_prompt`, `duration_seconds`, `is_hook`, timestamps
- Index: `scenes_project_id_sort_order_idx` on (project_id, sort_order)

## APIs
- `PATCH /api/projects/:id` — accepts brief (max 5000 chars), targetDuration (3/5/8/10), tone
- `POST /api/projects/:id/script/generate` — generates full script from brief via Claude with web search
- `GET /api/projects/:id/scenes` — lists scenes ordered by sortOrder
- `POST /api/projects/:id/scenes` — adds a scene at a given position
- `PATCH /api/projects/:id/scenes/:sceneId` — inline update of voiceover, sceneDescription, imagePrompt, durationSeconds
- `DELETE /api/projects/:id/scenes/:sceneId` — removes scene and renumbers remaining
- `POST /api/projects/:id/scenes/:sceneId/regenerate` — regenerates image prompt only (voiceover/description untouched)
- `PUT /api/projects/:id/scenes/reorder` — accepts ordered array of scene IDs

## State & Ownership
Source of truth: Neon Postgres (brief/duration/tone on projects, scenes table)
Cached on client: scenes array + scriptKey in ProjectWorkspace for instant table updates
Scene edits persist on blur via PATCH calls

## Security
Auth required: All endpoints
Ownership enforced on: Every DB query scoped by userId; scenes scoped by projectId
Rate limiting: `generation` preset (5/min) on script generate + scene regenerate; `mutation` preset (30/min) on CRUD
Input validation: Scene text fields capped (voiceover 5000, description/prompt 2000 chars), duration 1-120s, insertAfter bounded, reorder array capped at 200
Error handling: Generic client messages; raw errors logged server-side only

## Dependencies
- Anthropic API / Claude Sonnet 4 (script generation with web search + tool use)
- `@anthropic-ai/sdk`

## Coding Patterns Used
- Claude tool use with forced tool call (`tool_choice`) for structured JSON output
- Web search tool (`web_search_20250305`) for factual research before script writing
- Multi-turn conversation loop handling web search → save_script flow
- Duration enforcement: server-side recalculation from word count + expansion pass if >15% under target
- Auto-save on blur pattern for inline editing (scene fields + brief)
- Key-based remount (`scriptKey`) to force ScriptTable update after regeneration

## Tradeoffs
- Regenerate button only refreshes image prompt, not full scene — user owns voiceover and scene description as first draft; randomness on regenerate would be counterproductive
- Duration enforcement uses a two-pass approach (generate → check → expand if short) rather than strict word count constraints in the prompt — Claude underestimates duration on longer videos
- Web search adds 5-10s to generation time but produces factually grounded content
- Scene durations recalculated server-side from actual word count at 150 wpm — Claude's own duration estimates are unreliable
- No drag-and-drop reorder UI in v1.0 (API supports it via reorder endpoint, UI deferred)
- Soft-deleted projects don't cascade-delete scenes — acceptable since ownership checks prevent access
