# Clip Engine v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-model clip generation (registry + dropdown, Kling 2.5 Turbo Pro default), first/last-frame chained clips, and decoupled MMAudio SFX — per the approved spec `docs/superpowers/specs/2026-07-08-clip-engine-v2-design.md`.

**Architecture:** A pure model registry (`clip-models.ts`) drives a model-agnostic generation service, the clip route, the inspector dropdown, and batch cost estimates. Chaining passes the next shot's still as `tail_image_url`. SFX is a separate fal call (MMAudio v2) producing a `clip-sfx.mp4` variant that never mutates the clip. Batch orchestrator gains model threading, an AI chain-suggestion step, and an SFX wave.

**Tech Stack:** Next.js 15 App Router, Drizzle + Postgres (`npm run db:push`, no migration files), `@fal-ai/client`, Inngest, Anthropic SDK (Haiku), R2 via `@aws-sdk/client-s3`, Vitest (new).

## Global Constraints

- Follow `security-playbook.md`: every mutation route uses `applyRateLimit` → `verifyCsrf` → `getSession` → UUID validation → ownership join, in that order (copy the pattern from `src/app/api/projects/[id]/shots/[shotId]/clip/route.ts`).
- Every file starts with a block comment describing what it does (existing repo convention).
- Model ids from clients are ALWAYS validated against the registry server-side; never interpolate client strings into fal endpoints or R2 keys.
- Cost numbers are estimates and must be labeled "~$" / "estimate" in UI.
- Functions < ~150 LOC. No dead code — the clip-hailuo route and its UI button are deleted, not commented out.
- DB schema changes are additive; apply with `npm run db:push` (this repo has no migrations folder).
- Default clip model id is `kling-2.5-turbo-pro` everywhere (`DEFAULT_CLIP_MODEL_ID`).

---

### Task 1: Vitest setup

**Files:**
- Modify: `package.json` (devDependency + script)
- Create: `vitest.config.ts`
- Create: `tests/unit/smoke.test.ts` (deleted again in Task 2 when real tests exist — keep it until then so the runner is verifiably green)

**Interfaces:**
- Produces: `npm run test` runs all `tests/unit/**/*.test.ts` with `@/` path alias resolving to `src/`.

- [ ] **Step 1: Install vitest**

```bash
npm install -D vitest
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
/**
 * Vitest configuration. Unit tests live in tests/unit and exercise pure
 * logic only (no network, no DB) — routes and UI are covered by the
 * manual test cases in docs/feature18/test-case.md.
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
```

- [ ] **Step 3: Add script to `package.json`**

In the `"scripts"` block, after `"lint"`:

```json
    "test": "vitest run",
```

- [ ] **Step 4: Create smoke test `tests/unit/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("vitest setup", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run and verify green**

Run: `npm run test`
Expected: `1 passed`

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/unit/smoke.test.ts
git commit -m "chore: add vitest for pure-logic unit tests"
```

---

### Task 2: Clip model registry

**Files:**
- Create: `src/lib/clip-models.ts`
- Create: `tests/unit/clip-models.test.ts`
- Delete: `tests/unit/smoke.test.ts`

**Interfaces:**
- Produces (used by Tasks 3, 4, 6, 8, 9, 10, 12):
  - `type ClipModelId = "ltx-2.3" | "kling-2.5-turbo-pro" | "veo-3.1-fast"`
  - `const DEFAULT_CLIP_MODEL_ID: ClipModelId`
  - `interface ClipModelSpec { id; label; falEndpoint; durationSeconds; supportsEndFrame; nativeAudio; estUsdPerClip; whenToUse; buildInput(args: { imageUrl: string; prompt: string; tailImageUrl?: string }): Record<string, unknown> }`
  - `const CLIP_MODELS: ClipModelSpec[]` (ordered for the dropdown)
  - `function getClipModel(id: string | null | undefined): ClipModelSpec | null`
  - `function isClipModelId(id: unknown): id is ClipModelId`
  - `const SFX_EST_USD = 0.01`

- [ ] **Step 1: Verify fal endpoint ids (no code)**

Open these fal model pages and confirm the endpoint ids used below (adjust the constants in Step 3 if fal has renamed them; note any change in the commit message):
- https://fal.ai/models/fal-ai/ltx-2.3/image-to-video (current prod endpoint — must match `shot-clip-generation.ts` today)
- https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/api — confirm `tail_image_url` and `duration: "5" | "10"` inputs (verified 2026-07-08)
- https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video — confirm exact endpoint id and whether first+last-frame inputs exist. If fal exposes a last-frame param, set `supportsEndFrame: true` and add it in `buildInput`; otherwise leave `false` as written below.

- [ ] **Step 2: Write the failing tests `tests/unit/clip-models.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  CLIP_MODELS,
  DEFAULT_CLIP_MODEL_ID,
  getClipModel,
  isClipModelId,
} from "@/lib/clip-models";

describe("clip model registry", () => {
  it("defaults to Kling 2.5 Turbo Pro", () => {
    expect(DEFAULT_CLIP_MODEL_ID).toBe("kling-2.5-turbo-pro");
    expect(getClipModel(DEFAULT_CLIP_MODEL_ID)?.supportsEndFrame).toBe(true);
  });

  it("returns null for unknown / missing ids", () => {
    expect(getClipModel("fal-ai/evil/endpoint")).toBeNull();
    expect(getClipModel(null)).toBeNull();
    expect(getClipModel(undefined)).toBeNull();
  });

  it("type-guards ids", () => {
    expect(isClipModelId("ltx-2.3")).toBe(true);
    expect(isClipModelId("gpt-video")).toBe(false);
    expect(isClipModelId(42)).toBe(false);
  });

  it("every entry has cost, duration, and guidance", () => {
    for (const m of CLIP_MODELS) {
      expect(m.estUsdPerClip).toBeGreaterThan(0);
      expect(m.durationSeconds).toBeGreaterThan(0);
      expect(m.whenToUse.length).toBeGreaterThan(10);
    }
  });

  it("LTX buildInput ignores tail image (no end-frame support)", () => {
    const input = getClipModel("ltx-2.3")!.buildInput({
      imageUrl: "https://fal/img.png",
      prompt: "clock swings",
      tailImageUrl: "https://fal/tail.png",
    });
    expect(input).toEqual({ image_url: "https://fal/img.png", prompt: "clock swings" });
  });

  it("Kling buildInput maps tail_image_url and fixed duration", () => {
    const kling = getClipModel("kling-2.5-turbo-pro")!;
    expect(
      kling.buildInput({ imageUrl: "a", prompt: "p", tailImageUrl: "b" }),
    ).toEqual({ image_url: "a", prompt: "p", duration: "5", tail_image_url: "b" });
    expect(kling.buildInput({ imageUrl: "a", prompt: "p" })).toEqual({
      image_url: "a",
      prompt: "p",
      duration: "5",
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test`
Expected: FAIL — cannot resolve `@/lib/clip-models`

- [ ] **Step 4: Create `src/lib/clip-models.ts`**

```ts
/**
 * Clip model registry — the single source of truth for which fal.ai
 * image-to-video models the app can use (Clip Engine v2). Drives the
 * inspector dropdown, the clip route's allow-list validation, the
 * generation service's input mapping, and batch cost estimates.
 * Adding a model = adding one entry here. Client-supplied model ids MUST
 * be resolved through getClipModel/isClipModelId — never passed to fal raw.
 */

export type ClipModelId = "ltx-2.3" | "kling-2.5-turbo-pro" | "veo-3.1-fast";

export interface ClipModelSpec {
  id: ClipModelId;
  label: string;
  falEndpoint: string;
  /** Fixed output length used for estimates; actual output duration wins when fal returns one. */
  durationSeconds: number;
  /** Model accepts an end-frame image (enables "chain to next shot"). */
  supportsEndFrame: boolean;
  /** Model generates its own audio track. */
  nativeAudio: boolean;
  /** Display-only ballpark, same convention as generation-costs.ts. */
  estUsdPerClip: number;
  whenToUse: string;
  buildInput(args: {
    imageUrl: string;
    prompt: string;
    tailImageUrl?: string;
  }): Record<string, unknown>;
}

export const DEFAULT_CLIP_MODEL_ID: ClipModelId = "kling-2.5-turbo-pro";

/** Display-only ballpark for one MMAudio v2 SFX pass (priced ~$0.001/s). */
export const SFX_EST_USD = 0.01;

export const CLIP_MODELS: ClipModelSpec[] = [
  {
    id: "kling-2.5-turbo-pro",
    label: "Kling 2.5 Turbo Pro",
    falEndpoint: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    durationSeconds: 5,
    supportsEndFrame: true,
    nativeAudio: false,
    estUsdPerClip: 0.42,
    whenToUse: "Default — best motion quality for the price; supports chaining to the next shot.",
    buildInput: ({ imageUrl, prompt, tailImageUrl }) => ({
      image_url: imageUrl,
      prompt,
      duration: "5",
      ...(tailImageUrl ? { tail_image_url: tailImageUrl } : {}),
    }),
  },
  {
    id: "ltx-2.3",
    label: "LTX 2.3",
    falEndpoint: "fal-ai/ltx-2.3/image-to-video",
    durationSeconds: 6,
    supportsEndFrame: false,
    nativeAudio: false,
    estUsdPerClip: 0.25,
    whenToUse: "Cheap drafts — fast and low-cost, but weak at directed motion; no chaining.",
    buildInput: ({ imageUrl, prompt }) => ({ image_url: imageUrl, prompt }),
  },
  {
    id: "veo-3.1-fast",
    label: "Veo 3.1 Fast",
    falEndpoint: "fal-ai/veo3.1/fast/image-to-video",
    durationSeconds: 8,
    supportsEndFrame: false,
    nativeAudio: true,
    estUsdPerClip: 1.2,
    whenToUse: "Hero shots — strongest complex motion and native audio; ~3× the default's cost.",
    buildInput: ({ imageUrl, prompt }) => ({ image_url: imageUrl, prompt }),
  },
];

export function getClipModel(id: string | null | undefined): ClipModelSpec | null {
  if (!id) return null;
  return CLIP_MODELS.find((m) => m.id === id) ?? null;
}

export function isClipModelId(id: unknown): id is ClipModelId {
  return typeof id === "string" && CLIP_MODELS.some((m) => m.id === id);
}
```

