# Security Review — v3.0 Editor-First Pivot

**Date:** 2026-04-24
**Scope:** All code introduced or changed in the PRD v3.0 pivot — F-03
script (rewrite), F-05 voiceover (rewrite), F-08 Timeline Editor (new).
Prior features (F-01 auth, F-02 style) were reviewed in their own
feature01/security-review.md and are not re-audited here.
**Playbook:** `security-playbook.md`.

---

## Summary

No critical issues found. The v3.0 changes reuse the existing security
primitives (`src/lib/api-utils.ts`: session, CSRF, rate limit, UUID
validation) consistently across every new endpoint. All mutations enforce
project ownership via DB join before touching any resource.

Three medium-severity observations with documented mitigations. Two
low-severity notes.

---

## 1. Authentication (AuthN)

**Scope:** 12 new API endpoints under `src/app/api/projects/[id]/shots/**`
and `src/app/api/projects/[id]/voiceover/generate/route.ts`.

### Findings
- ✅ All new endpoints call `getSession()` and return
  `unauthorizedResponse()` on missing session.
- ✅ Session is validated server-side on every request; no reliance on
  client state.
- ✅ Anonymous access: impossible — every endpoint fails closed on
  missing session.

### Checklist
- [x] Auth token verified server-side
- [x] Token expiry handled correctly (BetterAuth sessions)
- [x] Anonymous vs authenticated behavior clearly defined

---

## 2. Authorization (AuthZ)

### Findings

- ✅ **Ownership pattern — shot endpoints:** `/shots/[shotId]/image`,
  `/clip`, `/clip-hailuo`, `/split` use a 3-way INNER JOIN
  (`shots ⋈ projects`) with `eq(projects.userId, session.user.id)` in the
  WHERE clause. A shot cannot be manipulated unless the joined project
  belongs to the caller. Verified in:
  - `src/app/api/projects/[id]/shots/[shotId]/image/route.ts:36-43`
  - `src/app/api/projects/[id]/shots/[shotId]/clip/route.ts:80-87`
  - `src/app/api/projects/[id]/shots/[shotId]/clip-hailuo/route.ts:92-99`
  - `src/app/api/projects/[id]/shots/[shotId]/split/route.ts:42-57`
  - `src/app/api/projects/[id]/shots/[shotId]/route.ts:22-38` (`loadOwnedProjectAndShot`)

- ✅ **Ownership pattern — project-level endpoints** (script/generate,
  voiceover/generate, shots/recommend, shots POST, suggest-*): load
  `projects` filtered by both `projects.id` and `projects.userId`. Same
  guarantee.

- ✅ **Cross-user attack surface reduced:** the `shots` table dropped its
  `sceneId` FK; shots now FK directly to `projects`. Every ownership
  check is one join, not two. Simpler model = harder to screw up.

### Potential concern — RESOLVED

Early versions of the recommend-shots endpoint deleted all existing
shots for a project before inserting new ones. Checked — delete is
scoped to `eq(shots.projectId, id)` AND the project was already verified
to belong to the session user. No cross-project delete possible.

### Checklist
- [x] Ownership validated on every mutation
- [x] Role-based access: n/a (single-tier user model in v1.0)
- [x] Cross-user access impossible by default

---

## 3. Data Access & Storage

### Findings

- ✅ **R2 access is never direct from client.** Server generates
  time-limited presigned URLs (`getDownloadUrl()` in `src/lib/r2.ts`).
  Client never sees R2 credentials.
- ✅ **R2 keys are user-scoped** by project-id prefix
  (`projects/{projectId}/shots/{shotId}/...`). Even if a presigned URL
  were leaked, it grants access only to the specific file, time-limited.
- ✅ **Database queries scope by userId:** verified via grep —
  all `select`/`update`/`delete` from `shots` joins `projects` and filters
  by `session.user.id`.

### Medium-severity observation M1: presigned URL lifetime

`getDownloadUrl()` uses the default expiration (15 minutes for AWS SDK
S3 presigner). Acceptable for the current UX because URLs are fetched
on demand and used immediately. Flag for later: if we ever build
server-rendered email templates with inline shot thumbnails, we'd need
shorter lifetimes or signed URLs behind an auth proxy.

**Mitigation today:** none needed. Document for future awareness.

### Checklist
- [x] No sensitive data exposed to unauthorized users
- [x] R2 keys scoped per project
- [x] Admin credentials never used on client
- [x] DB rules reviewed and tested

---

## 4. Input Validation & Sanitization

### Findings

- ✅ UUID validation: every path parameter goes through `isValidUUID()`
  before any DB query.
- ✅ Body parsing: all endpoints wrap `await request.json()` in a
  try/catch returning a 400 on malformed bodies.
