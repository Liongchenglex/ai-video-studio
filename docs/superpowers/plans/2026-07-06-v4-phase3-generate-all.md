# v4.0 Phase 3 — Batch "Generate all" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One "Generate all" button that shows an itemized cost preview, then dispatches a durable Inngest batch: missing entity reference sheets first, then missing shot images (entity-conditioned), then — if opted in — missing clips, with per-item status live in both editor views.

**Architecture:** Extract the generation cores of the three existing per-item routes into shared `src/lib/` services (route + orchestrator call one implementation). A targeting module computes missing-only work server-side for preview, dispatch, and each wave. One Inngest function runs three sequential waves, 3 concurrent paid calls per wave, flipping the existing per-row status columns. The editor polls `GET /entities` + a new `GET /shots` while any row is `generating` and merges only generation fields into the store.

**Tech Stack:** Next.js 15 App Router, Drizzle + Postgres, Inngest v3 (already installed, serves at `/api/inngest`), fal.ai (FLUX Kontext images, LTX-2.3 clips), R2, shadcn/ui.

**Spec (source of truth):** `docs/superpowers/specs/2026-07-06-v4-phase3-generate-all-design.md`

## Global Constraints

- No unit-test harness in this repo. Verification per task = `npx tsc --noEmit` + `npm run lint`, plus curl / live checks where behavior must be observed (house convention from the v4 roadmap).
- Commit per task: `feat(v4-p3): …`. Every new file starts with a brief `/** … */` header comment describing what it does (CLAUDE.md).
- Every mutation route: `applyRateLimit` → `verifyCsrf` → `getSession` → UUID validation → ownership check, in that order, matching existing routes. Error shapes match existing helpers (`badRequestResponse`, etc.).
- No zod — manual body parse in try/catch like `POST /shots`.
- Missing-only targeting everywhere: statuses `pending` | `failed` are targets; `done` is never re-billed; `generating` is skipped.
- Functions < ~150 LOC; no dead code; readable > clever.
- Paid-call costs during verification: use a small throwaway project; never batch-run Project T until final verification (its run is cheap by definition — missing-only).

---

### Task 1: Cost estimate constants

**Files:**
- Create: `src/lib/generation-costs.ts`

**Interfaces:**
- Produces: `SHEET_EST_USD`, `IMAGE_EST_USD`, `CLIP_EST_USD` (numbers), `estimateBatchCost(counts: { sheets: number; images: number; clips: number })` → `{ sheetsUsd, imagesUsd, clipsUsd, totalUsd, totalWithClipsUsd }` — all numbers rounded to 2 dp.

- [ ] **Step 1: Write the module**

```ts
/**
 * Per-unit USD cost ESTIMATES for batch generation ("Generate all", v4 P3).
 * These are display-only ballparks for the cost-preview dialog — the UI must
 * label them as estimates. Derived from observed fal.ai pricing for FLUX
 * Kontext (sheets/images) and LTX-2.3 image-to-video (clips).
 */
export const SHEET_EST_USD = 0.04;
export const IMAGE_EST_USD = 0.04;
export const CLIP_EST_USD = 0.25;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateBatchCost(counts: {
  sheets: number;
  images: number;
  clips: number;
}) {
  const sheetsUsd = round2(counts.sheets * SHEET_EST_USD);
  const imagesUsd = round2(counts.images * IMAGE_EST_USD);
  const clipsUsd = round2(counts.clips * CLIP_EST_USD);
  return {
    sheetsUsd,
    imagesUsd,
    clipsUsd,
    totalUsd: round2(sheetsUsd + imagesUsd),
    totalWithClipsUsd: round2(sheetsUsd + imagesUsd + clipsUsd),
  };
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/generation-costs.ts
git commit -m "feat(v4-p3): cost estimate constants for Generate all preview"
```

---

### Task 2: Extract entity-sheet generation service; refactor reference route onto it

**Files:**
- Create: `src/lib/entity-sheet-generation.ts`
- Modify: `src/app/api/projects/[id]/entities/[entityId]/reference/route.ts`

**Interfaces:**
- Consumes: `generateImage` from `@/lib/image-generation`, `sheetPrompt` from `@/lib/reference-sheet`.
- Produces: `generateEntitySheet(project: Project, entity: Entity): Promise<Entity>` — owns the full status lifecycle (`generating` → `done`/`failed` on the row), returns the updated entity row, **throws** the underlying error after marking `failed`.

- [ ] **Step 1: Write the service** — this is the body currently inline in the route (`route.ts:60-97`), moved verbatim in behavior:

```ts
/**
 * Entity reference-sheet generation service (v4 P3 extraction).
 * Owns the full lifecycle for (re)generating one entity's multi-view
 * reference sheet: flips referenceStatus generating → done/failed, generates
 * via FLUX Kontext text-to-image with the type-specific sheet prompt + the
 * project's style string, stores at
 * projects/{projectId}/entities/{entityId}/sheet.png.
 * Called by POST /entities/[entityId]/reference AND the batch orchestrator —
 * one implementation, two callers. Throws after marking failed.
 */
import { db } from "@/lib/db";
import { entities, type Entity, type Project } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateImage } from "@/lib/image-generation";
import { sheetPrompt } from "@/lib/reference-sheet";

export async function generateEntitySheet(
  project: Project,
  entity: Entity,
): Promise<Entity> {
  await db
    .update(entities)
    .set({ referenceStatus: "generating" })
    .where(eq(entities.id, entity.id));

  try {
    const r2Key = `projects/${project.id}/entities/${entity.id}/sheet.png`;
    const result = await generateImage({
      r2Key,
      stillImagePrompt: sheetPrompt(entity),
      styleString: project.styleString,
    });

    const [updated] = await db
      .update(entities)
      .set({ referenceSheetPath: result.r2Key, referenceStatus: "done" })
      .where(eq(entities.id, entity.id))
      .returning();
    return updated;
  } catch (err) {
    await db
      .update(entities)
      .set({ referenceStatus: "failed" })
      .where(eq(entities.id, entity.id))
      .catch(() => {});
    throw err;
  }
}
```