- [ ] **Step 5: Run tests to verify they pass; delete the smoke test**

Run: `npm run test`
Expected: all clip-models tests PASS

```bash
rm tests/unit/smoke.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/clip-models.ts tests/unit/clip-models.test.ts tests/unit/smoke.test.ts
git commit -m "feat(clip-engine-v2): clip model registry (Kling default, LTX draft, Veo hero)"
```

---

### Task 3: Chain-decision logic

**Files:**
- Create: `src/lib/clip-chaining.ts`
- Test: `tests/unit/clip-chaining.test.ts`

**Interfaces:**
- Consumes: `ClipModelSpec` from `@/lib/clip-models`.
- Produces (used by Task 6):
  - `type ChainDecision = { useTail: true; tailImagePath: string } | { useTail: false; reason: ChainSkipReason }`
  - `type ChainSkipReason = "not-requested" | "model-no-end-frame" | "no-next-shot" | "next-image-not-ready"`
  - `function resolveChainDecision(args: { chainToNext: boolean; spec: Pick<ClipModelSpec, "supportsEndFrame">; nextShot: { imagePath: string | null; imageStatus: string | null } | null }): ChainDecision`

- [ ] **Step 1: Write the failing tests `tests/unit/clip-chaining.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { resolveChainDecision } from "@/lib/clip-chaining";

const endFrameSpec = { supportsEndFrame: true };
const noEndFrameSpec = { supportsEndFrame: false };
const readyNext = { imagePath: "projects/p/shots/n/image.png", imageStatus: "done" };

describe("resolveChainDecision", () => {
  it("chains when requested, supported, and next image is done", () => {
    expect(
      resolveChainDecision({ chainToNext: true, spec: endFrameSpec, nextShot: readyNext }),
    ).toEqual({ useTail: true, tailImagePath: readyNext.imagePath });
  });

  it("skips when not requested", () => {
    expect(
      resolveChainDecision({ chainToNext: false, spec: endFrameSpec, nextShot: readyNext }),
    ).toEqual({ useTail: false, reason: "not-requested" });
  });

  it("skips when the model has no end-frame support", () => {
    expect(
      resolveChainDecision({ chainToNext: true, spec: noEndFrameSpec, nextShot: readyNext }),
    ).toEqual({ useTail: false, reason: "model-no-end-frame" });
  });

  it("skips when the shot is last in sequence", () => {
    expect(
      resolveChainDecision({ chainToNext: true, spec: endFrameSpec, nextShot: null }),
    ).toEqual({ useTail: false, reason: "no-next-shot" });
  });

  it.each([
    { imagePath: null, imageStatus: "pending" },
    { imagePath: "projects/p/shots/n/image.png", imageStatus: "failed" },
    { imagePath: "projects/p/shots/n/image.png", imageStatus: "generating" },
  ])("skips when the next image is not ready (%j)", (nextShot) => {
    expect(
      resolveChainDecision({ chainToNext: true, spec: endFrameSpec, nextShot }),
    ).toEqual({ useTail: false, reason: "next-image-not-ready" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test`
Expected: FAIL — cannot resolve `@/lib/clip-chaining`

- [ ] **Step 3: Create `src/lib/clip-chaining.ts`**

```ts
/**
 * Chain-to-next decision logic (Clip Engine v2). Pure function deciding
 * whether a clip generation should pass the next shot's still image as the
 * model's end frame ("chaining"), and if not, why — the reason is surfaced
 * to the UI so a skipped chain degrades loudly, never fails the clip.
 */
import type { ClipModelSpec } from "@/lib/clip-models";

export type ChainSkipReason =
  | "not-requested"
  | "model-no-end-frame"
  | "no-next-shot"
  | "next-image-not-ready";

export type ChainDecision =
  | { useTail: true; tailImagePath: string }
  | { useTail: false; reason: ChainSkipReason };

export function resolveChainDecision(args: {
  chainToNext: boolean;
  spec: Pick<ClipModelSpec, "supportsEndFrame">;
  nextShot: { imagePath: string | null; imageStatus: string | null } | null;
}): ChainDecision {
  if (!args.chainToNext) return { useTail: false, reason: "not-requested" };
  if (!args.spec.supportsEndFrame) return { useTail: false, reason: "model-no-end-frame" };
  if (!args.nextShot) return { useTail: false, reason: "no-next-shot" };
  if (!args.nextShot.imagePath || args.nextShot.imageStatus !== "done") {
    return { useTail: false, reason: "next-image-not-ready" };
  }
  return { useTail: true, tailImagePath: args.nextShot.imagePath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/clip-chaining.ts tests/unit/clip-chaining.test.ts
git commit -m "feat(clip-engine-v2): pure chain-to-next decision logic"
```

---

### Task 4: Cost estimates from the registry

**Files:**
- Modify: `src/lib/generation-costs.ts` (replace `CLIP_EST_USD` with registry lookup; add SFX line)
- Test: `tests/unit/generation-costs.test.ts`

**Interfaces:**
- Consumes: `getClipModel`, `DEFAULT_CLIP_MODEL_ID`, `SFX_EST_USD` from `@/lib/clip-models`.
- Produces (used by Tasks 9, 13, 14):
  - `estimateBatchCost(counts: { sheets: number; images: number; clips: number }, opts?: { clipModelId?: string; includeSfx?: boolean })` returning `{ sheetsUsd, imagesUsd, clipsUsd, sfxUsd, totalUsd, totalWithClipsUsd }` — `totalWithClipsUsd` includes `sfxUsd` when `includeSfx`.
  - `SHEET_EST_USD`, `IMAGE_EST_USD` unchanged. `CLIP_EST_USD` is deleted; grep confirms nothing else imports it (only `generation-costs.ts` itself uses it today).

- [ ] **Step 1: Write the failing tests `tests/unit/generation-costs.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { estimateBatchCost } from "@/lib/generation-costs";

describe("estimateBatchCost", () => {
  const counts = { sheets: 2, images: 10, clips: 10 };

  it("prices clips by the default model when no model given", () => {
    const c = estimateBatchCost(counts);
    expect(c.clipsUsd).toBe(4.2); // 10 × $0.42 Kling default
    expect(c.sheetsUsd).toBe(0.08);
    expect(c.imagesUsd).toBe(0.4);
    expect(c.totalUsd).toBe(0.48); // sheets + images only (unchanged behavior)
    expect(c.totalWithClipsUsd).toBe(4.68);
    expect(c.sfxUsd).toBe(0);
  });

  it("prices clips by the selected model", () => {
    expect(estimateBatchCost(counts, { clipModelId: "ltx-2.3" }).clipsUsd).toBe(2.5);
    expect(estimateBatchCost(counts, { clipModelId: "veo-3.1-fast" }).clipsUsd).toBe(12);
  });

  it("falls back to the default model for unknown ids", () => {
    expect(estimateBatchCost(counts, { clipModelId: "nope" }).clipsUsd).toBe(4.2);
  });

  it("adds SFX per clip when included", () => {
    const c = estimateBatchCost(counts, { includeSfx: true });
    expect(c.sfxUsd).toBe(0.1); // 10 × $0.01
    expect(c.totalWithClipsUsd).toBe(4.78);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test`
Expected: FAIL — `estimateBatchCost` does not accept `opts` / `sfxUsd` undefined

- [ ] **Step 3: Rewrite `src/lib/generation-costs.ts`**

```ts
/**
 * Per-unit USD cost ESTIMATES for batch generation ("Generate all", v4 P3;
 * clip pricing registry-driven since Clip Engine v2). Display-only
 * ballparks for the cost-preview dialog — the UI must label them as
 * estimates. Clip cost comes from the selected model's registry entry.
 */
import { getClipModel, DEFAULT_CLIP_MODEL_ID, SFX_EST_USD } from "@/lib/clip-models";

export const SHEET_EST_USD = 0.04;
export const IMAGE_EST_USD = 0.04;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateBatchCost(
  counts: { sheets: number; images: number; clips: number },
  opts?: { clipModelId?: string; includeSfx?: boolean },
) {
  const clipModel = getClipModel(opts?.clipModelId) ?? getClipModel(DEFAULT_CLIP_MODEL_ID)!;
  const sheetsUsd = round2(counts.sheets * SHEET_EST_USD);
  const imagesUsd = round2(counts.images * IMAGE_EST_USD);
  const clipsUsd = round2(counts.clips * clipModel.estUsdPerClip);
  const sfxUsd = opts?.includeSfx ? round2(counts.clips * SFX_EST_USD) : 0;
  return {
    sheetsUsd,
    imagesUsd,
    clipsUsd,
    sfxUsd,
    totalUsd: round2(sheetsUsd + imagesUsd),
    totalWithClipsUsd: round2(sheetsUsd + imagesUsd + clipsUsd + sfxUsd),
  };
}
```

- [ ] **Step 4: Run tests + build to verify nothing else imported CLIP_EST_USD**

Run: `npm run test` → PASS
Run: `grep -rn "CLIP_EST_USD" src/` → no matches
Run: `npm run lint` → clean

- [ ] **Step 5: Commit**