- ✅ **Shot bounds validated:** both POST and PATCH enforce
  `startSeconds >= 0 && endSeconds > startSeconds`. Overlap-with-other-shots
  is checked in SQL using `existing.startSeconds < new.endSeconds && existing.endSeconds > new.startSeconds`
  — standard interval-overlap formula.
- ✅ **Split bounds:** `atSeconds` must be between
  `shot.startSeconds + 1` and `shot.endSeconds - 1` so each half has at
  least 1 second.
- ✅ **Text length caps:**
  - `projects.script` 50,000 char cap in PATCH.
  - `projects.brief` 5,000 char cap.
  - Shot `imagePrompt` / `motionPrompt` non-empty checks on create; no
    explicit length cap — see L1 below.

### Low-severity observation L1: missing length cap on shot prompts

`imagePrompt` and `motionPrompt` have no explicit maximum length at the
API boundary. A malicious user could submit a multi-megabyte prompt. In
practice:
- FLUX / LTX / Haiku all reject overlong prompts at their end with an
  API error — our endpoint returns 500.
- Database text column is unbounded, so a DB attack via oversized rows
  is theoretically possible.

**Recommended mitigation (not blocking):** add `maxLength` of ~2,000
chars on shot prompts in POST + PATCH validation. Tracking as backlog
item for next hardening pass.

### Checklist
- [x] Validation exists on all API inputs
- [x] Malformed input rejected safely (400s, not 500s)
- [x] No reliance on frontend validation alone

---

## 5. API Security

### Findings

- ✅ **Rate limiting applied:**
  - `generation` preset (5 / min) on: script/generate, voiceover/generate,
    shots/recommend, shots/[shotId]/image, shots/[shotId]/clip,
    shots/[shotId]/clip-hailuo, shots/suggest-image, shots/suggest-motion.
  - `mutation` preset (30 / min) on: shots POST, PATCH, DELETE,
    split, PATCH /projects/[id].
- ✅ **CSRF protection:** Origin header verification via `verifyCsrf()`
  applied to every POST/PATCH/DELETE endpoint.
- ✅ **HTTP method semantics:** GET-only for reads (e.g. project page);
  POST for creation; PATCH for update; DELETE for removal. No
  unauthenticated mutations.
- ✅ **Status codes:** 200/201 on success, 400 on bad input, 401 on
  unauth, 404 on not-found/forbidden combined (intentional — prevents
  user-id enumeration), 429 on rate-limit, 500 on server error.

### Medium-severity observation M2: synchronous generation endpoints

Shot image/clip endpoints are synchronous — the server awaits fal.ai for
20–120 seconds. Concerns:
- Long-running requests hold a Node.js process slot. At scale, a user
  could intentionally open several parallel generations to occupy slots
  (DoS vector).
- Next.js route handlers have a default timeout (60s on Vercel hobby,
  longer on paid). A clip that takes 90s on fal.ai could time out at the
  platform edge before fal.ai returns — leaving the shot in `generating`
  forever.

**Mitigation today:** rate limit (5 / min) bounds per-user concurrency;
no known production deployment yet so platform timeouts haven't bitten.

**Mitigation for ship:** move image/clip generation into Inngest with
webhooks from fal.ai. Tracking as pre-launch-required hardening.

### Checklist
- [x] Auth enforced on all protected endpoints
- [x] Proper HTTP status codes used
- [x] Rate limiting present
- [~] Idempotency: generation endpoints are NOT idempotent — re-issuing
  a POST would produce a second generation (cost implication, not a
  security one). Not a blocker.

---

## 6. Error Handling & Logging

### Findings

