# Security Review — F-16 Reference Bible (v4.0 Phase 4)

**Date:** 2026-07-04
**Scope:** All code introduced or changed on `feat/v4-phase4-reference-bible`
(diff `1b03941..60f618c`) — entity CRUD, reference-sheet generation, Claude
auto-extract + auto-tag, entity-conditioned shot image generation, the
`referencedEntityIds` extension to shot PATCH, and the Reference Bible UI
(`src/components/editor/reference-bible-panel.tsx` + inspector/storyboard
chips).
**Playbook:** `security-playbook.md`.
**Reviewed by:** an independent agent with no access to the implementation
session, against the checklist below.

**Verdict: SHIP WITH FIXES** — both findings (F1, F2) were fixed in commit
`ccf0363` before merge.

---

## Checklist results (all PASS)

1. **AuthN + AuthZ.** Server-side session check
   (`getSession()` → `unauthorizedResponse()`) on every new route; ownership
   join to `projects.userId` on every entity/shot read and write;
   `entityId`/`shotId`/`beatId` UUID-validated before any query. No IDOR
   path — a foreign id at any layer resolves to 404, never a 403 or a leak
   of another user's data.

2. **Cross-table authorization is airtight.**
   - Shot PATCH validates every `referencedEntityIds` entry against this
     project's `entities` table before writing (`src/app/api/projects/[id]/shots/[shotId]/route.ts`)
     — a foreign or nonexistent entity id → 400 "entity does not belong to
     this project", no partial write.
   - The shot-image route (`.../shots/[shotId]/image/route.ts`) resolves
     reference sheets only through a project-scoped `entities` query
     (`resolvePrimaryEntity()` filters by `projectId` + `inArray(id, tagged)`
     + `referenceStatus = "done"`) — a shot can never condition on another
     project's entity, even if a stale/forged id somehow reached the column.
   - The extract route writes tags only to project-scoped shots; the
     Claude-returned `shot_id` values in `tagShots()` are checked against
     `validShotIds` (the batch's own known set) before being trusted —
     Claude cannot cause a write to a shot outside the batch it was given.

3. **Input validation.**
   - `name` 1–100 chars, `description` ≤2000 chars, `type` restricted to the
     `entityTypeEnum` values, immutable after create.
   - `referencedEntityIds`: array, ≤8 entries, every entry a UUID.
   - Malformed JSON → 400 (see F1 below — fixed).
   - Zero-beat / zero-shot projects are guarded in the extract route
     (`fullScript.length > 0` / `allEntities.length > 0 && shotRows.length >
     0` short-circuits, no crash on an empty project).
   - Claude's tool-use output is re-validated and clamped server-side in
     both `extractEntities` (`validateExtractedEntity` — type/name/
     description shape and length) and `tagShots` (`resolveEntityNames` —
     unknown names dropped, ≤8/shot) — raw model output is never trusted
     or written directly.

4. **Rate limits + CSRF.** `generation` preset (5/min) on sheet generation,
   extract, and shot-image (all paid, external-API-backed); `mutation`
   preset on entity CRUD and shot tagging. `verifyCsrf()` (Origin header)
   on every mutating route, fail-closed, in the standard order
   (rate-limit → CSRF → session → ownership → validation).

5. **Secrets.** `FAL_KEY`, `ANTHROPIC_API_KEY`, and R2 credentials are read
   server-side only (`process.env.*` in route/lib files, never in
   `src/components/**`). No throwaway test scripts or debug endpoints were
   left in the tree — verified via `git ls-files` / `git status` on the
   branch.

6. **R2 access.** Reference sheets are stored under
   `projects/{projectId}/entities/{entityId}/sheet.png`, a private bucket;
   clients only ever receive a presigned GET URL (`getDownloadUrl`, 1h
   expiry) minted by an owner-scoped route. The same presigned URL is
   handed to fal.ai as `image_url` for conditioned generation — assessed
   acceptable: it is the user's own generated asset, expiry is short (1h),
   and fal.ai fetches it immediately server-side (no client exposure).

7. **Prompt injection.** Script text and entity names/descriptions reach
   Claude and FLUX only within the same user's own project scope — there is
   no privilege boundary for injected text to cross (a user can only
   degrade their own project's extraction/tagging quality, never another
   user's). All DB writes derived from Claude output go through
   parameterized Drizzle queries; nothing is templated into SQL. Assessed
   inert.

8. **Error hygiene.** Client-facing messages are generic and static (e.g.
   "Reference sheet generation failed", "Auto-extract failed"); detail
   (stack traces, `err` objects) is logged server-side only via
   `console.error`. Failure states persist to DB (`referenceStatus:
   "failed"`, `imageStatus: "failed"`) so the UI can offer retry without
   revealing internals. Routes fail closed — an error mid-generation still
   flips status to `"failed"` in a `.catch()`, never leaves a row stuck at
   `"generating"` silently (best-effort; see Tradeoffs in `feature.md` on
   the lack of a concurrency lock).

9. **DoS / cost-amplification.** Sheet generation and shot-image generation
   are single-image endpoints per call — the risk is exclusively in the
   extract endpoint's fan-out (see F2 below).

---

## Findings and resolutions

### F1 (Low) — malformed JSON bodies caused 500s instead of 400s
**Where:** `entities` POST, `entities/[entityId]` PATCH, `shots/[shotId]`
PATCH.
**Issue:** A body that parsed successfully as JSON but wasn't a plain
object — a literal `null`, a JSON array, or a bare scalar (`"true"`, `42`)
— passed the `try { await request.json() } catch {}` guard (which only
catches *parse* failures) and then threw an uncaught `TypeError` on the
first property access (`body.name`, etc.), surfacing as an unhandled 500
instead of a validated 400.
**Fix (`ccf0363`):** added an explicit body-shape guard immediately after
the parse try/catch in all three routes:
```ts
if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
  return badRequestResponse("Invalid request body");
}
```
Verified live: `POST /entities` with body `null`, `[]`, and `"x"` each now
return 400, not 500.

### F2 (Low) — unbounded Claude fan-out on auto-extract
**Where:** `POST /api/projects/:id/entities/extract`.
**Issue:** The endpoint fans out to `1 + ceil(shots / 40)` paid Claude
calls (one `extractEntities` call + one `tagShots` call per 40-shot batch)
with no upper bound on script length or shot count. A project with an
extremely long script or an extremely large shot count could drive
unbounded per-request cost, still gated by the existing 5/min `generation`
rate limit but with no per-call ceiling.
**Fix (`ccf0363`):** added explicit caps before any Claude call is made —
script `> 60,000` chars → 400 "Script too large for auto-extract"; shots
`> 400` → 400 "Too many shots for auto-extract". Both caps sit at roughly
7× the largest real project's script length / shot count at the time of
review, bounding worst-case per-request spend while leaving normal usage
untouched.
**Noted, not fixed (backlog item):** rate limiting in this codebase is
per-IP, not per-user (a pre-existing platform limitation, not introduced by
this phase). A per-user spend/rate budget for paid endpoints is tracked in
`docs/backlog.md`.

### INFO (not a finding) — no per-project entity count cap
Entity rows are cheap (no generation cost on create) and sheet generation
is separately gated behind the `generation` rate limit and an explicit user
action, so an unbounded number of entities per project was assessed as
low-risk. Tracked as a backlog note only, not a blocking finding.

---

## Final Security Gate

| Item | Status |
|---|---|
| AuthN on every route | PASS |
| AuthZ / ownership incl. cross-table `referencedEntityIds` + shot-image resolution | PASS |
| Input validation (incl. malformed-body guard) | PASS (F1 fixed) |
| Rate limiting + CSRF | PASS |
| Fan-out / cost bound on extract | PASS (F2 fixed) |
| Errors safe / fail closed | PASS |
| Secrets untouched / server-side only | PASS |
| R2 access private + presigned | PASS |
| Prompt-injection surface | PASS (no privilege boundary crossed) |

## Sign-off

No unauthenticated mutation, no cross-user data exposure, no secret leak,
and no IDOR anywhere in the new entity/reference-bible surface. **Cleared
to ship** — both findings above were fixed before merge in `ccf0363`.