```bash
git add src/lib/generation-costs.ts tests/unit/generation-costs.test.ts
git commit -m "feat(clip-engine-v2): registry-driven clip cost estimates + SFX line item"
```

---

### Task 5: Schema — clipModel, chainToNext, SFX columns

**Files:**
- Modify: `src/lib/db/schema.ts` (shots table, after the `clipDurationSeconds` line ~`src/lib/db/schema.ts:194`)

**Interfaces:**
- Produces: `shots.clipModel: text | null`, `shots.chainToNext: boolean NOT NULL default false`, `shots.sfxPath: text | null`, `shots.sfxStatus: generationStatusEnum default "pending"`. The `Shot` inferred type picks these up automatically.

- [ ] **Step 1: Add columns to the shots table in `src/lib/db/schema.ts`**

Directly below the `clipDurationSeconds` column inside the `// ── Clip (F-07) ──` block:

```ts
    // ── Clip Engine v2 ──
    // Model id from the clip-models registry used for the current clip;
    // also the shot's sticky dropdown selection. Null = registry default.
    clipModel: text("clip_model"),
    // "This clip should end at the next shot's image" (first/last-frame
    // conditioning). Honored only by models with supportsEndFrame.
    chainToNext: boolean("chain_to_next").default(false).notNull(),

    // ── SFX (Clip Engine v2) ──
    // MMAudio variant (clip-sfx.mp4). Decoupled from clipStatus; reset
    // whenever the clip itself is regenerated.
    sfxPath: text("sfx_path"),
    sfxStatus: generationStatusEnum("sfx_status").default("pending"),
```

(`boolean` is already imported in this file — verify; if not, add it to the `drizzle-orm/pg-core` import.)

- [ ] **Step 2: Push the schema**

Run: `npm run db:push`
Expected: adds 4 columns to `shots`, no destructive prompts. If drizzle-kit warns about anything destructive, STOP and re-check the diff.

- [ ] **Step 3: Verify columns exist**

Run: `npm run db:studio` (or psql) and confirm `shots` now has `clip_model`, `chain_to_next`, `sfx_path`, `sfx_status`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/schema.ts
git commit -m "feat(clip-engine-v2): shots columns for clip model, chaining, and SFX"
```

---

### Task 6: Shared fal upload helper + model-agnostic clip service

**Files:**
- Create: `src/lib/fal-upload.ts`
- Modify: `src/lib/shot-clip-generation.ts` (full rewrite below)

**Interfaces:**
- Consumes: registry (Task 2), `resolveChainDecision` (Task 3), schema columns (Task 5).
- Produces (used by Tasks 7, 8, 12):
  - `uploadR2ObjectToFal(r2Key: string, opts: { fileName: string; contentType: string }): Promise<string>` — R2 → fal storage, falls back to a presigned R2 URL.
  - `generateShotClip(project: Project, shot: Shot, opts?: { model?: string }): Promise<{ clipPath: string; clipUrl: string; clipDurationSeconds: number; clipModel: ClipModelId; chainSkippedReason?: ChainSkipReason }>` — `chainSkippedReason` present only when `shot.chainToNext` was true but the tail was skipped.

- [ ] **Step 1: Create `src/lib/fal-upload.ts`**

```ts
/**
 * Shared R2 → fal.ai storage upload (Clip Engine v2 extraction — was
 * duplicated in shot-clip-generation and the deleted clip-hailuo route).
 * fal can't always read R2 presigned URLs, so we copy the bytes into fal
 * storage and fall back to a presigned URL only if the initiate call fails.
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

export async function uploadR2ObjectToFal(
  r2Key: string,
  opts: { fileName: string; contentType: string },
): Promise<string> {
  const r2Object = await r2Client.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }),
  );
  const bytes = await r2Object.Body!.transformToByteArray();
  const buffer = Buffer.from(bytes);

  const initRes = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file_name: opts.fileName, content_type: opts.contentType }),
  });

  if (initRes.ok) {
    const { upload_url, file_url } = (await initRes.json()) as {
      upload_url: string;
      file_url: string;
    };
    await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": opts.contentType },
      body: buffer,
    });
    return file_url;
  }

  // Fallback: some fal models accept R2 presigned URLs directly
  return getDownloadUrl(r2Key);
}
```

- [ ] **Step 2: Rewrite `src/lib/shot-clip-generation.ts`**

```ts
/**
 * Shot clip generation service (v4 P3 extraction; multi-model since Clip
 * Engine v2). Resolves the clip model from the registry (explicit param →
 * shot.clipModel → default), optionally passes the NEXT shot's still as the
 * end frame when shot.chainToNext is set and the model supports it (a
 * skipped chain degrades to unchained generation and reports why), calls
 * fal, and stores at projects/{projectId}/shots/{shotId}/clip.mp4. Owns the
 * clipStatus generating → done/failed lifecycle; throws after marking
 * failed. Regenerating a clip resets any SFX variant — the old audio no
 * longer matches. Caller must ensure shot.imagePath is set. Called by
 * POST /shots/[shotId]/clip AND the batch orchestrator.
 */
import { db } from "@/lib/db";
import { shots, type Project, type Shot } from "@/lib/db/schema";
import { eq, and, gt, asc } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";
import { uploadR2ObjectToFal } from "@/lib/fal-upload";
import {
  getClipModel,
  DEFAULT_CLIP_MODEL_ID,
  type ClipModelId,
} from "@/lib/clip-models";
import { resolveChainDecision, type ChainSkipReason } from "@/lib/clip-chaining";

fal.config({ credentials: process.env.FAL_KEY! });