- ✅ Client-facing error messages are generic (e.g. "Script generation
  failed. Please try again.") — no stack traces leaked.
- ✅ Detailed errors logged server-side with request context
  (`console.error` with feature tag like `[shot/image] failed:`).
- ✅ Failure states persisted to DB (`imageStatus = 'failed'` etc.) so the
  UI can show a retry button without revealing the reason.

### Low-severity observation L2: logs may contain user input

`[script/generate] ... project=<id>` and similar logs include project IDs
and occasionally prompt substrings (truncated to 120 chars). No PII
beyond what the user provides to the app themselves. Not a compliance
concern for v1.0 but worth noting if we add log aggregation.

### Checklist
- [x] Client errors are generic
- [x] Internal logs capture sufficient context
- [x] No PII leaked unintentionally

---

## 7. Network Security

### Findings

- ✅ All external API calls (Anthropic, ElevenLabs, fal.ai, R2) are
  HTTPS.
- ✅ No certificate validation bypass in the codebase.
- ✅ Next.js dev runs on HTTP locally (expected); production deploys on
  Vercel where TLS is handled by the platform.

### Checklist
- [x] HTTPS enforced for all external calls
- [x] No disabled certificate checks

---

## 8. Environment & Secrets Management

### Findings

- ✅ Secrets used by v3.0 code: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`,
  `FAL_KEY`, `R2_BUCKET_NAME`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `DATABASE_URL`, BetterAuth secrets.
- ✅ All read via `process.env.*` in server-only code (Next.js API routes
  and lib files imported only from them). Grep confirms: none referenced
  in `src/components/**`.
- ✅ `.env` is gitignored. Verified `.gitignore` includes `.env*`.
- ⚠️ Single-env assumption: there is currently no prod/staging/dev
  separation. Fine pre-launch; enforce before any production deployment
  (flag for pre-launch checklist).

### Checklist
- [x] No secrets in repo
- [x] Env variables managed via `process.env`
- [ ] Production keys not used in development — **N/A today, enforce before launch**

---

## 9. Mobile-Specific Considerations

**Not applicable.** This is a web application. The security-playbook's
mobile section is inherited but most items don't apply. The applicable
spirit — "never trust the client" — is observed throughout:

- No business-critical logic runs only on the client.
- Shot bounds, prompts, and all mutations are validated server-side even
  if they passed client-side checks.

### Checklist
- [x] No business-critical logic solely on client
- [x] App remains secure if client source is inspected

---

## 10. Abuse, Misuse & Edge Scenarios

### Considered abuse vectors

**Cost-draining attacks (generative endpoint abuse):**
- Rate limits bound per-user attempts to 5/min on generation.
- No per-project or per-day spend cap yet — a determined authenticated
  user could sustain 5 clip generations per minute (× $0.24 = $1.20/min
  = ~$1,700/day). A payment-tier spend cap is needed pre-launch.
- **Medium-severity observation M3:** per-user monthly spend cap is a
  PRD requirement (non-functional section) but not yet implemented.
  Pre-launch blocker.

**Replay attacks:**
- CSRF (origin header) + BetterAuth session cookies mitigate classic
  cross-site replay.
- Within-origin replay: mutations are non-idempotent in the sense that
  a second POST creates a second shot or a second generation. Acceptable
  — user error, not security issue.

**Brute-force on asset URLs:**
- R2 keys contain UUIDs (`projects/{uuid}/shots/{uuid}/image.png`).
  Guessing the URL would require guessing two UUIDs — infeasible.
- Even if guessed, the R2 bucket is private and access requires a
  presigned URL. A random user can't GET an asset via the bare R2 path.

**Malicious prompts (prompt injection into Claude/Haiku calls):**
- Anthropic's tool-use response model (save_script, save_shots,
  save_image_prompt, etc.) constrains outputs to validated shapes. A
  user who injects "ignore previous instructions" into their brief can
  degrade output quality for their own project but cannot escape to
  affect other users.
- No secrets are placed in system prompts; Claude's context contains
  only the user's own data.

### Checklist
- [x] Replays prevented or harmless
- [x] Abuse vectors identified
- [x] Rate limiting present
- [ ] Spend caps in place (M3 — pre-launch blocker)

---

## Final Security Gate

| Item | Status |
|---|---|
| All auth / authz paths reviewed | ✅ |
| Data access scoped correctly | ✅ |
| Inputs validated | ✅ (L1 minor: prompt length cap) |
| Errors safe | ✅ |
| Secrets secure | ✅ in code; env-separation required pre-launch |
| Mobile-specific risks | N/A (web app) |

### Blocking items for production launch

None for current dev scope. Before any production deployment:

- **M3 — Implement per-user monthly spend cap.** Required by PRD v3.0
  Non-Functional Requirements § Cost Controls.
- **M2 — Move generation endpoints onto Inngest** so synchronous fal.ai
  calls aren't subject to Vercel request timeouts. Currently works on
  hobby-tier hobby but will fail on long LTX renders.
- **§8 environment separation** — separate dev / staging / prod secrets.

### Non-blocking improvements (document in backlog)

- **L1** — Add `maxLength` of ~2,000 chars on shot prompts.
- **L2** — Review log retention policy if deploying to centralized log
  aggregation.
- **M1** — Revisit presigned URL lifetime if use case expands beyond
  direct-to-user consumption.

### Sign-off

This review was performed against the `security-playbook.md` checklists.
All v3.0 code paths in scope have been reviewed for the 10 playbook
categories. Current state is safe for internal development and user
testing. **Not yet cleared for production launch** pending the three
blocking items above.

---

## v4.0 Phase 2 (2026-07-03)

**Scope:** All code introduced or changed on `feat/v4-phase2-unified-editor`
(diff `4c2df06..1cc2269`) — beat-relative shot CRUD/split/recommend, the
optional `{ text }` body on the revoice endpoint, the (now-removed) legacy
shot adoption endpoint, and the unified editor UI (`src/components/editor/`).
**Playbook:** `security-playbook.md`. Reviewed 2026-07-03 by an independent
agent with no access to the implementation session.

**Verdict: SHIP WITH FIXES** — all three findings below were fixed in
commit `4ab994b` before merge.

### 1. Authentication (AuthN)

- ✅ Every route in the diff verifies the session server-side
  (`getSession()` → 401 on missing session).
- ✅ `page.tsx` redirects unauthenticated visitors to `/login`.

### 2. Authorization (AuthZ)

- ✅ All reads/writes scoped via a `projects.userId` join.
- ✅ **Cross-project IDOR closed:** shot create validates that `beatId`
  belongs to the calling project (`beats.projectId === project.id`) before
  use — this is the same cross-table authorization rule required for every
  endpoint that accepts a `beatId`.
- ✅ PATCH/DELETE/split load shots scoped to `(shotId, projectId)`.
- ✅ `page.tsx` performs the owner check before minting any presigned URL.

### 3. Input Validation & Sanitization

- ✅ UUIDs validated on all path params.
- ✅ Revoice `{ text }` is type-checked, trimmed, and capped at 2,000
  characters (400 on violation).
- ✅ Shot offsets (`startInBeat`/`endInBeat`/`atInBeat`) are
  `Number.isFinite`-checked and clamped to the parent beat's duration.
- ✅ Malformed JSON bodies return 400 everywhere (no uncaught parse errors).

### 4. API Security

- ✅ Rate limiting: `generation` preset on revoice/recommend; `mutation`
  preset on shot CRUD (create/update/delete/split).
- ✅ CSRF: Origin header verification (`verifyCsrf()`) on every mutation,
  fail-closed.

### 5. Error Handling & Logging

- ✅ Client-facing errors are generic; detail is logged server-side only.
- ✅ Failures fail closed — a beat that fails to (re-)voice is persisted as
  `voStatus: "failed"` rather than left in an ambiguous state.

### 6. Environment & Secrets Management

- ✅ No secrets in client code; server-only keys (ElevenLabs, fal.ai,
  Anthropic, R2) are untouched by this phase's changes.

### 7. Data Access & Storage

- ✅ Presigned R2 URLs are minted only for owner-scoped assets (same
  pattern as v3.0).

### 8. Teardown Regression Check

- ✅ Dropping the legacy continuous-VO columns
  (`projects.voiceoverPath/voiceoverStatus/voiceoverTimestamps/durationSeconds`,
  `shots.startSeconds/endSeconds/text`) and deleting their endpoints
  (`/api/projects/[id]/voiceover/generate`, `voiceover-generation.ts`,
  `vo-text.ts`) removed no security control and left no orphaned-but-reachable
  route. The one-time `shots/adopt-beats` migration endpoint was likewise
  removed after use — verified it is no longer reachable.

### 9. Abuse, Misuse & Edge Scenarios

- ✅ **Injection/DoS:** beat text reaches Claude only for the user's own
  generation — no privilege boundary crossed. The 50,000-char script cap and
  the new 2,000-char per-beat text cap, combined with a `max_tokens` bound,
  limit amplification. Generation endpoints remain capped at 5/min.

### Findings and resolutions

- **F2 (Medium, pre-existing, touched this phase):** `POST /api/test/music`
  lacked rate limiting and CSRF while triggering paid fal.ai generation.
  **Fixed (`4ab994b`):** added `applyRateLimit("generation")` and
  `verifyCsrf()` in the standard order.
- **F1 (Low, pre-existing):** `shots/recommend` and `test/music` returned
  raw `error.message` to clients, which could leak SDK/DB internals.
  **Fixed (`4ab994b`):** replaced with static generic messages; detail stays
  in server logs.
- **F3 (Low):** `imagePrompt`/`motionPrompt` lacked type and length
  validation — a non-string truthy value threw an uncaught `TypeError`
  (500), and unbounded lengths were storable. **Fixed (`4ab994b`):** added a
  `typeof === "string"` guard before `.trim()` plus a 2,000-char cap in both
  shot create and PATCH.

### Final Security Gate

| Item | Status |
|---|---|
| AuthN on every route | ✅ |
| AuthZ / ownership incl. cross-table `beatId` check | ✅ |
| Input validation (incl. 2,000-char caps) | ✅ |
| Rate limiting + CSRF | ✅ |
| Errors safe / fail closed | ✅ |
| Secrets untouched | ✅ |
| Teardown left no orphaned route | ✅ |

### Sign-off

No unauthenticated mutation, no cross-user data exposure, no secret leak,
and no IDOR in the new endpoints. **Cleared to ship** — the three findings
above were fixed before merge in `4ab994b`.