- [ ] **Step 2: Refactor the route to call it.** In `reference/route.ts`, delete the inline `generating`-flip + try/catch generation block (lines 60-98) and replace with:

```ts
  try {
    const updated = await generateEntitySheet(project, entity);
    return NextResponse.json({
      ...updated,
      referenceSheetUrl: updated.referenceSheetPath
        ? await getDownloadUrl(updated.referenceSheetPath)
        : null,
    });
  } catch (err) {
    console.error(`Reference sheet generation failed for entity ${entityId}:`, err);
    return NextResponse.json(
      { error: "Reference sheet generation failed" },
      { status: 502 },
    );
  }
```

Remove now-unused imports from the route (`generateImage`, `sheetPrompt`, `eq` if unused); add `import { generateEntitySheet } from "@/lib/entity-sheet-generation";`. Keep the route's header comment, auth/CSRF/rate-limit, and `loadOwnedProjectAndEntity` untouched. External behavior (response shape, status codes) must be identical.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (Live sheet regeneration is re-verified in Task 10's end-to-end pass — don't spend a paid call here.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/entity-sheet-generation.ts "src/app/api/projects/[id]/entities/[entityId]/reference/route.ts"
git commit -m "feat(v4-p3): extract entity-sheet generation into shared service"
```

---

### Task 3: Extract shot-image generation service; refactor image route onto it

**Files:**
- Create: `src/lib/shot-image-generation.ts`
- Modify: `src/app/api/projects/[id]/shots/[shotId]/image/route.ts`

**Interfaces:**
- Produces: `generateShotImage(project: Project, shot: Shot): Promise<{ imagePath: string; imageUrl: string }>` — full status lifecycle on `shots.imageStatus`, primary-entity conditioning inside, throws after marking `failed`. Also exports `resolvePrimaryEntity(projectId: string, referencedEntityIds: string[] | null | undefined): Promise<Entity | null>` (moved from the route unchanged).

- [ ] **Step 1: Write the service.** Move `resolvePrimaryEntity` (route lines 41-65) and the generation block (lines 93-133) into the new module:

```ts
/**
 * Shot image generation service (v4 P3 extraction).
 * Owns the full lifecycle for (re)generating one shot's still image: flips
 * imageStatus generating → done/failed, resolves the shot's primary tagged
 * entity (first character with a done sheet, else first done sheet) and
 * conditions FLUX Kontext on its reference sheet, else falls back to
 * unconditioned. Stores at projects/{projectId}/shots/{shotId}/image.png.
 * Called by POST /shots/[shotId]/image AND the batch orchestrator.
 * Throws after marking failed. Caller must ensure imagePrompt is non-empty.
 */
import { db } from "@/lib/db";
import { shots, entities, type Entity, type Project, type Shot } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { generateImage } from "@/lib/image-generation";
import { getDownloadUrl } from "@/lib/r2";

export async function resolvePrimaryEntity(
  projectId: string,
  referencedEntityIds: string[] | null | undefined,
): Promise<Entity | null> {
  // ← paste the existing function body from image/route.ts:44-65 verbatim
}