export async function generateShotClip(
  project: Project,
  shot: Shot,
  opts?: { model?: string },
): Promise<{
  clipPath: string;
  clipUrl: string;
  clipDurationSeconds: number;
  clipModel: ClipModelId;
  chainSkippedReason?: ChainSkipReason;
}> {
  const spec =
    getClipModel(opts?.model) ??
    getClipModel(shot.clipModel) ??
    getClipModel(DEFAULT_CLIP_MODEL_ID)!;

  await db.update(shots).set({ clipStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    console.log(
      `[shot-clip] project=${project.id} shot=${shot.id} model=${spec.id} | motion: ${shot.motionPrompt.substring(0, 120)}...`,
    );

    const [nextShot] = await db
      .select({ imagePath: shots.imagePath, imageStatus: shots.imageStatus })
      .from(shots)
      .where(and(eq(shots.projectId, project.id), gt(shots.sortOrder, shot.sortOrder)))
      .orderBy(asc(shots.sortOrder))
      .limit(1);

    const chain = resolveChainDecision({
      chainToNext: shot.chainToNext,
      spec,
      nextShot: nextShot ?? null,
    });

    const imageUrl = await uploadR2ObjectToFal(shot.imagePath!, {
      fileName: "shot-image.png",
      contentType: "image/png",
    });
    const tailImageUrl = chain.useTail
      ? await uploadR2ObjectToFal(chain.tailImagePath, {
          fileName: "shot-tail-image.png",
          contentType: "image/png",
        })
      : undefined;

    const result = await fal.subscribe(spec.falEndpoint, {
      input: spec.buildInput({ imageUrl, prompt: shot.motionPrompt, tailImageUrl }),
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log(`[shot-clip] ${msg}`));
        }
      },
    });

    const output = result.data as { video?: { url: string; duration?: number } };
    if (!output.video?.url) throw new Error(`${spec.label} returned no video`);
    const clipDuration = output.video.duration ?? spec.durationSeconds;

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

    // SFX is invalidated by a new clip: the old audio no longer matches.
    await db
      .update(shots)
      .set({
        clipPath: r2Key,
        clipStatus: "done",
        clipDurationSeconds: Math.round(clipDuration),
        clipModel: spec.id,
        sfxPath: null,
        sfxStatus: "pending",
      })
      .where(eq(shots.id, shot.id));

    const chainSkippedReason =
      shot.chainToNext && !chain.useTail ? chain.reason : undefined;
    console.log(
      `[shot-clip] done: ${r2Key} (${clipDuration}s, ${spec.id}${chainSkippedReason ? `, chain skipped: ${chainSkippedReason}` : chain.useTail ? ", chained" : ""})`,
    );
    return {
      clipPath: r2Key,
      clipUrl: await getDownloadUrl(r2Key),
      clipDurationSeconds: Math.round(clipDuration),
      clipModel: spec.id,
      ...(chainSkippedReason ? { chainSkippedReason } : {}),
    };
  } catch (error) {
    await db.update(shots).set({ clipStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 3: Verify build + tests**

Run: `npm run lint && npm run test`
Expected: clean / PASS (batch orchestrator still compiles — it calls `generateShotClip(project, shot)` which now uses the shot's `clipModel` → default; model threading comes in Task 13)

- [ ] **Step 4: Commit**

```bash
git add src/lib/fal-upload.ts src/lib/shot-clip-generation.ts
git commit -m "feat(clip-engine-v2): model-agnostic clip service with chain-to-next tail frames"
```

---

### Task 7: Clip route model param + delete clip-hailuo

**Files:**
- Modify: `src/app/api/projects/[id]/shots/[shotId]/clip/route.ts`
- Delete: `src/app/api/projects/[id]/shots/[shotId]/clip-hailuo/route.ts`

**Interfaces:**
- Consumes: `isClipModelId` (Task 2), `generateShotClip` (Task 6).
- Produces: `POST .../clip` accepts optional JSON body `{ model?: ClipModelId }`; response now also carries `clipModel` and optional `chainSkippedReason`. Missing/empty body keeps working (defaults).

- [ ] **Step 1: Update the clip route**

In `src/app/api/projects/[id]/shots/[shotId]/clip/route.ts`: update the header comment (multi-model via registry, optional `{ model }` body), add the import, parse the body between the `imagePath` guard and the `try`:

```ts
import { isClipModelId } from "@/lib/clip-models";
```

```ts
  // Optional body: { model?: ClipModelId }. Absent/empty body = defaults.
  let model: string | undefined;
  const raw = await request.text();
  if (raw) {
    try {
      const body = JSON.parse(raw) as { model?: unknown };
      if (body.model !== undefined) {
        if (!isClipModelId(body.model)) return badRequestResponse("Unknown clip model");
        model = body.model;
      }
    } catch {
      return badRequestResponse("Invalid request body");
    }
  }
```

and pass it through:

```ts
    const result = await generateShotClip(project, shot, { model });
```

- [ ] **Step 2: Delete the clip-hailuo route**

```bash
rm -r "src/app/api/projects/[id]/shots/[shotId]/clip-hailuo"
```

- [ ] **Step 3: Verify nothing references it server-side**

Run: `grep -rn "clip-hailuo" src/`
Expected: only `src/components/editor/editor-store.tsx:491` (removed in Task 10). `npm run lint` clean.

- [ ] **Step 4: Commit**

```bash
git add -A src/app/api
git commit -m "feat(clip-engine-v2): clip route model param; drop throwaway clip-hailuo route"
```

---

### Task 8: SFX service + route

**Files:**
- Create: `src/lib/sfx-generation.ts`
- Create: `src/app/api/projects/[id]/shots/[shotId]/sfx/route.ts`

**Interfaces:**
- Consumes: `uploadR2ObjectToFal` (Task 6), schema columns (Task 5).
- Produces (used by Tasks 10, 13):
  - `generateShotSfx(project: Project, shot: Shot, opts?: { prompt?: string }): Promise<{ sfxPath: string; sfxUrl: string }>` — requires `shot.clipPath`; owns `sfxStatus` generating → done/failed; throws after marking failed.
  - `POST .../sfx` body `{ prompt?: string }` (≤500 chars) → `{ sfxPath, sfxUrl, sfxStatus: "done" }`
  - `DELETE .../sfx` → deletes the R2 object, nulls `sfxPath`, resets `sfxStatus` to `"pending"` → `{ sfxPath: null, sfxStatus: "pending" }`
  - `SFX_PROMPT_MAX_CHARS = 500` exported from `sfx-generation.ts`.

- [ ] **Step 1: Verify the MMAudio endpoint (no code)**

Open https://fal.ai/models/fal-ai/mmaudio-v2 and confirm: endpoint id `fal-ai/mmaudio-v2`, input `{ video_url, prompt? }`, output `{ video: { url } }` (video with the audio track merged). Adjust Step 2 if the shape differs.

- [ ] **Step 2: Create `src/lib/sfx-generation.ts`**

```ts
/**
 * Shot SFX generation service (Clip Engine v2). Runs the finished clip
 * through MMAudio v2 (video→audio foley, ~$0.001/s) and stores the merged
 * output as a SEPARATE variant at .../clip-sfx.mp4 — clip.mp4 is never
 * touched, so SFX can be re-rolled or removed for cents without re-billing
 * the clip. Owns the sfxStatus generating → done/failed lifecycle; throws
 * after marking failed. Caller must ensure shot.clipPath is set.
 */
import { db } from "@/lib/db";
import { shots, type Project, type Shot } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";
import { uploadR2ObjectToFal } from "@/lib/fal-upload";

fal.config({ credentials: process.env.FAL_KEY! });

export const SFX_PROMPT_MAX_CHARS = 500;

export async function generateShotSfx(
  project: Project,
  shot: Shot,
  opts?: { prompt?: string },
): Promise<{ sfxPath: string; sfxUrl: string }> {
  await db.update(shots).set({ sfxStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    console.log(`[shot-sfx] project=${project.id} shot=${shot.id}`);

    const videoUrl = await uploadR2ObjectToFal(shot.clipPath!, {
      fileName: "shot-clip.mp4",
      contentType: "video/mp4",
    });

    const result = await fal.subscribe("fal-ai/mmaudio-v2", {
      input: {
        video_url: videoUrl,
        ...(opts?.prompt?.trim() ? { prompt: opts.prompt.trim() } : {}),
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log(`[shot-sfx] ${msg}`));
        }
      },
    });

    const output = result.data as { video?: { url: string } };
    if (!output.video?.url) throw new Error("MMAudio returned no video");

    const videoRes = await fetch(output.video.url);
    if (!videoRes.ok) throw new Error("Failed to download SFX variant");
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

    const r2Key = `projects/${project.id}/shots/${shot.id}/clip-sfx.mp4`;
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
      .set({ sfxPath: r2Key, sfxStatus: "done" })
      .where(eq(shots.id, shot.id));

    console.log(`[shot-sfx] done: ${r2Key}`);
    return { sfxPath: r2Key, sfxUrl: await getDownloadUrl(r2Key) };
  } catch (error) {
    await db.update(shots).set({ sfxStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 3: Create `src/app/api/projects/[id]/shots/[shotId]/sfx/route.ts`**

```ts
/**
 * POST   /api/projects/[id]/shots/[shotId]/sfx — generate synced SFX for
 *        the shot's clip via MMAudio v2. Body: { prompt?: string } (≤500
 *        chars, optional steering text forwarded only to fal).
 * DELETE /api/projects/[id]/shots/[shotId]/sfx — remove the SFX variant:
 *        deletes the R2 object, nulls sfxPath, resets sfxStatus.
 * The clip itself is never modified by either verb.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { r2Client } from "@/lib/r2";
import { generateShotSfx, SFX_PROMPT_MAX_CHARS } from "@/lib/sfx-generation";

type Params = { params: Promise<{ id: string; shotId: string }> };

async function loadOwnedRow(projectId: string, shotId: string, userId: string) {
  const [row] = await db
    .select({ shot: shots, project: projects })
    .from(shots)
    .innerJoin(projects, eq(shots.projectId, projects.id))
    .where(and(eq(shots.id, shotId), eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const row = await loadOwnedRow(id, shotId, session.user.id);
  if (!row) return notFoundResponse();
  const { shot, project } = row;

  if (!shot.clipPath || shot.clipStatus !== "done") {
    return badRequestResponse("Generate the shot's clip before adding SFX");
  }
  if (shot.sfxStatus === "generating") {
    return badRequestResponse("SFX is already generating for this shot");
  }

  let prompt: string | undefined;
  const raw = await request.text();
  if (raw) {
    try {
      const body = JSON.parse(raw) as { prompt?: unknown };
      if (body.prompt !== undefined) {
        if (typeof body.prompt !== "string" || body.prompt.length > SFX_PROMPT_MAX_CHARS) {
          return badRequestResponse(`prompt must be a string of at most ${SFX_PROMPT_MAX_CHARS} characters`);
        }
        prompt = body.prompt;
      }
    } catch {
      return badRequestResponse("Invalid request body");
    }
  }

  try {
    const result = await generateShotSfx(project, shot, { prompt });
    return NextResponse.json({ ...result, sfxStatus: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/sfx] failed:`, msg);
    return NextResponse.json({ error: msg, sfxStatus: "failed" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const row = await loadOwnedRow(id, shotId, session.user.id);
  if (!row) return notFoundResponse();
  const { shot } = row;

  if (shot.sfxPath) {
    try {
      await r2Client.send(
        new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: shot.sfxPath }),
      );
    } catch (error) {
      // Losing the orphan object is acceptable; losing the DB reset is not.
      console.warn(`[shot/sfx] R2 delete failed for ${shot.sfxPath}:`, error);
    }
  }

  await db
    .update(shots)
    .set({ sfxPath: null, sfxStatus: "pending" })
    .where(eq(shots.id, shotId));

  return NextResponse.json({ sfxPath: null, sfxStatus: "pending" });
}
```

- [ ] **Step 4: Verify build**

Run: `npm run lint && npm run test`
Expected: clean / PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sfx-generation.ts "src/app/api/projects/[id]/shots/[shotId]/sfx"
git commit -m "feat(clip-engine-v2): MMAudio SFX service + decoupled sfx route"
```

---

### Task 9: Shot PATCH accepts chainToNext + clipModel

**Files:**
- Modify: `src/app/api/projects/[id]/shots/[shotId]/route.ts`

**Interfaces:**
- Consumes: `isClipModelId` (Task 2).
- Produces: `PATCH` body additionally accepts `chainToNext?: boolean` and `clipModel?: ClipModelId | null` (null clears back to default); response row includes the new columns (it already returns the updated row).

- [ ] **Step 1: Extend the accepted body type and validation**

In the `PATCH` handler, extend the `body` cast:

```ts
  const body = rawBody as Partial<{
    beatId: string;
    startInBeat: number;
    endInBeat: number;
    imagePrompt: string;
    motionPrompt: string;
    referencedEntityIds: string[];
    chainToNext: boolean;
    clipModel: string | null;
  }>;
```

After the existing `referencedEntityIds` validation block, add:

```ts
  if (body.chainToNext !== undefined) {
    if (typeof body.chainToNext !== "boolean") {
      return badRequestResponse("chainToNext must be a boolean");
    }
    updates.chainToNext = body.chainToNext;
  }

  if (body.clipModel !== undefined) {
    // null clears the selection back to the registry default
    if (body.clipModel !== null && !isClipModelId(body.clipModel)) {
      return badRequestResponse("Unknown clip model");
    }
    updates.clipModel = body.clipModel;
  }
```

with the import:

```ts
import { isClipModelId } from "@/lib/clip-models";
```

Also update the file's header comment to mention the two new PATCH fields.

- [ ] **Step 2: Verify build**

Run: `npm run lint`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/projects/[id]/shots/[shotId]/route.ts"
git commit -m "feat(clip-engine-v2): shot PATCH accepts chainToNext and clipModel"
```

---

### Task 10: Serializers + editor store

**Files:**
- Modify: `src/components/editor/editor-store.tsx`
- Modify: `src/app/api/projects/[id]/shots/route.ts` (GET serializer, ~line 67)
- Modify: `src/app/projects/[id]/page.tsx` (server-side shot serializer, ~line 68)

**Interfaces:**
- Consumes: routes from Tasks 7–9.
- Produces (used by Tasks 11, 12, 14):
  - `EditorShot` gains `clipModel: string | null`, `chainToNext: boolean`, `sfxPath: string | null`, `sfxStatus: string`, `sfxUrl: string | null`.
  - Store API: `generateClip(shotId: string, model?: string)` (old `"ltx" | "hailuo"` union gone), `generateSfx(shotId: string, prompt?: string): Promise<void>`, `removeSfx(shotId: string): Promise<void>`; `updateShot` passes `chainToNext`/`clipModel` through unchanged (it already forwards arbitrary patch keys).
  - `GenerateAllPreview` gains `sfx: { count: number; estUsd: number }` and keeps existing fields (wired in Task 14).

- [ ] **Step 1: Extend `EditorShot` and `GenerateAllPreview`**

In `editor-store.tsx`, add to `EditorShot` after `clipDurationSeconds`:

```ts
  clipModel: string | null;
  chainToNext: boolean;
  sfxPath: string | null;
  sfxStatus: string;
  sfxUrl: string | null;
```

Add to `GenerateAllPreview` after `clips`:

```ts
  sfx: { count: number; estUsd: number };
```

- [ ] **Step 2: Replace `generateClip` and add SFX actions**

Replace the `generateClip` callback (`editor-store.tsx:489-524`) with:

```ts
  const generateClip = useCallback(
    async (shotId: string, model?: string) => {
      dispatch({ type: "patchShot", shotId, patch: { clipStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/clip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(model ? { model } : {}),
        });
        if (!res.ok) {
          console.warn("[editor-store] clip generation failed:", await res.text());
          dispatch({ type: "patchShot", shotId, patch: { clipStatus: "failed" } });
          return;
        }
        const data = (await res.json()) as {
          clipPath: string;
          clipUrl: string;
          clipStatus: string;
          clipDurationSeconds: number;
          clipModel: string;
          chainSkippedReason?: string;
        };
        if (data.chainSkippedReason) {
          console.warn(`[editor-store] chain skipped: ${data.chainSkippedReason}`);
        }
        dispatch({
          type: "patchShot",
          shotId,
          patch: {
            clipPath: data.clipPath,
            clipUrl: data.clipUrl,
            clipStatus: "done",
            clipDurationSeconds: data.clipDurationSeconds,
            clipModel: data.clipModel,
            // A fresh clip invalidates any previous SFX (server did the same).
            sfxPath: null,
            sfxStatus: "pending",
            sfxUrl: null,
          },
        });
      } catch (err) {
        console.error("[editor-store] clip generation error:", err);
        dispatch({ type: "patchShot", shotId, patch: { clipStatus: "failed" } });
      }
    },
    [projectId],
  );

  const generateSfx = useCallback(
    async (shotId: string, prompt?: string) => {
      dispatch({ type: "patchShot", shotId, patch: { sfxStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/sfx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prompt?.trim() ? { prompt: prompt.trim() } : {}),
        });
        if (!res.ok) {
          console.warn("[editor-store] sfx generation failed:", await res.text());
          dispatch({ type: "patchShot", shotId, patch: { sfxStatus: "failed" } });
          return;
        }
        const data = (await res.json()) as { sfxPath: string; sfxUrl: string };
        dispatch({
          type: "patchShot",
          shotId,
          patch: { sfxPath: data.sfxPath, sfxUrl: data.sfxUrl, sfxStatus: "done" },
        });
      } catch (err) {
        console.error("[editor-store] sfx generation error:", err);
        dispatch({ type: "patchShot", shotId, patch: { sfxStatus: "failed" } });
      }
    },
    [projectId],
  );

  const removeSfx = useCallback(
    async (shotId: string) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/sfx`, {
          method: "DELETE",
        });
        if (!res.ok) {
          console.warn("[editor-store] sfx removal failed:", await res.text());
          return;
        }
        dispatch({
          type: "patchShot",
          shotId,
          patch: { sfxPath: null, sfxUrl: null, sfxStatus: "pending" },
        });
      } catch (err) {
        console.error("[editor-store] sfx removal error:", err);
      }
    },
    [projectId],
  );
```

Update the context interface (`generateClip(shotId: string, model?: string): Promise<void>`, add `generateSfx`/`removeSfx` signatures) and add both new callbacks to the provider value object next to `generateClip`.

- [ ] **Step 3: Serialize the new fields**

`src/app/api/projects/[id]/shots/route.ts` (GET, in the shot mapper next to `clipUrl`):

```ts
      clipModel: shot.clipModel,
      chainToNext: shot.chainToNext,
      sfxPath: shot.sfxPath,
      sfxStatus: shot.sfxStatus ?? "pending",
      sfxUrl: shot.sfxPath ? await getDownloadUrl(shot.sfxPath) : null,
```

`src/app/projects/[id]/page.tsx` (server shot mapper, same five lines in the same style as the existing `clipUrl` line).

Also in `recommendShots` in `editor-store.tsx` (~line 538), extend the client-only null-out so new rows are well-formed:

```ts
      const shots = data.shots.map((s) => ({ ...s, imageUrl: null, clipUrl: null, sfxUrl: null }));
```

- [ ] **Step 4: Fix the now-broken inspector call site (temporary)**

`inspector.tsx:674` calls `generateClip(shot.id, "ltx")` and `:695` `generateClip(shot.id, "hailuo")`. Task 11 rebuilds this UI; to keep the build green in THIS commit, change line 674 to `generateClip(shot.id)` and delete the whole Hailuo `<Button>` block (lines 691–709).

- [ ] **Step 5: Verify build**

Run: `npm run lint && npm run test`
Expected: clean / PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/editor-store.tsx "src/app/api/projects/[id]/shots/route.ts" "src/app/projects/[id]/page.tsx" src/components/editor/inspector.tsx
git commit -m "feat(clip-engine-v2): editor store + serializers for model, chaining, SFX"
```

---

### Task 11: Inspector UI — model dropdown, chain toggle, SFX controls

**Files:**
- Modify: `src/components/editor/inspector.tsx` (the "Asset generation" block, ~lines 653–717, inside the shot inspector component)

**Interfaces:**
- Consumes: `CLIP_MODELS`, `DEFAULT_CLIP_MODEL_ID`, `getClipModel` from `@/lib/clip-models` (safe in client code — it's a pure constant module); store API from Task 10; `updateShot` (existing); `shots` array from the store (to find the next shot for the chain thumbnail).
- Produces: the UI surface verified by test cases TC-UI-1..5 in `docs/feature18/test-case.md`.

- [ ] **Step 1: Add imports and local state**

At the top of `inspector.tsx`:

```ts
import { CLIP_MODELS, DEFAULT_CLIP_MODEL_ID, getClipModel } from "@/lib/clip-models";
import { Music, X } from "lucide-react";
```

Inside the shot-inspector component (near the other `useState` calls), add — `shots` is already available from `useEditor()` (extend the destructure with `shots`, `generateSfx`, `removeSfx` as needed):

```ts
  const [clipModelId, setClipModelId] = useState(shot.clipModel ?? DEFAULT_CLIP_MODEL_ID);
  const [sfxPrompt, setSfxPrompt] = useState("");
  const selectedModel = getClipModel(clipModelId) ?? getClipModel(DEFAULT_CLIP_MODEL_ID)!;
  const sortedShots = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
  const nextShot = sortedShots[sortedShots.findIndex((s) => s.id === shot.id) + 1] ?? null;
  const chainDisabledReason = !selectedModel.supportsEndFrame
    ? `${selectedModel.label} can't take an end frame — pick Kling to chain`
    : !nextShot
      ? "Last shot — nothing to chain into"
      : null;
```

And keep `clipModelId` in sync when the selection changes shots:

```ts
  useEffect(() => {
    setClipModelId(shot.clipModel ?? DEFAULT_CLIP_MODEL_ID);
    setSfxPrompt("");
  }, [shot.id, shot.clipModel]);
```

- [ ] **Step 2: Replace the clip buttons with dropdown + single button + chain toggle + SFX block**

Replace everything from the `Clip (LTX)` button through the end of the Hailuo button (i.e. the two clip `<Button>`s inside the "Asset generation" `div`, keeping the Image button) with:

```tsx
        <Button
          size="sm"
          variant="default"
          className="flex-1"
          onClick={() => generateClip(shot.id, clipModelId)}
          disabled={!shot.imagePath || shot.clipStatus === "generating"}
          title={
            !shot.imagePath
              ? "Generate image first"
              : `${shot.clipPath ? "Regenerate" : "Generate"} clip with ${selectedModel.label} (~$${selectedModel.estUsdPerClip.toFixed(2)})`
          }
        >
          {shot.clipStatus === "generating" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Film className="mr-1 h-3 w-3" />
          )}
          {shot.clipPath ? "Re-clip" : "Clip"}
        </Button>
      </div>

      {/* Clip model + chaining */}
      <div className="space-y-1.5">
        <select
          value={clipModelId}
          onChange={(e) => {
            setClipModelId(e.target.value);
            updateShot(shot.id, { clipModel: e.target.value });
          }}
          className="w-full rounded border bg-background p-1.5 text-xs"
          title={selectedModel.whenToUse}
        >
          {CLIP_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — ~${m.estUsdPerClip.toFixed(2)}
              {m.supportsEndFrame ? " · chains" : ""}
              {m.nativeAudio ? " · audio" : ""}
            </option>
          ))}
        </select>
        <p className="text-[10px] text-muted-foreground">{selectedModel.whenToUse}</p>

        <label
          className="flex items-center gap-2 text-xs"
          title={chainDisabledReason ?? "End this clip on the next shot's image for a seamless cut"}
        >
          <input
            type="checkbox"
            checked={shot.chainToNext && !chainDisabledReason}
            disabled={!!chainDisabledReason}
            onChange={(e) => updateShot(shot.id, { chainToNext: e.target.checked })}
          />
          Chain to next shot
          {shot.chainToNext && !chainDisabledReason && nextShot?.imageUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={nextShot.imageUrl}
              alt="Next shot's image (this clip's end frame)"
              className="ml-auto h-8 w-14 rounded object-cover"
            />
          )}
        </label>
        {chainDisabledReason && (
          <p className="text-[10px] text-muted-foreground">{chainDisabledReason}</p>
        )}
      </div>

      {/* SFX */}
      {shot.clipPath && shot.clipStatus === "done" && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <input
              value={sfxPrompt}
              onChange={(e) => setSfxPrompt(e.target.value)}
              maxLength={500}
              placeholder="Optional: steer the SFX (e.g. ticking clock, bell chime)"
              className="min-w-0 flex-1 rounded border bg-background p-1.5 text-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => generateSfx(shot.id, sfxPrompt)}
              disabled={shot.sfxStatus === "generating"}
              title="Generate synced sound effects with MMAudio (~$0.01) — the clip itself is untouched"
            >
              {shot.sfxStatus === "generating" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Music className="mr-1 h-3 w-3" />
              )}
              {shot.sfxPath ? "Re-roll SFX" : "Add SFX"}
            </Button>
            {shot.sfxPath && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => removeSfx(shot.id)}
                title="Remove SFX (keeps the clip)"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          {shot.sfxStatus === "failed" && (
            <p className="text-[10px] text-destructive">SFX generation failed. Retry above.</p>
          )}
        </div>
      )}
```

(The opening `<div className="flex gap-2 pt-1">` with the Image button stays; the snippet above closes it after the single clip button and adds the two new blocks as siblings.)

- [ ] **Step 3: Verify build + visual check**

Run: `npm run lint` → clean. Start `npm run dev`, open a project with shots, select a shot: dropdown shows 3 models with prices; guidance line updates on change; chain toggle disables with reason on LTX/Veo or last shot; SFX block appears only when a clip exists.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/inspector.tsx
git commit -m "feat(clip-engine-v2): inspector model dropdown, chain toggle, SFX controls"
```

---

### Task 12: Playback — prefer the SFX variant, unmuted

**Files:**
- Modify: `src/components/editor/unified-editor.tsx` (preview video effect, ~lines 483–520)
- Modify: `src/components/editor/inspector.tsx` (the two `<video>` previews at ~lines 252 and 478)

**Interfaces:**
- Consumes: `EditorShot.sfxUrl` (Task 10).
- Produces: everywhere a clip plays: `src = shot.sfxUrl ?? shot.clipUrl`, muted only when there is no SFX.

- [ ] **Step 1: unified-editor timeline preview**

In the effect that assigns the preview video source (~line 485), compute the effective URL and muted state:

```ts
    const activeClipUrl = playheadShot?.sfxUrl ?? playheadShot?.clipUrl ?? null;
```