export async function generateShotImage(
  project: Project,
  shot: Shot,
): Promise<{ imagePath: string; imageUrl: string }> {
  await db.update(shots).set({ imageStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    const primaryEntity = await resolvePrimaryEntity(project.id, shot.referencedEntityIds);
    const referenceImageUrl = primaryEntity?.referenceSheetPath
      ? await getDownloadUrl(primaryEntity.referenceSheetPath)
      : null;

    console.log(
      `[shot-image] project=${project.id} shot=${shot.id} | prompt: ${shot.imagePrompt.substring(0, 120)}... | ` +
        (primaryEntity
          ? `conditioned on entity=${primaryEntity.id} (${primaryEntity.name})`
          : "unconditioned"),
    );

    const r2Key = `projects/${project.id}/shots/${shot.id}/image.png`;
    const result = await generateImage({
      r2Key,
      stillImagePrompt: shot.imagePrompt,
      styleString: project.styleString,
      referenceImageUrl,
      referenceSubjectName: primaryEntity?.name ?? null,
    });

    await db
      .update(shots)
      .set({ imagePath: result.r2Key, imageStatus: "done" })
      .where(eq(shots.id, shot.id));

    console.log(`[shot-image] done: ${result.r2Key}`);
    return { imagePath: result.r2Key, imageUrl: result.downloadUrl };
  } catch (error) {
    await db.update(shots).set({ imageStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 2: Refactor the route.** The route keeps: rate-limit/CSRF/session/UUID checks, the ownership join returning `{ shot, project }`, and the `imagePrompt?.trim()` 400 guard. Then:

```ts
  try {
    const result = await generateShotImage(project, shot);
    return NextResponse.json({
      imagePath: result.imagePath,
      imageUrl: result.imageUrl,
      imageStatus: "done",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/image] failed:`, msg);
    return NextResponse.json({ error: msg, imageStatus: "failed" }, { status: 500 });
  }
```

Delete the route's local `resolvePrimaryEntity` and the inline generation block; drop unused imports (`generateImage`, `getDownloadUrl`, `inArray`, `type Entity`, `entities`).

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shot-image-generation.ts "src/app/api/projects/[id]/shots/[shotId]/image/route.ts"
git commit -m "feat(v4-p3): extract shot-image generation into shared service"
```

---

### Task 4: Extract shot-clip generation service; refactor clip route onto it

**Files:**
- Create: `src/lib/shot-clip-generation.ts`
- Modify: `src/app/api/projects/[id]/shots/[shotId]/clip/route.ts`

**Interfaces:**
- Produces: `generateShotClip(project: Project, shot: Shot): Promise<{ clipPath: string; clipUrl: string; clipDurationSeconds: number }>` — full lifecycle on `shots.clipStatus`, LTX-2.3 provider, throws after marking `failed`. Caller must ensure `shot.imagePath` is set.

- [ ] **Step 1: Write the service.** Move `uploadImageToFal` (route lines 31-64), the `fal.config` call, and the generation block (lines 92-158) into the module:

```ts
/**
 * Shot clip generation service (v4 P3 extraction). LTX-2.3 image-to-video
 * via fal.ai: uploads the shot's still image to fal storage (fal can't
 * always read R2 presigned URLs), generates a ~6s clip from the motion
 * prompt, stores at projects/{projectId}/shots/{shotId}/clip.mp4. Owns the
 * clipStatus generating → done/failed lifecycle; throws after marking
 * failed. Caller must ensure shot.imagePath is set. Called by
 * POST /shots/[shotId]/clip AND the batch orchestrator (Hailuo A/B route
 * stays separate — batch always uses the default LTX provider).
 */
import { db } from "@/lib/db";
import { shots, type Project, type Shot } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

async function uploadImageToFal(r2Key: string): Promise<string> {
  // ← paste the existing function body from clip/route.ts:32-63 verbatim
}

export async function generateShotClip(
  project: Project,
  shot: Shot,
): Promise<{ clipPath: string; clipUrl: string; clipDurationSeconds: number }> {
  await db.update(shots).set({ clipStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    console.log(
      `[shot-clip] project=${project.id} shot=${shot.id} | motion: ${shot.motionPrompt.substring(0, 120)}...`,
    );

    const falImageUrl = await uploadImageToFal(shot.imagePath!);
    const result = await fal.subscribe("fal-ai/ltx-2.3/image-to-video", {
      input: { image_url: falImageUrl, prompt: shot.motionPrompt },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log(`[shot-clip] ${msg}`));
        }
      },
    });

    const output = result.data as { video?: { url: string; duration?: number } };
    if (!output.video?.url) throw new Error("LTX-2.3 returned no video");
    const clipDuration = output.video.duration ?? 6;

    const videoRes = await fetch(output.video.url);
    if (!videoRes.ok) throw new Error("Failed to download generated clip");
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

    const r2Key = `projects/${project.id}/shots/${shot.id}/clip.mp4`;
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: r2Key,
        Body: videoBuffer,
        ContentType: "video/mp4",
      }),
    );

    await db
      .update(shots)
      .set({ clipPath: r2Key, clipStatus: "done", clipDurationSeconds: Math.round(clipDuration) })
      .where(eq(shots.id, shot.id));

    console.log(`[shot-clip] done: ${r2Key} (${clipDuration}s)`);
    return {
      clipPath: r2Key,
      clipUrl: await getDownloadUrl(r2Key),
      clipDurationSeconds: Math.round(clipDuration),
    };
  } catch (error) {
    await db.update(shots).set({ clipStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 2: Refactor the route.** Route keeps guards + ownership join + the `!shot.imagePath` 400 guard, then:

```ts
  try {
    const result = await generateShotClip(project, shot);
    return NextResponse.json({ ...result, clipStatus: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/clip] failed:`, msg);
    return NextResponse.json({ error: msg, clipStatus: "failed" }, { status: 500 });
  }
```

Delete moved code + unused imports (`fal`, S3 commands, `r2Client`, `getDownloadUrl`). Note the response previously included `clipPath`, `clipUrl`, `clipStatus`, `clipDurationSeconds` — the spread above preserves exactly that shape.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shot-clip-generation.ts "src/app/api/projects/[id]/shots/[shotId]/clip/route.ts"
git commit -m "feat(v4-p3): extract shot-clip generation into shared service"
```

---

### Task 5: Batch targeting module + cost-preview endpoint

**Files:**
- Create: `src/lib/batch-targeting.ts`
- Create: `src/app/api/projects/[id]/generate-all/preview/route.ts`

**Interfaces:**
- Produces: `computeBatchTargets(projectId: string): Promise<BatchTargets>` where

```ts
export interface BatchTargets {
  /** Tagged-in-≥1-shot entities with referenceStatus pending|failed. */
  sheetEntityIds: string[];
  /** Shots with imageStatus pending|failed and a non-empty imagePrompt. */
  imageShotIds: string[];
  /** Shots with clipStatus pending|failed and a non-empty motionPrompt.
   *  Image readiness is NOT checked here (wave 2 may fill it) — the
   *  orchestrator re-checks imagePath/imageStatus at wave-3 time. */
  clipShotIds: string[];
  /** True if any entity sheet or shot image/clip is currently generating. */
  anyGenerating: boolean;
}
```

- Consumes (Task 1): `estimateBatchCost`.

- [ ] **Step 1: Write `src/lib/batch-targeting.ts`**

```ts
/**
 * Missing-only targeting for batch "Generate all" (v4 P3). One computation
 * used by the preview endpoint, the dispatch endpoint, and the Inngest
 * orchestrator, so the three can never disagree about what a batch covers.
 * Missing = status pending|failed. done is never re-billed; generating is
 * skipped (in-flight).
 */
import { db } from "@/lib/db";
import { entities, shots } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface BatchTargets {
  sheetEntityIds: string[];
  imageShotIds: string[];
  clipShotIds: string[];
  anyGenerating: boolean;
}

export async function computeBatchTargets(projectId: string): Promise<BatchTargets> {
  const entityRows = await db
    .select({ id: entities.id, referenceStatus: entities.referenceStatus })
    .from(entities)
    .where(eq(entities.projectId, projectId));
  const shotRows = await db
    .select({
      id: shots.id,
      imageStatus: shots.imageStatus,
      clipStatus: shots.clipStatus,
      imagePrompt: shots.imagePrompt,
      motionPrompt: shots.motionPrompt,
      referencedEntityIds: shots.referencedEntityIds,
    })
    .from(shots)
    .where(eq(shots.projectId, projectId));

  const taggedEntityIds = new Set<string>();
  for (const s of shotRows) for (const eid of s.referencedEntityIds ?? []) taggedEntityIds.add(eid);

  const missing = (status: string | null) => status === "pending" || status === "failed";

  return {
    sheetEntityIds: entityRows
      .filter((e) => taggedEntityIds.has(e.id) && missing(e.referenceStatus))
      .map((e) => e.id),
    imageShotIds: shotRows
      .filter((s) => missing(s.imageStatus) && s.imagePrompt.trim().length > 0)
      .map((s) => s.id),
    clipShotIds: shotRows
      .filter((s) => missing(s.clipStatus) && s.motionPrompt.trim().length > 0)
      .map((s) => s.id),
    anyGenerating:
      entityRows.some((e) => e.referenceStatus === "generating") ||
      shotRows.some((s) => s.imageStatus === "generating" || s.clipStatus === "generating"),
  };
}
```

- [ ] **Step 2: Write the preview route** (`generate-all/preview/route.ts`)

```ts
/**
 * GET /api/projects/[id]/generate-all/preview
 * Itemized cost preview for the batch "Generate all" confirm dialog (v4 P3).
 * Counts missing-only work (sheets for tagged entities, shot images, shot
 * clips) server-side and multiplies by the per-unit USD estimates. Display
 * only — the dispatch endpoint recomputes targeting itself and never trusts
 * these numbers.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
} from "@/lib/api-utils";
import { computeBatchTargets } from "@/lib/batch-targeting";
import { estimateBatchCost } from "@/lib/generation-costs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  if (!isValidUUID(id)) return badRequestResponse("Invalid project ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project || project.deletedAt) return notFoundResponse();

  const targets = await computeBatchTargets(id);
  const cost = estimateBatchCost({
    sheets: targets.sheetEntityIds.length,
    images: targets.imageShotIds.length,
    clips: targets.clipShotIds.length,
  });

  return NextResponse.json({
    sheets: { count: targets.sheetEntityIds.length, estUsd: cost.sheetsUsd },
    images: { count: targets.imageShotIds.length, estUsd: cost.imagesUsd },
    clips: { count: targets.clipShotIds.length, estUsd: cost.clipsUsd },
    totalUsd: cost.totalUsd,
    totalWithClipsUsd: cost.totalWithClipsUsd,
    batchRunning: targets.anyGenerating,
  });
}
```

- [ ] **Step 3: Verify with types + a live curl.** Run `npx tsc --noEmit && npm run lint`. Then with `npm run dev` running and a logged-in browser session, verify in the browser devtools console on the project page:

```js
await (await fetch(`/api/projects/<PROJECT_ID>/generate-all/preview`)).json()
```

Expected: JSON with the counts matching a psql check, e.g. `SELECT count(*) FROM shots WHERE project_id='<PROJECT_ID>' AND image_status IN ('pending','failed') AND btrim(image_prompt) <> '';`. Also verify an unauthenticated `curl http://localhost:3000/api/projects/<PROJECT_ID>/generate-all/preview` returns 401.

- [ ] **Step 4: Commit**

```bash
git add src/lib/batch-targeting.ts "src/app/api/projects/[id]/generate-all/preview/route.ts"
git commit -m "feat(v4-p3): batch targeting module + cost-preview endpoint"
```

---

### Task 6: Inngest batch orchestrator + dispatch endpoint

**Files:**
- Create: `src/inngest/functions/generate-batch.ts`
- Modify: `src/inngest/index.ts`
- Create: `src/app/api/projects/[id]/generate-all/route.ts`

**Interfaces:**
- Consumes: `computeBatchTargets` (Task 5), `generateEntitySheet` (Task 2), `generateShotImage` (Task 3), `generateShotClip` (Task 4).
- Produces: Inngest event `project/batch.generate` with `data: { projectId: string, includeClips: boolean }`; `POST /generate-all` body `{ includeClips: boolean }` → `202 { dispatched: true, sheets, images, clips }` | `200 { dispatched: false, reason: "nothing-to-do" }` | `409 { error: "A batch is already running" }`.

- [ ] **Step 1: Write the orchestrator** (`src/inngest/functions/generate-batch.ts`)

```ts
/**
 * Inngest function: batch "Generate all" orchestrator (v4 P3).
 * Three sequential waves over missing-only targets — 1) reference sheets for
 * tagged entities, 2) shot images (entity-conditioned via the shared
 * service), 3) clips (only when includeClips, only for shots whose image is
 * done). Each item is one step that flips the row's own status column; a
 * failed item marks its row `failed` and NEVER halts the batch (re-running
 * Generate all is the retry). Paid work runs in chunks of 3 to bound
 * concurrent fal.ai calls. Per-project concurrency 1 makes double-dispatch
 * harmless.
 */
import { inngest } from "../client";
import { db } from "@/lib/db";
import { projects, entities, shots } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { computeBatchTargets } from "@/lib/batch-targeting";
import { generateEntitySheet } from "@/lib/entity-sheet-generation";
import { generateShotImage } from "@/lib/shot-image-generation";
import { generateShotClip } from "@/lib/shot-clip-generation";

const CHUNK_SIZE = 3;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const generateBatchFn = inngest.createFunction(
  {
    id: "generate-batch",
    retries: 1,
    concurrency: [{ scope: "fn", key: "event.data.projectId", limit: 1 }],
  },
  { event: "project/batch.generate" },
  async ({ event, step }) => {
    const { projectId, includeClips } = event.data as {
      projectId: string;
      includeClips: boolean;
    };

    // Re-verify the project exists before spending money.
    const projectExists = await step.run("verify-project", async () => {
      const [p] = await db
        .select({ id: projects.id, deletedAt: projects.deletedAt })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      return !!p && !p.deletedAt;
    });
    if (!projectExists) return { skipped: "project-missing" };

    const targets = await step.run("compute-targets", () => computeBatchTargets(projectId));

    // ── Wave 1: reference sheets ──
    let sheetsFailed = 0;
    for (const chunk of chunked(targets.sheetEntityIds, CHUNK_SIZE)) {
      const results = await Promise.all(
        chunk.map((entityId) =>
          step.run(`sheet-${entityId}`, async () => {
            const [row] = await db
              .select({ entity: entities, project: projects })
              .from(entities)
              .innerJoin(projects, eq(entities.projectId, projects.id))
              .where(and(eq(entities.id, entityId), eq(projects.id, projectId)))
              .limit(1);
            if (!row) return { ok: false };
            try {
              await generateEntitySheet(row.project, row.entity);
              return { ok: true };
            } catch (err) {
              console.error(`[batch] sheet failed entity=${entityId}:`, err);
              return { ok: false }; // row already marked failed by the service
            }
          }),
        ),
      );
      sheetsFailed += results.filter((r) => !r.ok).length;
    }

    // ── Wave 2: shot images (sheets from wave 1 now condition them) ──
    let imagesFailed = 0;
    for (const chunk of chunked(targets.imageShotIds, CHUNK_SIZE)) {
      const results = await Promise.all(
        chunk.map((shotId) =>
          step.run(`image-${shotId}`, async () => {
            const [row] = await db
              .select({ shot: shots, project: projects })
              .from(shots)
              .innerJoin(projects, eq(shots.projectId, projects.id))
              .where(and(eq(shots.id, shotId), eq(projects.id, projectId)))
              .limit(1);
            if (!row) return { ok: false };
            try {
              await generateShotImage(row.project, row.shot);
              return { ok: true };
            } catch (err) {
              console.error(`[batch] image failed shot=${shotId}:`, err);
              return { ok: false };
            }
          }),
        ),
      );
      imagesFailed += results.filter((r) => !r.ok).length;
    }

    // ── Wave 3: clips — re-check image readiness AFTER wave 2 ──
    let clipsFailed = 0;
    let clipsRun = 0;
    if (includeClips) {
      const readyClipShotIds = await step.run("compute-clip-targets", async () => {
        const rows = await db
          .select({ id: shots.id, imageStatus: shots.imageStatus, imagePath: shots.imagePath })
          .from(shots)
          .where(eq(shots.projectId, projectId));
        const wanted = new Set(targets.clipShotIds);
        return rows
          .filter((s) => wanted.has(s.id) && s.imageStatus === "done" && s.imagePath)
          .map((s) => s.id);
      });
      clipsRun = readyClipShotIds.length;

      for (const chunk of chunked(readyClipShotIds, CHUNK_SIZE)) {
        const results = await Promise.all(
          chunk.map((shotId) =>
            step.run(`clip-${shotId}`, async () => {
              const [row] = await db
                .select({ shot: shots, project: projects })
                .from(shots)
                .innerJoin(projects, eq(shots.projectId, projects.id))
                .where(and(eq(shots.id, shotId), eq(projects.id, projectId)))
                .limit(1);
              if (!row) return { ok: false };
              try {
                await generateShotClip(row.project, row.shot);
                return { ok: true };
              } catch (err) {
                console.error(`[batch] clip failed shot=${shotId}:`, err);
                return { ok: false };
              }
            }),
          ),
        );
        clipsFailed += results.filter((r) => !r.ok).length;
      }
    }

    return {
      projectId,
      sheets: { total: targets.sheetEntityIds.length, failed: sheetsFailed },
      images: { total: targets.imageShotIds.length, failed: imagesFailed },
      clips: { total: clipsRun, failed: clipsFailed },
    };
  },
);
```

- [ ] **Step 2: Register it.** In `src/inngest/index.ts` add `import { generateBatchFn } from "./functions/generate-batch";` and append `generateBatchFn` to the `functions` array. Update the file's header comment to mention batch generation.

- [ ] **Step 3: Write the dispatch route** (`src/app/api/projects/[id]/generate-all/route.ts`)

```ts
/**
 * POST /api/projects/[id]/generate-all
 * Dispatches the batch "Generate all" run (v4 P3): recomputes missing-only
 * targets server-side (never trusts client counts), refuses while a batch is
 * already running (409), then emits one `project/batch.generate` Inngest
 * event — the orchestrator does all paid work in the background. Body:
 * { includeClips: boolean }.
 * Known small race: between this 202 and the orchestrator's first step no
 * row is `generating` yet, so a second POST in that window double-dispatches
 * — harmless, because the function has per-project concurrency 1 and
 * recomputes missing-only targets when it starts.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { computeBatchTargets } from "@/lib/batch-targeting";
import { inngest } from "@/inngest";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  if (!isValidUUID(id)) return badRequestResponse("Invalid project ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project || project.deletedAt) return notFoundResponse();

  let includeClips = false;
  try {
    const body = (await request.json()) as { includeClips?: unknown };
    if (typeof body.includeClips !== "boolean") {
      return badRequestResponse("includeClips must be a boolean");
    }
    includeClips = body.includeClips;
  } catch {
    return badRequestResponse("Invalid request body");
  }

  const targets = await computeBatchTargets(id);
  if (targets.anyGenerating) {
    return NextResponse.json({ error: "A batch is already running" }, { status: 409 });
  }

  const sheets = targets.sheetEntityIds.length;
  const images = targets.imageShotIds.length;
  const clips = includeClips ? targets.clipShotIds.length : 0;
  if (sheets + images + clips === 0) {
    return NextResponse.json({ dispatched: false, reason: "nothing-to-do" });
  }

  await inngest.send({
    name: "project/batch.generate",
    data: { projectId: id, includeClips },
  });

  console.log(
    `[generate-all] dispatched project=${id} sheets=${sheets} images=${images} clips=${clips}`,
  );
  return NextResponse.json({ dispatched: true, sheets, images, clips }, { status: 202 });
}
```

- [ ] **Step 4: Verify types + a dry live check.** `npx tsc --noEmit && npm run lint`. Then start `npm run dev` AND `npx inngest-cli dev` (Inngest dev UI at http://localhost:8288); confirm the `generate-batch` function appears in the Inngest dev UI's function list. **Do not dispatch a real batch yet** — full live verification happens in Task 10 on a throwaway project. Verify the 409/nothing-to-do paths cheaply from the browser console on a project whose assets are all `done`:

```js
await (await fetch(`/api/projects/<DONE_PROJECT_ID>/generate-all`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ includeClips: false }),
})).json()  // expect { dispatched: false, reason: "nothing-to-do" }
```

- [ ] **Step 5: Commit**

```bash
git add src/inngest/functions/generate-batch.ts src/inngest/index.ts "src/app/api/projects/[id]/generate-all/route.ts"
git commit -m "feat(v4-p3): Inngest batch orchestrator + generate-all dispatch endpoint"
```

---

### Task 7: `GET /shots` list endpoint (polling read-back)

**Files:**
- Modify: `src/app/api/projects/[id]/shots/route.ts` (add a `GET` handler beside the existing `POST`)

**Interfaces:**
- Produces: `GET /api/projects/[id]/shots` → `{ shots: EditorShotShaped[] }` — exactly the mapping `src/app/projects/[id]/page.tsx:57-75` uses (beat-relative offsets, presigned `imageUrl`/`clipUrl`, `referencedEntityIds ?? []`), ordered by `sortOrder`. The store's polling (Task 8) consumes this.

- [ ] **Step 1: Add the GET handler** to the existing route file (extend the header comment to mention it):

```ts
export async function GET(_request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  if (!isValidUUID(id)) return badRequestResponse("Invalid project ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project || project.deletedAt) return notFoundResponse();

  const rows = await db
    .select()
    .from(shots)
    .where(eq(shots.projectId, id))
    .orderBy(asc(shots.sortOrder));

  const list = await Promise.all(
    rows.map(async (shot) => ({
      id: shot.id,
      beatId: shot.beatId,
      sortOrder: shot.sortOrder,
      startInBeat: shot.startInBeat,
      endInBeat: shot.endInBeat,
      imagePrompt: shot.imagePrompt,
      motionPrompt: shot.motionPrompt,
      imagePath: shot.imagePath,
      imageStatus: shot.imageStatus ?? "pending",
      imageUrl: shot.imagePath ? await getDownloadUrl(shot.imagePath) : null,
      clipPath: shot.clipPath,
      clipStatus: shot.clipStatus ?? "pending",
      clipUrl: shot.clipPath ? await getDownloadUrl(shot.clipPath) : null,
      clipDurationSeconds: shot.clipDurationSeconds,
      referencedEntityIds: shot.referencedEntityIds ?? [],
    })),
  );

  return NextResponse.json({ shots: list });
}
```

Add `getDownloadUrl` to the route's imports (`@/lib/r2`).

- [ ] **Step 2: Verify.** `npx tsc --noEmit && npm run lint`; then from the logged-in browser console: `await (await fetch('/api/projects/<PROJECT_ID>/shots')).json()` — expect `{ shots: [...] }` with statuses and presigned URLs; unauthenticated curl → 401.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/projects/[id]/shots/route.ts"
git commit -m "feat(v4-p3): GET /shots list endpoint for batch polling"
```

---

### Task 8: Editor store — preview fetch, dispatch, batch polling

**Files:**
- Modify: `src/components/editor/editor-store.tsx`

**Interfaces:**
- Consumes: `GET .../generate-all/preview` (Task 5), `POST .../generate-all` (Task 6), `GET .../shots` (Task 7), existing `GET .../entities`.
- Produces (added to `EditorContextValue`):

```ts
export interface GenerateAllPreview {
  sheets: { count: number; estUsd: number };
  images: { count: number; estUsd: number };
  clips: { count: number; estUsd: number };
  totalUsd: number;
  totalWithClipsUsd: number;
  batchRunning: boolean;
}
// context additions:
fetchGenerateAllPreview(): Promise<GenerateAllPreview | null>;
generateAll(includeClips: boolean): Promise<boolean>; // true = dispatched
batchActive: boolean; // any row generating, or dispatch grace window
```

- [ ] **Step 1: Add `GenerateAllPreview` + the two callbacks.** Inside `EditorProvider`, alongside the existing callbacks:

```ts
  // ── Batch "Generate all" (v4 P3) ──
  // dispatchedAtRef opens a grace window between POST and the orchestrator's
  // first status flip, so batchActive doesn't flicker false before wave 1.
  const dispatchedAtRef = useRef<number | null>(null);
  const [dispatchTick, setDispatchTick] = useState(0);

  const fetchGenerateAllPreview =
    useCallback(async (): Promise<GenerateAllPreview | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/generate-all/preview`);
        if (!res.ok) return null;
        return (await res.json()) as GenerateAllPreview;
      } catch (err) {
        console.error("[editor-store] preview fetch error:", err);
        return null;
      }
    }, [projectId]);

  const generateAll = useCallback(
    async (includeClips: boolean): Promise<boolean> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/generate-all`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ includeClips }),
        });
        if (!res.ok) {
          console.warn("[editor-store] generate-all dispatch failed:", await res.text());
          return false;
        }
        const data = (await res.json()) as { dispatched: boolean };
        if (data.dispatched) {
          dispatchedAtRef.current = Date.now();
          setDispatchTick((t) => t + 1); // re-derive batchActive immediately
        }
        return data.dispatched;
      } catch (err) {
        console.error("[editor-store] generate-all error:", err);
        return false;
      }
    },
    [projectId],
  );
```

- [ ] **Step 2: Derive `batchActive` and add the polling effect.** Still inside `EditorProvider`:

```ts
  const anyRowGenerating = useMemo(
    () =>
      state.entities.some((e) => e.referenceStatus === "generating") ||
      state.shots.some(
        (s) => s.imageStatus === "generating" || s.clipStatus === "generating",
      ),
    [state.entities, state.shots],
  );
  // 60s grace after dispatch covers the Inngest pickup delay; dispatchTick
  // makes the memo re-evaluate right after a dispatch.
  const batchActive = useMemo(() => {
    void dispatchTick;
    const inGrace =
      dispatchedAtRef.current !== null && Date.now() - dispatchedAtRef.current < 60_000;
    return anyRowGenerating || inGrace;
  }, [anyRowGenerating, dispatchTick]);

  // Poll while a batch is live (covers on-load detection too: rows already
  // `generating` at mount start the loop). Merges ONLY generation fields so
  // in-flight local edits (prompts, offsets, tags) are never clobbered.
  useEffect(() => {
    if (!batchActive) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const [shotsRes, entitiesRes] = await Promise.all([
          fetch(`/api/projects/${projectId}/shots`),
          fetch(`/api/projects/${projectId}/entities`),
        ]);
        if (cancelled || !shotsRes.ok || !entitiesRes.ok) return;
        const { shots: freshShots } = (await shotsRes.json()) as { shots: EditorShot[] };
        const { entities: freshEntities } = (await entitiesRes.json()) as {
          entities: EditorEntity[];
        };
        if (cancelled) return;

        for (const f of freshShots) {
          dispatch({
            type: "patchShot",
            shotId: f.id,
            patch: {
              imageStatus: f.imageStatus,
              imagePath: f.imagePath,
              imageUrl: f.imageUrl,
              clipStatus: f.clipStatus,
              clipPath: f.clipPath,
              clipUrl: f.clipUrl,
              clipDurationSeconds: f.clipDurationSeconds,
            },
          });
        }
        for (const f of freshEntities) {
          dispatch({
            type: "patchEntity",
            entityId: f.id,
            patch: {
              referenceStatus: f.referenceStatus,
              referenceSheetUrl: f.referenceSheetUrl,
            },
          });
        }
        // Once real work is visibly running, the grace window has served
        // its purpose — let row statuses drive batchActive from here on.
        const running =
          freshEntities.some((e) => e.referenceStatus === "generating") ||
          freshShots.some(
            (s) => s.imageStatus === "generating" || s.clipStatus === "generating",
          );
        if (running) dispatchedAtRef.current = null;
      } catch (err) {
        console.error("[editor-store] batch poll error:", err);
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [batchActive, projectId]);
```

(`GET /entities` returns `{ entities: [...] }` with `referenceSheetUrl` and `shotCount` per row — see `entities/route.ts:74`.)

- [ ] **Step 3: Expose in context.** Add `fetchGenerateAllPreview`, `generateAll`, `batchActive` to `EditorContextValue` (interface at `editor-store.tsx:182`) and to the provider's `value` object. Export `GenerateAllPreview`.

- [ ] **Step 4: Verify.** `npx tsc --noEmit && npm run lint`. Live check comes with the UI in Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/editor-store.tsx
git commit -m "feat(v4-p3): store batch dispatch, preview fetch, live polling"
```

---

### Task 9: UI — cost-preview dialog + "Generate all" button

**Files:**
- Create: `src/components/ui/dialog.tsx` (via shadcn CLI)
- Create: `src/components/editor/generate-all-dialog.tsx`
- Modify: `src/components/editor/unified-editor.tsx` (TopBar, `unified-editor.tsx:583-674`)

**Interfaces:**
- Consumes: `useEditor().fetchGenerateAllPreview / generateAll / batchActive / shots / entities` (Task 8).
- Produces: `<GenerateAllDialog open onOpenChange />` and a TopBar button.

- [ ] **Step 1: Add the shadcn dialog primitive**

Run: `npx shadcn@latest add dialog --yes`
Expected: creates `src/components/ui/dialog.tsx` (and installs `@radix-ui/react-dialog` if missing). Commit will include `package.json`/lockfile changes if any.

- [ ] **Step 2: Write `generate-all-dialog.tsx`**

```tsx
/**
 * Cost-preview + confirm dialog for batch "Generate all" (v4 P3, mockup:
 * spec §6). Fetches the itemized server-side preview on open, offers an
 * "Also generate clips" checkbox (itemized separately — clips are the
 * expensive line), and dispatches the batch on confirm. All numbers are
 * estimates and labeled as such; the server recomputes everything.
 */
"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEditor, type GenerateAllPreview } from "@/components/editor/editor-store";

export function GenerateAllDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { fetchGenerateAllPreview, generateAll } = useEditor();
  const [preview, setPreview] = useState<GenerateAllPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [includeClips, setIncludeClips] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(false);
    setIncludeClips(false);
    setLoading(true);
    fetchGenerateAllPreview()
      .then((p) => {
        setPreview(p);
        if (!p) setError(true);
      })
      .finally(() => setLoading(false));
  }, [open, fetchGenerateAllPreview]);

  const nothingToDo =
    preview !== null &&
    preview.sheets.count === 0 &&
    preview.images.count === 0 &&
    (!includeClips || preview.clips.count === 0);

  const handleConfirm = async () => {
    setDispatching(true);
    setError(false);
    const ok = await generateAll(includeClips);
    setDispatching(false);
    if (ok) onOpenChange(false);
    else setError(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate all missing assets</DialogTitle>
          <DialogDescription>
            Reference sheets generate first so every tagged shot comes out
            on-model. Shots that are already done are skipped — nothing is
            re-billed.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Counting what&rsquo;s missing…
          </div>
        )}

        {preview && (
          <div className="space-y-2 text-sm">
            {preview.batchRunning && (
              <p className="rounded bg-amber-500/10 p-2 text-amber-600">
                A batch is already running — wait for it to finish.
              </p>
            )}
            <div className="flex justify-between">
              <span>{preview.sheets.count} reference sheets</span>
              <span className="font-mono">~${preview.sheets.estUsd.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span>{preview.images.count} shot images</span>
              <span className="font-mono">~${preview.images.estUsd.toFixed(2)}</span>
            </div>
            <label className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeClips}
                  onChange={(e) => setIncludeClips(e.target.checked)}
                  disabled={preview.clips.count === 0}
                />
                Also generate {preview.clips.count} clips
              </span>
              <span className="font-mono">
                {includeClips ? `~$${preview.clips.estUsd.toFixed(2)}` : "—"}
              </span>
            </label>
            <div className="flex justify-between border-t pt-2 font-medium">
              <span>Total (estimate)</span>
              <span className="font-mono">
                ~${(includeClips ? preview.totalWithClipsUsd : preview.totalUsd).toFixed(2)}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Estimates only — actual provider billing may differ slightly.
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">
            Something went wrong. Close and try again.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={dispatching}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || !preview || preview.batchRunning || nothingToDo || dispatching}
          >
            {dispatching ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3.5 w-3.5" />
            )}
            {nothingToDo ? "Nothing to generate" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Wire the TopBar.** In `EditorShell` (`unified-editor.tsx:421`), pull `batchActive`, `shots`, `entities` from `useEditor()`, add `const [generateAllOpen, setGenerateAllOpen] = useState(false);`, compute the remaining count, and render `<GenerateAllDialog open={generateAllOpen} onOpenChange={setGenerateAllOpen} />` next to `<TopBar …/>`. Extend `TopBar`'s props with `batchActive: boolean; batchRemaining: number; onGenerateAll(): void;` and add the button inside the existing `ml-auto` group, BEFORE the Recommend button:

```tsx
        <Button size="sm" onClick={onGenerateAll} disabled={batchActive}>
          {batchActive ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              Generating… {batchRemaining} left
            </>
          ) : (
            <>
              <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate all
            </>
          )}
        </Button>
```

In `EditorShell`:

```tsx
  const batchRemaining = useMemo(
    () =>
      entities.filter((e) => e.referenceStatus === "generating").length +
      shots.filter(
        (s) =>
          s.imageStatus === "generating" ||
          s.imageStatus === "pending" ||
          s.clipStatus === "generating",
      ).length,
    [entities, shots],
  );
```

(Pending images count as remaining because the running batch will reach them; pending clips don't — clips may not have been opted in.)

- [ ] **Step 4: Verify live (no paid calls).** With `npm run dev` running, open a project: button renders; click → dialog shows itemized counts matching the preview endpoint; on an all-done project the confirm button reads "Nothing to generate" and is disabled. `npx tsc --noEmit && npm run lint` pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/dialog.tsx src/components/editor/generate-all-dialog.tsx src/components/editor/unified-editor.tsx package.json package-lock.json
git commit -m "feat(v4-p3): Generate all button + cost-preview confirm dialog"
```

---

### Task 10: End-to-end live verification + feature docs

**Files:**
- Create: `docs/feature17/feature.md` (follows `feature-playbook.md`)
- Create: `docs/feature17/testcase.md`
- Modify: `docs/superpowers/plans/2026-06-13-v4-unified-editor-roadmap.md` (mark Phase 3 shipped, link plan + docs)

**Interfaces:**
- Consumes: everything above, running end-to-end.

- [ ] **Step 1: Live end-to-end on a THROWAWAY project** (cost-conscious: 2–3 short beats, 2–3 shots, 1 tagged entity with a pending sheet). Run `npm run dev` + `npx inngest-cli dev`. Then:
  1. Click Generate all → dialog itemizes 1 sheet + N images; confirm with clips OFF.
  2. Watch: entity flips to generating→done FIRST (Reference Bible rail), then shots fill in, in both Timeline and Storyboard views, without a page refresh.
  3. Check the Inngest dev UI run: wave order sheet → images; verify in the server log that the tagged shot logged `conditioned on entity=…`.
  4. Close the tab mid-run, reopen → progress resumes rendering (on-load detection).
  5. Re-run Generate all → "Nothing to generate" (idempotence).
  6. Failure path: via psql, set `image_status='failed'` on ONE done shot, re-run Generate all → the dialog counts exactly 1 image and only that shot regenerates. Restore any test data changes afterwards.
  7. Minimal clips-on run: ONE shot with clip pending → confirm with clips ON → clip generates after image wave.
- [ ] **Step 2: Sanity pass on Project T** — open the dialog, verify counts look right (missing-only), dispatch only if the user's data actually has gaps worth filling (ask the user first — it's their money).
- [ ] **Step 3: Write `docs/feature17/feature.md`** per `feature-playbook.md` (what/why/how, architecture, endpoints, data flow, security notes) and `docs/feature17/testcase.md` with acceptance criteria, expected outcomes, and edge cases — at minimum: missing-only targeting, sheets-first ordering, failed-sheet fallback to unconditioned, 409 double-dispatch, nothing-to-do, unauthorized 401s on all three new endpoints, CSRF rejection on POST, poll-merge preserves concurrent local edits, on-load resume, clip wave skips image-failed shots.
- [ ] **Step 4: Update the roadmap table** — Phase 3 row: plan file link + shipped date.
- [ ] **Step 5: Commit**

```bash
git add docs/feature17 docs/superpowers/plans/2026-06-13-v4-unified-editor-roadmap.md
git commit -m "docs(v4-p3): feature + testcase docs, roadmap update"
```

---

## Post-implementation (execution workflow, not plan tasks)

Per the established phase workflow: independent security review against `security-playbook.md` (findings are release blockers), final whole-branch review with minors triaged to `docs/backlog.md`, then ask the user once → `git merge --no-ff` to master + push + delete branch. Work happens on a feature branch (e.g. `feat/v4-phase3-generate-all`).