Use `activeClipUrl` wherever the effect currently reads `playheadShot.clipUrl` (the src comparison and assignment at lines ~491–492, the play/pause guards at ~508/517, and the effect dependency array), and set `v.muted = !playheadShot?.sfxUrl;` right where `v.src` is assigned. Keep the `muted` attribute off the JSX `<video>` element at line ~558 IN PLACE for initial render, since the effect overrides it (autoplay policies need the first paint muted).

The two JSX fallbacks that check `!playheadShot?.clipUrl` (~lines 558, 569) keep checking `clipUrl` — a shot with SFX always has a clip.

- [ ] **Step 2: inspector previews**

Line ~252:

```tsx
      {shot.clipUrl ? (
        <video
          key={shot.id}
          src={shot.sfxUrl ?? shot.clipUrl}
          autoPlay
          muted={!shot.sfxUrl}
          loop
          className="w-full rounded"
        />
```

Line ~478 (the mode-switched preview): same change — `src={shot.sfxUrl ?? shot.clipUrl}`, `muted={!shot.sfxUrl}`, and change `key={shot.clipUrl}` to `key={shot.sfxUrl ?? shot.clipUrl}` so the element remounts when SFX lands.

- [ ] **Step 3: Verify**

Run: `npm run lint` → clean. Live check happens in Task 16 (needs a real SFX asset).

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/unified-editor.tsx src/components/editor/inspector.tsx
git commit -m "feat(clip-engine-v2): play SFX clip variant unmuted in previews"
```

---

### Task 13: Chain suggestion library

**Files:**
- Create: `src/lib/chain-suggestion.ts`
- Test: `tests/unit/chain-suggestion.test.ts`

**Interfaces:**
- Consumes: Anthropic SDK (same pattern as `src/app/api/projects/[id]/shots/suggest-motion/route.ts`).
- Produces (used by Task 14):
  - `interface ChainPair { shotId: string; nextShotId: string; sameBeat: boolean; sharedEntityIds: string[] }`
  - `function buildChainPairs(shots: Array<{ id: string; sortOrder: number; beatId: string | null; imagePrompt: string; referencedEntityIds: string[] | null }>): ChainPair[]` — pure; adjacent pairs in sortOrder.
  - `function sanitizeChainSuggestions(suggestedIds: unknown, pairs: ChainPair[]): string[]` — pure; keeps only strings that are a `shotId` of some pair.
  - `async function suggestChains(shots: <same input>, projectBrief: string | null): Promise<string[]>` — returns shot ids whose `chainToNext` should be set true; one Haiku call; on any error returns `[]` (suggestion is best-effort, never fails the batch).

- [ ] **Step 1: Write the failing tests `tests/unit/chain-suggestion.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildChainPairs, sanitizeChainSuggestions } from "@/lib/chain-suggestion";

const shot = (id: string, sortOrder: number, beatId: string, entities: string[] = []) => ({
  id,
  sortOrder,
  beatId,
  imagePrompt: `prompt ${id}`,
  referencedEntityIds: entities,
});

describe("buildChainPairs", () => {
  it("pairs adjacent shots by sortOrder with shared context", () => {
    const pairs = buildChainPairs([
      shot("c", 3, "b2", ["e1"]),
      shot("a", 1, "b1", ["e1", "e2"]),
      shot("b", 2, "b1", ["e2"]),
    ]);
    expect(pairs).toEqual([
      { shotId: "a", nextShotId: "b", sameBeat: true, sharedEntityIds: ["e2"] },
      { shotId: "b", nextShotId: "c", sameBeat: false, sharedEntityIds: [] },
    ]);
  });

  it("returns [] for fewer than two shots", () => {
    expect(buildChainPairs([shot("a", 1, "b1")])).toEqual([]);
    expect(buildChainPairs([])).toEqual([]);
  });

  it("tolerates null referencedEntityIds", () => {
    const pairs = buildChainPairs([
      { ...shot("a", 1, "b1"), referencedEntityIds: null },
      shot("b", 2, "b1"),
    ]);
    expect(pairs[0].sharedEntityIds).toEqual([]);
  });
});

describe("sanitizeChainSuggestions", () => {
  const pairs = buildChainPairs([shot("a", 1, "b1"), shot("b", 2, "b1"), shot("c", 3, "b1")]);

  it("keeps only ids that are a pair's first shot", () => {
    expect(sanitizeChainSuggestions(["a", "c", "zzz", 42, null], pairs)).toEqual(["a"]);
    // "c" is only ever a nextShotId (last shot) — chaining it is invalid
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeChainSuggestions("a", pairs)).toEqual([]);
    expect(sanitizeChainSuggestions(undefined, pairs)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test`
Expected: FAIL — cannot resolve `@/lib/chain-suggestion`

- [ ] **Step 3: Create `src/lib/chain-suggestion.ts`**

```ts
/**
 * AI chain suggestions for batch "Generate all" (Clip Engine v2). One Haiku
 * call classifies each adjacent shot pair: should the earlier shot's clip
 * end on the next shot's image ("chain")? Criteria: same scene/subject,
 * continuous action — chains across scene cuts produce morphy interpolation,
 * so the prompt is conservative. Best-effort: any failure returns [] and the
 * batch proceeds unchained.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface ChainPair {
  shotId: string;
  nextShotId: string;
  sameBeat: boolean;
  sharedEntityIds: string[];
}

interface ChainShotInput {
  id: string;
  sortOrder: number;
  beatId: string | null;
  imagePrompt: string;
  referencedEntityIds: string[] | null;
}

export function buildChainPairs(shots: ChainShotInput[]): ChainPair[] {
  const ordered = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
  const pairs: ChainPair[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const cur = ordered[i];
    const next = ordered[i + 1];
    const nextIds = new Set(next.referencedEntityIds ?? []);
    pairs.push({
      shotId: cur.id,
      nextShotId: next.id,
      sameBeat: cur.beatId !== null && cur.beatId === next.beatId,
      sharedEntityIds: (cur.referencedEntityIds ?? []).filter((e) => nextIds.has(e)),
    });
  }
  return pairs;
}

export function sanitizeChainSuggestions(suggestedIds: unknown, pairs: ChainPair[]): string[] {
  if (!Array.isArray(suggestedIds)) return [];
  const valid = new Set(pairs.map((p) => p.shotId));
  return suggestedIds.filter((id): id is string => typeof id === "string" && valid.has(id));
}

const CHAIN_TOOL: Anthropic.Tool = {
  name: "save_chain_suggestions",
  description: "Save which shots should chain into their next shot.",
  input_schema: {
    type: "object" as const,
    properties: {
      chained_shot_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Ids of shots whose clip should END on the next shot's image. Only include a pair when both stills clearly show the same scene and subject with continuous action between them. When in doubt, leave it out — a hard cut beats a morphy interpolation.",
      },
    },
    required: ["chained_shot_ids"],
  },
};

export async function suggestChains(
  shots: ChainShotInput[],
  projectBrief: string | null,
): Promise<string[]> {
  const pairs = buildChainPairs(shots);
  if (pairs.length === 0) return [];

  const byId = new Map(shots.map((s) => [s.id, s]));
  const pairList = pairs
    .map((p, i) => {
      const a = byId.get(p.shotId)!;
      const b = byId.get(p.nextShotId)!;
      return `Pair ${i + 1} — shot id "${p.shotId}"\n  A: ${a.imagePrompt}\n  B: ${b.imagePrompt}\n  same narration beat: ${p.sameBeat}, shared tagged entities: ${p.sharedEntityIds.length}`;
    })
    .join("\n\n");

  try {
    const anthropic = new Anthropic();
    const stream = anthropic.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: `You decide which adjacent shot pairs in an AI video should be "chained": the earlier clip animates from its own still INTO the next shot's still, so the cut is seamless. Chain ONLY pairs that show the same scene and subject with continuous action. Different locations, subjects, or time jumps must NOT chain.${projectBrief ? `\n\nThe video is about: ${projectBrief}` : ""}\n\nReturn via the save_chain_suggestions tool.`,
      tools: [CHAIN_TOOL],
      tool_choice: { type: "tool", name: "save_chain_suggestions" },
      messages: [{ role: "user", content: `Adjacent shot pairs:\n\n${pairList}` }],
    });
    const response = await stream.finalMessage();
    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === "save_chain_suggestions",
    );
    if (!toolUse || toolUse.type !== "tool_use") return [];
    const { chained_shot_ids } = toolUse.input as { chained_shot_ids: unknown };
    return sanitizeChainSuggestions(chained_shot_ids, pairs);
  } catch (error) {
    console.error("[chain-suggestion] failed, proceeding unchained:", error);
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/chain-suggestion.ts tests/unit/chain-suggestion.test.ts
git commit -m "feat(clip-engine-v2): Haiku chain suggestions with pure pair/sanitize logic"
```

---

### Task 14: Batch — route, orchestrator, preview, dialog

**Files:**
- Modify: `src/app/api/projects/[id]/generate-all/route.ts` (body fields + event data)
- Modify: `src/inngest/functions/generate-batch.ts` (model threading, chain-suggestion step, SFX wave)
- Modify: `src/app/api/projects/[id]/generate-all/preview/route.ts` (query params → cost opts)
- Modify: `src/components/editor/generate-all-dialog.tsx` (model dropdown + 2 checkboxes)
- Modify: `src/components/editor/editor-store.tsx` (`fetchGenerateAllPreview` + `generateAll` signatures)

**Interfaces:**
- Consumes: Tasks 2, 4, 6, 8, 13.
- Produces:
  - `POST /generate-all` body: `{ includeClips: boolean; clipModel?: ClipModelId; suggestChains?: boolean; includeSfx?: boolean }` — the three new fields only meaningful with `includeClips: true`; event data `project/batch.generate` carries all four.
  - `GET /generate-all/preview?clipModel=<id>&includeSfx=<bool>` → response gains `sfx: { count, estUsd }` (count = clip count when includeSfx, else 0).
  - Store: `fetchGenerateAllPreview(opts?: { clipModel?: string; includeSfx?: boolean })`, `generateAll(opts: { includeClips: boolean; clipModel?: string; suggestChains?: boolean; includeSfx?: boolean })`.

- [ ] **Step 1: generate-all route body + event**

In `generate-all/route.ts`, replace the body-parsing block with:

```ts
  let includeClips = false;
  let clipModel: string | undefined;
  let suggestChains = false;
  let includeSfx = false;
  try {
    const body = (await request.json()) as {
      includeClips?: unknown;
      clipModel?: unknown;
      suggestChains?: unknown;
      includeSfx?: unknown;
    };
    if (typeof body.includeClips !== "boolean") {
      return badRequestResponse("includeClips must be a boolean");
    }
    includeClips = body.includeClips;
    if (body.clipModel !== undefined) {
      if (!isClipModelId(body.clipModel)) return badRequestResponse("Unknown clip model");
      clipModel = body.clipModel;
    }
    if (body.suggestChains !== undefined) {
      if (typeof body.suggestChains !== "boolean") {
        return badRequestResponse("suggestChains must be a boolean");
      }
      suggestChains = body.suggestChains;
    }
    if (body.includeSfx !== undefined) {
      if (typeof body.includeSfx !== "boolean") {
        return badRequestResponse("includeSfx must be a boolean");
      }
      includeSfx = body.includeSfx;
    }
  } catch {
    return badRequestResponse("Invalid request body");
  }
```

with import `import { isClipModelId } from "@/lib/clip-models";`, and extend the event send:

```ts
  await inngest.send({
    name: "project/batch.generate",
    data: { projectId: id, includeClips, clipModel, suggestChains, includeSfx },
  });
```

Update the header comment's Body description.

- [ ] **Step 2: Orchestrator — model, chains, SFX**

In `src/inngest/functions/generate-batch.ts`:

Extend the event destructure:

```ts
    const { projectId, includeClips, clipModel, suggestChains, includeSfx } = event.data as {
      projectId: string;
      includeClips: boolean;
      clipModel?: string;
      suggestChains?: boolean;
      includeSfx?: boolean;
    };
```

Immediately BEFORE the wave-3 `if (includeClips)` block, add the chain-suggestion step (runs after wave 2 so it can also be reused later with image context; it needs only prompts/beats/entities which exist from the start):

```ts
    // ── Chain suggestions (optional, before clips) ──
    let chainsApplied = 0;
    if (includeClips && suggestChains) {
      chainsApplied = await step.run("suggest-chains", async () => {
        const [project] = await db
          .select({ brief: projects.brief })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        const shotRows = await db
          .select({
            id: shots.id,
            sortOrder: shots.sortOrder,
            beatId: shots.beatId,
            imagePrompt: shots.imagePrompt,
            referencedEntityIds: shots.referencedEntityIds,
          })
          .from(shots)
          .where(eq(shots.projectId, projectId));
        const ids = await suggestChains(shotRows, project?.brief ?? null);
        if (ids.length > 0) {
          await db.update(shots).set({ chainToNext: true }).where(inArray(shots.id, ids));
        }
        return ids.length;
      });
    }
```

with imports `inArray` (from drizzle-orm) and `suggestChains` from `@/lib/chain-suggestion`, and `generateShotSfx` from `@/lib/sfx-generation`. NOTE the local `chainsApplied` variable vs imported `suggestChains` function — the flag from event data is named `suggestChains` too, so RENAME the destructured flag: `suggestChains: suggestChainsFlag` in the destructure and use `suggestChainsFlag` in the condition (keep the import name clean).

Inside wave 3, pass the model through:

```ts
                await generateShotClip(row.project, row.shot, { model: clipModel });
```

AFTER wave 3's `for` loop (still inside `if (includeClips)`), add wave 4:

```ts
      // ── Wave 4: SFX (optional) — only shots whose clip is now done ──
      if (includeSfx) {
        const sfxShotIds = await step.run("compute-sfx-targets", async () => {
          const rows = await db
            .select({ id: shots.id, clipStatus: shots.clipStatus, sfxStatus: shots.sfxStatus })
            .from(shots)
            .where(eq(shots.projectId, projectId));
          return rows
            .filter((s) => s.clipStatus === "done" && s.sfxStatus !== "done")
            .map((s) => s.id);
        });

        for (const chunk of chunked(sfxShotIds, CHUNK_SIZE)) {
          const results = await Promise.all(
            chunk.map((shotId) =>
              step.run(`sfx-${shotId}`, async () => {
                try {
                  const [row] = await db
                    .select({ shot: shots, project: projects })
                    .from(shots)
                    .innerJoin(projects, eq(shots.projectId, projects.id))
                    .where(and(eq(shots.id, shotId), eq(projects.id, projectId)))
                    .limit(1);
                  if (!row) return { ok: false };
                  if (row.shot.sfxStatus === "done" || row.shot.sfxStatus === "generating") {
                    return { ok: true, skipped: true };
                  }
                  if (!row.shot.clipPath || row.shot.clipStatus !== "done") {
                    return { ok: true, skipped: true };
                  }
                  await generateShotSfx(row.project, row.shot);
                  return { ok: true };
                } catch (err) {
                  console.error(`[batch] sfx failed shot=${shotId}:`, err);
                  return { ok: false };
                }
              }),
            ),
          );
          sfxFailed += results.filter((r) => !r.ok).length;
        }
      }
```

Declare `let sfxFailed = 0;` next to `let clipsFailed = 0;` and add to the return object:

```ts
      chains: { applied: chainsApplied },
      sfx: { failed: sfxFailed },
```

Update the file's header comment (four waves, chain suggestions, model threading).

- [ ] **Step 3: Preview route params**

In `generate-all/preview/route.ts`, read query params and pass opts (change `_request` to `request`):

```ts
  const url = new URL(request.url);
  const clipModelParam = url.searchParams.get("clipModel");
  if (clipModelParam !== null && !isClipModelId(clipModelParam)) {
    return badRequestResponse("Unknown clip model");
  }
  const includeSfx = url.searchParams.get("includeSfx") === "true";

  const targets = await computeBatchTargets(id);
  const cost = estimateBatchCost(
    {
      sheets: targets.sheetEntityIds.length,
      images: targets.imageShotIds.length,
      clips: targets.clipShotIds.length,
    },
    { clipModelId: clipModelParam ?? undefined, includeSfx },
  );
```

and add to the response:

```ts
    sfx: { count: includeSfx ? targets.clipShotIds.length : 0, estUsd: cost.sfxUsd },
```

with import `isClipModelId` from `@/lib/clip-models`.

- [ ] **Step 4: Store — preview + dispatch signatures**

In `editor-store.tsx`, change `fetchGenerateAllPreview` to accept opts and append query params:

```ts
  const fetchGenerateAllPreview = useCallback(
    async (opts?: { clipModel?: string; includeSfx?: boolean }): Promise<GenerateAllPreview | null> => {
      try {
        const qs = new URLSearchParams();
        if (opts?.clipModel) qs.set("clipModel", opts.clipModel);
        if (opts?.includeSfx) qs.set("includeSfx", "true");
        const res = await fetch(
          `/api/projects/${projectId}/generate-all/preview${qs.size ? `?${qs}` : ""}`,
        );
        if (!res.ok) return null;
        return (await res.json()) as GenerateAllPreview;
      } catch {
        return null;
      }
    },
    [projectId],
  );
```

(Preserve the existing body/error behavior if the current implementation differs — only the signature and URL change.)

Change `generateAll` to take an options object and forward it:

```ts
  const generateAll = useCallback(
    async (opts: {
      includeClips: boolean;
      clipModel?: string;
      suggestChains?: boolean;
      includeSfx?: boolean;
    }): Promise<boolean> => {
```

with `body: JSON.stringify(opts)` in the POST, and update the context interface for both.

- [ ] **Step 5: Dialog UI**

In `generate-all-dialog.tsx`:

Add state + imports:

```ts
import { CLIP_MODELS, DEFAULT_CLIP_MODEL_ID } from "@/lib/clip-models";
```

```ts
  const [clipModel, setClipModel] = useState<string>(DEFAULT_CLIP_MODEL_ID);
  const [suggestChains, setSuggestChains] = useState(true);
  const [includeSfx, setIncludeSfx] = useState(false);
```

Refetch the preview whenever the selection changes (replace the existing effect's fetch call):

```ts
  useEffect(() => {
    if (!open) return;
    setError(false);
    setLoading(true);
    fetchGenerateAllPreview({ clipModel, includeSfx })
      .then((p) => {
        setPreview(p);
        if (!p) setError(true);
      })
      .finally(() => setLoading(false));
  }, [open, clipModel, includeSfx, fetchGenerateAllPreview]);
```

(Keep the separate on-open reset of `includeClips`/`preview` from the original effect — move `setPreview(null); setIncludeClips(false); setIncludeSfx(false);` into an `if (!open) return;`-guarded effect keyed on `[open]` only, so toggling options doesn't reset the clips checkbox.)

Under the clips checkbox row, add (all inside the existing `{preview && (...)}` block):

```tsx
            {includeClips && (
              <div className="space-y-2 pl-6">
                <select
                  value={clipModel}
                  onChange={(e) => setClipModel(e.target.value)}
                  className="w-full rounded border bg-background p-1.5 text-xs"
                >
                  {CLIP_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — ~${m.estUsdPerClip.toFixed(2)}/clip
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={suggestChains}
                    onChange={(e) => setSuggestChains(e.target.checked)}
                  />
                  Let AI suggest chained shots (seamless cuts, models that support it)
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={includeSfx}
                      onChange={(e) => setIncludeSfx(e.target.checked)}
                    />
                    Add SFX to all clips
                  </span>
                  <span className="font-mono">
                    {includeSfx ? `~$${preview.sfx.estUsd.toFixed(2)}` : "—"}
                  </span>
                </label>
              </div>
            )}
```

and change the confirm handler:

```ts
    const ok = await generateAll({
      includeClips,
      ...(includeClips ? { clipModel, suggestChains, includeSfx } : {}),
    });
```

- [ ] **Step 6: Verify**

Run: `npm run lint && npm run test` → clean / PASS.
Live: open the dialog on a project with missing clips — switching model changes the clips estimate; checking SFX adds its line to the total.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/projects/[id]/generate-all" src/inngest/functions/generate-batch.ts src/components/editor/generate-all-dialog.tsx src/components/editor/editor-store.tsx
git commit -m "feat(clip-engine-v2): batch model threading, AI chain suggestions, SFX wave"
```

---

### Task 15: Motion-prompt enrichment

**Files:**
- Modify: `src/app/api/projects/[id]/shots/suggest-motion/route.ts` (tool description + system prompt only)

**Interfaces:**
- Produces: same API shape; richer `motionPrompt` text.

- [ ] **Step 1: Replace the MOTION_TOOL description**

```ts
      motion_prompt: {
        type: "string",
        description:
          "Describe what HAPPENS over the clip (~5-6 seconds) in 2-3 phases so video models can follow it: (1) the subject's action and how it evolves — start state, movement, end state (e.g. 'The pendulum swings rapidly, decelerates, and settles pointing at 12'); (2) an optional subtle camera move; (3) pacing (where the motion is fast vs. settled). REQUIRED: a subject action. Avoid dramatic zooms and 'slow pan' clichés. If no subject action fits the still, keep camera motion minimal.",
      },
```

- [ ] **Step 2: Update the system prompt sentence**

```ts
      system: `You suggest a single motion prompt for one shot in an AI video editor. Motion prompts describe what HAPPENS in the shot over ~5-6 seconds as a short phased action (start state → movement → end state) — prefer subject action over camera moves, and make the phases explicit so image-to-video models can follow them.${projectContext}\n\nReturn via the save_motion_prompt tool.`,
```

- [ ] **Step 3: Verify + commit**

Run: `npm run lint` → clean. Live check: "AI suggest" on a shot returns a phased motion prompt.

```bash
git add "src/app/api/projects/[id]/shots/suggest-motion/route.ts"
git commit -m "feat(clip-engine-v2): phased motion-prompt suggestions"
```

---

### Task 16: Feature docs + live verification + pre-commit checklist

**Files:**
- Create: `docs/feature18/feature.md` (follow `feature-playbook.md` structure)
- Create: `docs/feature18/test-case.md`

- [ ] **Step 1: Write `docs/feature18/feature.md`**

Follow `feature-playbook.md` exactly (look at `docs/feature17/feature.md` for the established shape). Content: summary of Clip Engine v2 (registry, chaining, SFX, batch integration), architecture (the modules created in Tasks 2–14 with one line each), data-model changes (4 columns), security notes (registry allow-list, prompt cap, route stack), cost notes (per-model estimates + SFX), and the two known limitations from the spec (stale chained clips after neighbor image regen; morphy chains across scene cuts).

- [ ] **Step 2: Write `docs/feature18/test-case.md`**

Every case needs acceptance criteria, expected outcome, and edge cases. Cover at minimum:
- **TC-U-1..4 (automated)**: the four vitest suites (registry, chaining, costs, chain-suggestion) — reference the test files.
- **TC-API-1**: POST clip with `{"model":"kling-2.5-turbo-pro"}` → 200, `clipModel` persisted; with `{"model":"bogus"}` → 400; with no body → 200 default model.
- **TC-API-2**: POST sfx before clip exists → 400; after clip → 200 and `clip.mp4` unchanged (same ETag in R2); DELETE sfx → object gone, status pending.
- **TC-API-3**: PATCH shot `{"chainToNext":true}` → persisted; `{"clipModel":"bogus"}` → 400.
- **TC-CHAIN-1 (paid)**: two same-scene shots, chain on, Kling → clip N's final frame visually matches shot N+1's image; regenerating shot N+1's image does NOT touch clip N (documented limitation).
- **TC-CHAIN-2**: chain on + LTX selected → clip generates unchained, response has `chainSkippedReason: "model-no-end-frame"`.
- **TC-SFX-1 (paid)**: MMAudio round-trip; preview plays the SFX variant unmuted; re-roll replaces audio, clip identical.
- **TC-BATCH-1 (paid, throwaway project)**: generate-all with Kling + suggestChains + SFX on a 3-shot project → cost preview matches registry math; chains applied only to same-scene pairs; SFX wave runs after clips; failed items don't halt the batch.
- **TC-UI-1..5**: dropdown contents/pricing, guidance line, chain toggle disabled states (LTX, last shot), next-shot thumbnail, SFX controls visibility.

- [ ] **Step 3: Run the paid smoke tests (STOP: get user go-ahead first)**

These bill real money (~$2–4 total: one clip per model, one chained pair, one SFX pass, one 3-shot batch). Use the established throwaway-project pattern. Ask the user before running; record actual observed costs in `docs/feature18/feature.md`.

- [ ] **Step 4: Pre-commit checklist (from CLAUDE.md)**

Walk every item: no hardcoded secrets; auth+authz on every mutation (clip, sfx POST/DELETE, PATCH, generate-all); inputs validated at boundaries (model ids, prompt cap, booleans); explicit error handling matching the existing `{ error, status }` shape; functions <150 LOC; no dead code (`grep -rn "clip-hailuo\|CLIP_EST_USD" src/` → empty); naming/folder patterns consistent; no parallel abstractions (single registry, single upload helper).

- [ ] **Step 5: Final verification + commit**

Run: `npm run lint && npm run test && npm run build` → all green.

```bash
git add docs/feature18
git commit -m "docs(clip-engine-v2): feature18 documentation + test cases"
```

Then follow superpowers:finishing-a-development-branch (merge + push to master per user's workflow preference).
