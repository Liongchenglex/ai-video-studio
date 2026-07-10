# Directing Controls (Clip Engine v3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Structured directing controls per the approved spec `docs/superpowers/specs/2026-07-10-directing-controls-design.md` — camera moves, negative prompts, duration auto-match, Kling v3 Pro as default, entity reference sheets riding into clips, and FLUX-Kontext frame staging (edit image in place + authored custom end frames), organized in the interactively locked inspector layout.

**Architecture:** The registry gains capability flags and per-second pricing so every control degrades per model (hard params vs prompt fallback vs skipped-with-note). All directing inputs live on the shot row; the clip service resolves them (end frame → camera → refs → duration) and delegates shapes to `buildInput`. `ends_on` (`free|next|custom`) supersedes `chain_to_next`. A new frame-edit service reuses the Kontext image-editing endpoint for both start-frame staging and custom end frames.

**Tech Stack:** Next.js 15 App Router, Drizzle + Postgres (`npm run db:push`), `@fal-ai/client`, Inngest, Vitest (exists: `npm run test`, tests/unit/).

## Global Constraints

- Security stack order on every new/changed mutation route: `applyRateLimit` → `verifyCsrf` → `getSession` → UUID validation → ownership join (copy from `src/app/api/projects/[id]/shots/[shotId]/sfx/route.ts`).
- Every file starts with a header block comment (tests included).
- Client-supplied values validated against allow-lists: camera enums, `ends_on` enum, duration positive int 1–15, prompt/instruction strings ≤ 500 chars. Model ids via registry as today. Reference image URLs are always server-derived from owned entities — never client-supplied.
- Instructions/negative prompts forwarded only to fal; never in R2 keys or full-text logs.
- Every directing input degrades independently and loudly (skip notes), never fails the clip; hard failures remain the fal call only.
- Cost figures are estimates labeled "~"; per-second prices verified against fal live docs at implementation.
- "Next shot" is always timeline order via `orderShotsByTimeline` — never `sortOrder` queries.
- `chain_to_next` is dropped only in Task 16, after every reader is migrated.
- Copy (verbatim): group labels `Image — what we see`, `Action — what happens in the shot`, `Clip — engine settings`, `Sound`; control labels `Camera move`, `Ends on` (`Free | Next shot | Custom…`), `Cast & locations featured`, `Length`; action-prompt placeholder `e.g. "the boat sails toward the horizon"`; tag helper `★ primary · sheets condition the image and the clip`; project negative-prompt seed `blur, warping, morphing, distorted faces, extra limbs, text artifacts`.
- Locked layout reference: `.superpowers/brainstorm/22323-1783695100/content/inspector-layout-v3.html`.

---

# STAGE 1 — Engine + structured controls (Tasks 1–11, independently shippable)

### Task 1: Registry shape v3 — durations, per-second pricing, capability flags

**Files:**
- Modify: `src/lib/clip-models.ts`
- Modify: `tests/unit/clip-models.test.ts`
- Modify: `src/lib/generation-costs.ts` (only the `estUsdPerClip` read)
- Modify: `src/components/editor/inspector.tsx` + `src/components/editor/generate-all-dialog.tsx` (only the `estUsdPerClip` reads)

**Interfaces:**
- Consumes: current `ClipModelSpec` (has `durationSeconds`, `estUsdPerClip`, `supportsEndFrame`, `nativeAudio`, `whenToUse`, `buildInput`).
- Produces (used by every later task):
  - `ClipModelSpec` gains `durations: number[]`, `estUsdPerSecond: number`, `supportsCameraControl: boolean`, `supportsReferences: boolean`, `supportsNegativePrompt: boolean`. `durationSeconds` KEPT as the default/fallback duration. `estUsdPerClip` REMOVED.
  - `function estClipUsd(spec: Pick<ClipModelSpec,"estUsdPerSecond"|"durationSeconds">, seconds?: number): number` — `round2(estUsdPerSecond * (seconds ?? durationSeconds))`.
  - `buildInput` args gain optional `camera?: { move: CameraMove; strength: CameraStrength }`, `negativePrompt?: string`, `durationSeconds?: number`, `referenceImageUrls?: string[]` (types imported from Task 2's `clip-camera.ts` — declare the import as `import type { CameraMove, CameraStrength } from "@/lib/clip-camera"`; Task 2 creates the module, so within THIS task use inline string-literal types and switch to the import in Task 2. To keep this task self-contained, define locally: `export type CameraMove = "static"|"push-in"|"pull-back"|"pan-left"|"pan-right"|"tilt-up"|"tilt-down"|"orbit"; export type CameraStrength = "subtle"|"medium"|"strong";` in `clip-models.ts` — Task 2 re-exports them from `clip-camera.ts` and `clip-models.ts` switches to importing).

- [ ] **Step 1: Update the failing tests first** — in `tests/unit/clip-models.test.ts`: (a) replace every `estUsdPerClip` assertion with `estClipUsd`-based ones; (b) add:

```ts
  it("exposes per-second pricing, duration lists, and capability flags", () => {
    for (const m of CLIP_MODELS) {
      expect(m.estUsdPerSecond).toBeGreaterThan(0);
      expect(m.durations.length).toBeGreaterThan(0);
      expect(m.durations).toContain(m.durationSeconds);
      expect(typeof m.supportsCameraControl).toBe("boolean");
      expect(typeof m.supportsReferences).toBe("boolean");
      expect(typeof m.supportsNegativePrompt).toBe("boolean");
    }
  });

  it("estClipUsd prices by duration with the default as fallback", () => {
    const kling = getClipModel("kling-2.5-turbo-pro")!;
    expect(estClipUsd(kling)).toBe(0.42);        // 5s × $0.084
    expect(estClipUsd(kling, 10)).toBe(0.84);
    const ltx = getClipModel("ltx-2.3")!;
    expect(estClipUsd(ltx)).toBe(0.36);          // 6s × $0.06
  });

  it("Kling buildInput maps negative prompt and duration", () => {
    const kling = getClipModel("kling-2.5-turbo-pro")!;
    expect(
      kling.buildInput({ imageUrl: "a", prompt: "p", negativePrompt: "blur", durationSeconds: 10 }),
    ).toEqual({ image_url: "a", prompt: "p", duration: "10", negative_prompt: "blur" });
  });
```

- [ ] **Step 2: Run to verify failures** — `npm run test` → FAIL (`estClipUsd` undefined, missing fields).

- [ ] **Step 3: Implement in `src/lib/clip-models.ts`.** Add the two local types (above), extend the interface:

```ts
  /** All durations this model accepts, seconds. durationSeconds stays the default. */
  durations: number[];
  /** Display-only ballpark per output second. */
  estUsdPerSecond: number;
  supportsCameraControl: boolean;
  supportsReferences: boolean;
  supportsNegativePrompt: boolean;
  buildInput(args: {
    imageUrl: string;
    prompt: string;
    tailImageUrl?: string;
    camera?: { move: CameraMove; strength: CameraStrength };
    negativePrompt?: string;
    durationSeconds?: number;
    referenceImageUrls?: string[];
  }): Record<string, unknown>;
```

Update entries (delete `estUsdPerClip` everywhere):
- kling-2.5-turbo-pro: `durations: [5, 10]`, `estUsdPerSecond: 0.084`, `supportsCameraControl: false` (only the 2.6+ endpoints take camera params — Task 2 verifies; leave false here), `supportsReferences: false`, `supportsNegativePrompt: true`; buildInput adds `...(negativePrompt ? { negative_prompt: negativePrompt } : {})` and `duration: String(durationSeconds ?? 5)` (replacing the hardcoded `"5"`); ignores `camera`/`referenceImageUrls`.
- ltx-2.3: `durations: [6]`, `estUsdPerSecond: 0.06`, flags all false except `supportsEndFrame` (LTX takes no negative prompt — verify in Task 2; if fal's schema exposes one, flip the flag and map it there); buildInput unchanged otherwise.
- veo-3.1-fast: `durations: [8]`, `estUsdPerSecond: 0.15`, flags false; unchanged otherwise.

Add:

```ts
export function estClipUsd(
  spec: Pick<ClipModelSpec, "estUsdPerSecond" | "durationSeconds">,
  seconds?: number,
): number {
  return Math.round(spec.estUsdPerSecond * (seconds ?? spec.durationSeconds) * 100) / 100;
}
```

- [ ] **Step 4: Fix the three `estUsdPerClip` read sites** — `generation-costs.ts`: `clipModel.estUsdPerClip` → `estClipUsd(clipModel)` (duration-aware totals come in Task 4); `inspector.tsx` (dropdown option text, Generate title) and `generate-all-dialog.tsx` (option text): `m.estUsdPerClip.toFixed(2)` → `estClipUsd(m).toFixed(2)`.

- [ ] **Step 5: Verify** — `npm run test` (all suites PASS), `npx tsc --noEmit`, `npm run lint`.

- [ ] **Step 6: Commit** — `git add -A src tests && git commit -m "feat(directing): registry per-second pricing, duration lists, capability flags"`

---

### Task 2: Kling v3 Pro entry — verified against fal, new default

**Files:**
- Modify: `src/lib/clip-models.ts`
- Modify: `tests/unit/clip-models.test.ts`
- Create: `src/lib/clip-camera.ts` (types only moved here; logic in Task 3)

**Interfaces:**
- Produces: `ClipModelId` gains `"kling-v3-pro"`; `DEFAULT_CLIP_MODEL_ID = "kling-v3-pro"`; `clip-camera.ts` exports `CameraMove`, `CameraStrength` (re-exported from `clip-models.ts` for compat).

- [ ] **Step 1: Verify against fal live docs (no code).** WebFetch `https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api` and confirm/record: exact endpoint id; `start_image_url`; `end_image_url`; `elements` input shape (list of image URLs? objects?); `negative_prompt`; `duration` values 3–15 and encoding (string vs int); `generate_audio` toggle; whether hard `camera_control` params exist on v3 (also check the 2.6 pro page — if v3 lacks them but 2.6 has them, set `supportsCameraControl: true` on kling-2.5-turbo-pro ONLY if its endpoint actually accepts them, else leave camera prompt-fallback for all Kling until a supporting endpoint is added); per-second price from fal's pricing page (fallback estimate if undisclosed: $0.14/s — flag as unverified in the commit message). Record findings in your report; set every flag to verified reality.

- [ ] **Step 2: Failing tests:**

```ts
  it("Kling v3 Pro is the default and maps the full directing surface", () => {
    expect(DEFAULT_CLIP_MODEL_ID).toBe("kling-v3-pro");
    const v3 = getClipModel("kling-v3-pro")!;
    expect(v3.supportsEndFrame).toBe(true);
    expect(v3.supportsReferences).toBe(true);
    expect(v3.supportsNegativePrompt).toBe(true);
    expect(v3.durations).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const input = v3.buildInput({
      imageUrl: "a", prompt: "p", tailImageUrl: "b",
      negativePrompt: "blur", durationSeconds: 4,
      referenceImageUrls: ["r1", "r2"],
    });
    expect(input).toMatchObject({
      start_image_url: "a", end_image_url: "b",
      negative_prompt: "blur", generate_audio: false,
    });
    // duration + elements encodings asserted per Step 1 findings — write the
    // exact expected values once verified (e.g. duration: "4" or 4).
  });
```

(Adjust the exact `duration`/`elements` assertions to the verified encodings — the test must pin them.)

- [ ] **Step 3: Run to verify failure**, then implement the entry with `estUsdPerSecond` from Step 1, `durationSeconds: 5` default, `whenToUse: "New default. Full directing surface: chaining, cast references, negative prompt, 3–15s. Tradeoff: pricier per second than Kling 2.5; no native audio (use Add SFX)."`, `generate_audio: false` forced with the same rationale comment as LTX. Flip `DEFAULT_CLIP_MODEL_ID`. Create `src/lib/clip-camera.ts` containing only the two exported types + header comment; `clip-models.ts` imports them and re-exports.

- [ ] **Step 4: Verify** — `npm run test`, `npx tsc --noEmit`, `npm run lint`. Note: the old default (`kling-2.5-turbo-pro`) remains valid for existing rows; nothing migrates.

- [ ] **Step 5: Commit** — `feat(directing): Kling v3 Pro registry entry, new default (verified against fal)`

---

### Task 3: Camera module (pure, TDD)

**Files:**
- Modify: `src/lib/clip-camera.ts`
- Test: `tests/unit/clip-camera.test.ts`

**Interfaces:**
- Produces (used by Tasks 7, 9):
  - `const CAMERA_MOVES: Array<{ id: CameraMove; label: string }>` — Static, Push in, Pull back, Pan left, Pan right, Tilt up, Tilt down, Orbit.
  - `const CAMERA_MAGNITUDE: Record<CameraStrength, number> = { subtle: 3, medium: 6, strong: 9 }`.
  - `function cameraPromptSuffix(move: CameraMove, strength: CameraStrength): string` — e.g. `"Camera: slow push-in."` / `"Camera: fast pan to the left."`; `"static"` → `"Camera: locked off, no camera movement."` (strength ignored for static).
  - `function isCameraMove(v: unknown): v is CameraMove`, `function isCameraStrength(v: unknown): v is CameraStrength`.

- [ ] **Step 1: Failing tests:**

```ts
/**
 * Unit tests for the pure camera module: enum guards, prompt-suffix
 * fallback phrasing, and strength magnitudes.
 */
import { describe, it, expect } from "vitest";
import {
  CAMERA_MOVES, CAMERA_MAGNITUDE, cameraPromptSuffix, isCameraMove, isCameraStrength,
} from "@/lib/clip-camera";

describe("clip-camera", () => {
  it("guards enums", () => {
    expect(isCameraMove("push-in")).toBe(true);
    expect(isCameraMove("dolly-zoom")).toBe(false);
    expect(isCameraMove(3)).toBe(false);
    expect(isCameraStrength("subtle")).toBe(true);
    expect(isCameraStrength("extreme")).toBe(false);
  });

  it("has eight moves and three magnitudes", () => {
    expect(CAMERA_MOVES.map((m) => m.id)).toEqual([
      "static", "push-in", "pull-back", "pan-left", "pan-right", "tilt-up", "tilt-down", "orbit",
    ]);
    expect(CAMERA_MAGNITUDE).toEqual({ subtle: 3, medium: 6, strong: 9 });
  });

  it("builds deterministic prompt suffixes", () => {
    expect(cameraPromptSuffix("push-in", "subtle")).toBe("Camera: slow push-in.");
    expect(cameraPromptSuffix("push-in", "strong")).toBe("Camera: fast push-in.");
    expect(cameraPromptSuffix("pan-left", "medium")).toBe("Camera: steady pan to the left.");
    expect(cameraPromptSuffix("static", "strong")).toBe("Camera: locked off, no camera movement.");
  });
});
```

- [ ] **Step 2: Run → FAIL**, then implement (speed words: subtle→"slow", medium→"steady", strong→"fast"; move phrases: push-in→"push-in", pull-back→"pull-back", pan-left→"pan to the left", pan-right→"pan to the right", tilt-up→"tilt upward", tilt-down→"tilt downward", orbit→"orbit around the subject").

- [ ] **Step 3: Verify + commit** — `feat(directing): pure camera module (moves, magnitudes, prompt fallback)`

---

### Task 4: Duration resolution + duration-aware cost estimates (pure, TDD)

**Files:**
- Modify: `src/lib/clip-models.ts` (add `resolveClipDuration`)
- Modify: `src/lib/generation-costs.ts`
- Test: `tests/unit/clip-models.test.ts`, `tests/unit/generation-costs.test.ts`

**Interfaces:**
- Produces:
  - `function resolveClipDuration(spec: Pick<ClipModelSpec,"durations"|"durationSeconds">, slotSeconds: number | null, explicit: number | null): number` — explicit wins if listed in `durations` (else nearest listed, ties up); else nearest to `slotSeconds` (ties up); `slotSeconds` null → `durationSeconds`.
  - `estimateBatchCost(counts, opts?)` — `opts` gains `clipSecondsTotal?: number`; `clipsUsd = round2((opts.clipSecondsTotal ?? counts.clips * spec.durationSeconds) * spec.estUsdPerSecond)`. SFX math unchanged.

- [ ] **Step 1: Failing tests:**

```ts
  // clip-models.test.ts
  it("resolveClipDuration: explicit → nearest-listed → slot → default", () => {
    const v3 = getClipModel("kling-v3-pro")!;
    expect(resolveClipDuration(v3, 3.3, null)).toBe(3);   // nearest
    expect(resolveClipDuration(v3, 3.5, null)).toBe(4);   // tie rounds up
    expect(resolveClipDuration(v3, null, null)).toBe(5);  // default
    expect(resolveClipDuration(v3, 3.3, 8)).toBe(8);      // explicit wins
    const veo = getClipModel("veo-3.1-fast")!;
    expect(resolveClipDuration(veo, 3.3, null)).toBe(8);  // fixed-duration model
    expect(resolveClipDuration(veo, null, 5)).toBe(8);    // explicit clamps to listed
  });

  // generation-costs.test.ts
  it("prices clips by total seconds when provided", () => {
    const c = estimateBatchCost({ sheets: 0, images: 0, clips: 3 },
      { clipModelId: "kling-v3-pro", clipSecondsTotal: 12 });
    // 12s × verified $/s — pin the number after Task 2's verification
    expect(c.clipsUsd).toBeCloseTo(12 * getClipModel("kling-v3-pro")!.estUsdPerSecond, 2);
  });
```

- [ ] **Step 2: Run → FAIL, implement, run → PASS** (nearest with ties-up: `durations.reduce((best, d) => Math.abs(d - t) < Math.abs(best - t) || (Math.abs(d - t) === Math.abs(best - t) && d > best) ? d : best)`).

- [ ] **Step 3: Verify + commit** — `feat(directing): duration auto-match + duration-aware cost estimates`

---

### Task 5: Schema — directing columns + ends_on backfill

**Files:**
- Modify: `src/lib/db/schema.ts` (shots + projects)

**Interfaces:**
- Produces: shots gain `cameraMove text`, `cameraStrength text`, `endsOn text notNull default "free"`, `endFramePath text`, `endFrameStatus generationStatusEnum default "pending"`, `endFrameInstruction text`, `clipDurationChoice integer`, `negativePrompt text`, `useEntityRefs boolean notNull default true`; projects gain `negativePrompt text`. `chain_to_next` REMAINS until Task 16.

- [ ] **Step 1: Add columns** to shots (below the SFX block, header comments per repo convention explaining each) and projects (`negativePrompt: text("negative_prompt")` near styleString, comment: seeded client-side for new projects, nullable = unset).
- [ ] **Step 2: Push** — `npm run db:push` (must be purely additive; abort on any destructive prompt).
- [ ] **Step 3: Backfill** — `psql "$DATABASE_URL" -c "UPDATE shots SET ends_on='next' WHERE chain_to_next = true"` then verify counts match: `SELECT count(*) FROM shots WHERE chain_to_next=true AND ends_on<>'next'` → 0.
- [ ] **Step 4: Verify columns via information_schema (all 10), `npm run test` green, commit** — `feat(directing): shots/projects directing columns; ends_on backfilled from chain_to_next`

---

### Task 6: `resolveEndFrame` (generalizes chaining; pure, TDD)

**Files:**
- Modify: `src/lib/clip-chaining.ts`
- Modify: `tests/unit/clip-chaining.test.ts`

**Interfaces:**
- Consumes: `ClipModelSpec.supportsEndFrame`.
- Produces (used by Task 7; replaces `resolveChainDecision`, which is DELETED in the same commit — Task 7 is the only caller and this task updates it in lockstep? NO — keep task-scoped: this task adds `resolveEndFrame` and keeps `resolveChainDecision` as a one-line wrapper marked for removal in Task 7):
  - `type EndFrameSkipReason = "model-no-end-frame" | "no-next-shot" | "next-image-not-ready" | "custom-frame-not-ready"`
  - `type EndFrameDecision = { tailImagePath: string; skipReason?: never } | { tailImagePath?: never; skipReason?: EndFrameSkipReason }` (free = `{}` — no tail, no reason)
  - `function resolveEndFrame(args: { endsOn: "free" | "next" | "custom"; endFramePath: string | null; endFrameStatus: string | null; spec: Pick<ClipModelSpec, "supportsEndFrame">; nextShot: { imagePath: string | null; imageStatus: string | null } | null }): EndFrameDecision`

- [ ] **Step 1: Failing tests** (add; keep existing resolveChainDecision tests passing until Task 7 removes them):

```ts
describe("resolveEndFrame", () => {
  const spec = { supportsEndFrame: true };
  const noEnd = { supportsEndFrame: false };
  const next = { imagePath: "p/next.png", imageStatus: "done" };

  it("free → no tail, no reason", () => {
    expect(resolveEndFrame({ endsOn: "free", endFramePath: null, endFrameStatus: null, spec, nextShot: next })).toEqual({});
  });
  it("next → next shot's done image; degrades with reasons", () => {
    expect(resolveEndFrame({ endsOn: "next", endFramePath: null, endFrameStatus: null, spec, nextShot: next }))
      .toEqual({ tailImagePath: "p/next.png" });
    expect(resolveEndFrame({ endsOn: "next", endFramePath: null, endFrameStatus: null, spec: noEnd, nextShot: next }))
      .toEqual({ skipReason: "model-no-end-frame" });
    expect(resolveEndFrame({ endsOn: "next", endFramePath: null, endFrameStatus: null, spec, nextShot: null }))
      .toEqual({ skipReason: "no-next-shot" });
    expect(resolveEndFrame({ endsOn: "next", endFramePath: null, endFrameStatus: null, spec, nextShot: { imagePath: null, imageStatus: "pending" } }))
      .toEqual({ skipReason: "next-image-not-ready" });
  });
  it("custom → the authored frame when done; degrades when not", () => {
    expect(resolveEndFrame({ endsOn: "custom", endFramePath: "p/end.png", endFrameStatus: "done", spec, nextShot: null }))
      .toEqual({ tailImagePath: "p/end.png" });
    expect(resolveEndFrame({ endsOn: "custom", endFramePath: null, endFrameStatus: "pending", spec, nextShot: null }))
      .toEqual({ skipReason: "custom-frame-not-ready" });
    expect(resolveEndFrame({ endsOn: "custom", endFramePath: "p/end.png", endFrameStatus: "done", spec: noEnd, nextShot: null }))
      .toEqual({ skipReason: "model-no-end-frame" });
  });
});
```

- [ ] **Step 2: Run → FAIL, implement** (order: endsOn free → `{}`; !supportsEndFrame → model-no-end-frame; custom → path+status check; next → nextShot checks). Update the file header comment. Keep `resolveChainDecision` delegating (`chainToNext ? resolveEndFrame({endsOn:"next",…}) : {…not-requested}`) so nothing breaks before Task 7.
- [ ] **Step 3: Verify + commit** — `feat(directing): resolveEndFrame — free/next/custom end-frame resolution`

---

### Task 7: Clip service wires camera, negative, duration, ends_on

**Files:**
- Modify: `src/lib/shot-clip-generation.ts`
- Modify: `src/lib/clip-chaining.ts` (delete `resolveChainDecision` + its tests — this task migrates the only caller)
- Modify: `tests/unit/clip-chaining.test.ts` (remove old describe block)

**Interfaces:**
- Consumes: Tasks 1–6 (`estClipUsd` not needed here; `resolveClipDuration`, `resolveEndFrame`, `cameraPromptSuffix`, spec flags).
- Produces (used by routes/store): `generateShotClip` return gains `endFrameSkippedReason?: EndFrameSkipReason` (REPLACES `chainSkippedReason` — Task 8 migrates the store; API field renamed in the same release, acceptable pre-prod) and `cameraBestEffort?: boolean`.

- [ ] **Step 1: Modify `generateShotClip`.** After the model/spec resolution block, replace the chain block with:

```ts
    const endFrame = resolveEndFrame({
      endsOn: (shot.endsOn ?? "free") as "free" | "next" | "custom",
      endFramePath: shot.endFramePath,
      endFrameStatus: shot.endFrameStatus,
      spec,
      nextShot: nextShot ?? null,
    });
```

(The `nextShot` timeline lookup stays exactly as-is; it is only *used* when `endsOn === "next"` but computing it unconditionally is harmless and keeps the code simple.)

Camera + prompt assembly (before `fal.subscribe`):

```ts
    const cameraSelected = shot.cameraMove && isCameraMove(shot.cameraMove);
    const strength: CameraStrength =
      shot.cameraStrength && isCameraStrength(shot.cameraStrength) ? shot.cameraStrength : "medium";
    const cameraBestEffort = Boolean(cameraSelected && !spec.supportsCameraControl);
    const prompt = cameraBestEffort
      ? `${shot.motionPrompt} ${cameraPromptSuffix(shot.cameraMove as CameraMove, strength)}`
      : shot.motionPrompt;

    const negativePrompt = spec.supportsNegativePrompt
      ? (shot.negativePrompt?.trim() || project.negativePrompt?.trim() || undefined)
      : undefined;

    const slotSeconds =
      shot.startInBeat != null && shot.endInBeat != null ? shot.endInBeat - shot.startInBeat : null;
    const durationSeconds = resolveClipDuration(spec, slotSeconds, shot.clipDurationChoice ?? null);
```

`buildInput` call becomes:

```ts
      input: spec.buildInput({
        imageUrl,
        prompt,
        tailImageUrl,
        ...(cameraSelected && spec.supportsCameraControl
          ? { camera: { move: shot.cameraMove as CameraMove, strength } }
          : {}),
        ...(negativePrompt ? { negativePrompt } : {}),
        durationSeconds,
      }),
```

Tail upload keys off `endFrame.tailImagePath`; the response/log lines use `endFrameSkippedReason = shot.endsOn !== "free" ? endFrame.skipReason : undefined` and include `cameraBestEffort` when true. Update the header comment (ends_on semantics). Delete `resolveChainDecision` and its wrapper + old tests.

- [ ] **Step 2: Verify** — `npm run test` (clip-chaining suite = the new describe only), `npx tsc --noEmit` (compile will FLAG remaining `chainToNext`/`chainSkippedReason` readers — the store and orchestrator; fix ONLY compile breakage minimally here: orchestrator suggest-chains step writes `{ endsOn: "next" }` instead of `{ chainToNext: true }`, and the store's `chainSkippedReason` read renames to `endFrameSkippedReason` — full store/UI migration is Tasks 8–9), `npm run lint`.
- [ ] **Step 3: Commit** — `feat(directing): clip service resolves camera, negative prompt, duration, ends_on`

---

### Task 8: Routes + store + serializers for the new fields

**Files:**
- Modify: `src/app/api/projects/[id]/shots/[shotId]/route.ts` (PATCH validation)
- Modify: `src/app/api/projects/[id]/route.ts` (project PATCH gains `negativePrompt`)
- Modify: `src/app/api/projects/[id]/shots/route.ts` + `src/app/projects/[id]/page.tsx` (serializers)
- Modify: `src/components/editor/editor-store.tsx`

**Interfaces:**
- Produces: shot PATCH accepts `cameraMove` (CameraMove | null), `cameraStrength` (CameraStrength | null), `endsOn` ("free"|"next"|"custom"), `clipDurationChoice` (int 1–15 | null), `negativePrompt` (string ≤500 | null), `useEntityRefs` (boolean) — each 400 on invalid, allow-list validated via `isCameraMove`/`isCameraStrength`/literal checks. Project PATCH accepts `negativePrompt` (string ≤500 | null). `EditorShot` gains the six fields + `endFramePath/endFrameStatus/endFrameInstruction/endFrameUrl` (nullable; used by Stage 3 but serialized now to avoid a second serializer pass) and `endFrameSkippedReason`/`cameraBestEffort` client-only transients; `EditorProject`/workspace picks up `negativePrompt`. `generateClip` patches the renamed transients.

- [ ] **Step 1: Shot PATCH** — extend the body cast + add validation blocks after the Task-9-era `clipModel` block (each mirrors the existing per-field pattern; enums via the Task 3 guards; `clipDurationChoice` must be `Number.isInteger(v) && v >= 1 && v <= 15` or null; strings `typeof === "string" && length <= 500` or null; `endsOn` in `["free","next","custom"]`). Update header comment. The old `chainToNext` PATCH field is REMOVED (store stops sending it this task).
- [ ] **Step 2: Project PATCH** — read the existing handler first and mirror its field pattern for `negativePrompt` (≤500 | null → `updates.negativePrompt`).
- [ ] **Step 3: Serializers** — both shot mappers add: `cameraMove`, `cameraStrength`, `endsOn` (`?? "free"`), `clipDurationChoice`, `negativePrompt`, `useEntityRefs`, `endFramePath`, `endFrameStatus` (`?? "pending"`), `endFrameInstruction`, `endFrameUrl: shot.endFramePath ? await getDownloadUrl(shot.endFramePath) : null`. page.tsx also serializes `project.negativePrompt` into the workspace props.
- [ ] **Step 4: Store** — `EditorShot` gains all the above + optional client-only `endFrameSkippedReason?: string | null`, `cameraBestEffort?: boolean`; `generateClip` success patch maps the renamed response fields (clears both at start); batch-poll whitelist gains `endsOn`, `endFramePath`, `endFrameStatus`, `endFrameUrl`; `recommendShots` null-out gains `endFrameUrl: null`. Remove every remaining `chainToNext` reference in the store (grep must show only schema + backfill note until Task 16).
- [ ] **Step 5: Verify** — `npm run test`, `npx tsc --noEmit`, `npm run lint`; `grep -rn "chainToNext" src/` → only `db/schema.ts`.
- [ ] **Step 6: Commit** — `feat(directing): PATCH validation, serializers, store fields for directing controls`

---

### Task 9: Inspector regroup — the locked layout (Stage-1 scope)

**Files:**
- Modify: `src/components/editor/inspector.tsx`

**Interfaces:**
- Consumes: `CAMERA_MOVES`, guards (Task 3), `estClipUsd`, `resolveClipDuration`, `getClipModel`, store fields (Task 8).
- Produces: the locked v3 layout, Stage-1 subset — Custom… ends-on option rendered but disabled with title "Coming in the next stage" is FORBIDDEN (YAGNI/no dead UI): render only `Free | Next shot` segments in this task; Task 14 adds `Custom…`. Everything else per Global Constraints copy list.

- [ ] **Step 1: Restructure the shot inspector section** into four `grp`-style blocks using the existing small-caps label classes (`text-[10px] font-semibold uppercase tracking-wide text-muted-foreground`), preserving all existing handlers:
  - **Image — what we see**: image prompt textarea + AI suggest (unchanged), `Re-image` button (unchanged handler).
  - **Action — what happens in the shot**: motion-prompt textarea relabeled with placeholder `e.g. "the boat sails toward the horizon"` + AI suggest; `Camera move` row — a `<select>` over `CAMERA_MOVES` plus a strength `<select>` (Subtle/Medium/Strong) shown only when move ≠ static/null; persists via `updateShot(shot.id, { cameraMove, cameraStrength })`; hint line: `selectedModel.supportsCameraControl ? "guaranteed ✓" : "best-effort — written into the prompt"`; `Ends on` row — segmented control (two `<button>`s styled like the preview-mode toggle) `Free | Next shot`, persisting `updateShot(shot.id, { endsOn })`; when `next` is active show the next-shot thumbnail (existing computation) and the amber `endFrameSkippedReason` note (reason copy: `model-no-end-frame` → "Skipped — this model can't take an end frame", `no-next-shot` → "Skipped — no next shot", `next-image-not-ready` → "Skipped — the next shot's image wasn't ready", `custom-frame-not-ready` → "Skipped — the custom end frame wasn't ready").
  - **Clip — engine settings**: model dropdown + whenToUse line (unchanged); `Length` row — text `“{resolved}s (auto)”` when `clipDurationChoice` null, computed via `resolveClipDuration(selectedModel, slotSeconds, null)` with `slotSeconds = shot.endInBeat - shot.startInBeat`; − / + steppers move through `selectedModel.durations` and persist `clipDurationChoice`; an "auto" reset link when explicit; `Advanced ▸` — a `<details>` element containing the per-shot negative prompt textarea (placeholder shows the project default, persists `negativePrompt`, empty string persists null); Generate button — title/price use `estClipUsd(selectedModel, resolvedDuration)`; `cameraBestEffort` response transient renders a one-line muted note under the button after generation.
  - **Sound**: SFX controls unchanged, just relocated under the group label.
  The chain checkbox is deleted (superseded by Ends on).
- [ ] **Step 2: Editor toolbar popover** — a gear icon button next to "Generate all" opening a small popover (existing Dialog primitive or a simple positioned panel matching house style) with one labeled textarea "Negative prompt (project default)" seeded for empty projects with the Global-Constraints string via placeholder + a "use suggested" link that fills it; saves through the project PATCH (add a `saveProjectSettings` store helper mirroring existing project mutations).
- [ ] **Step 3: Verify** — `npx tsc --noEmit`, `npm run lint`, `npm run test`; then live browser check (controller pass): groups render per the locked mockup, camera hint flips between models, Ends on persists, Length auto/override works.
- [ ] **Step 4: Commit** — `feat(directing): inspector regroup — Action/Clip groups, camera picker, ends-on, length, advanced negative`

---

### Task 10: Batch + preview go duration-aware; suggest-chains writes ends_on

**Files:**
- Modify: `src/inngest/functions/generate-batch.ts` (suggest-chains step: already writes `endsOn` per Task 7 compile fix — verify + gate copy unchanged)
- Modify: `src/app/api/projects/[id]/generate-all/preview/route.ts`
- Modify: `src/app/api/projects/[id]/generate-all/route.ts` (log line only)
- Modify: `src/components/editor/generate-all-dialog.tsx` (no structural change; estimates flow through)

**Interfaces:**
- Consumes: `resolveClipDuration`, `estimateBatchCost(..., { clipSecondsTotal })`.
- Produces: preview computes `clipSecondsTotal` server-side = Σ over clip-target shots of `resolveClipDuration(spec, slot, explicit)`; response unchanged in shape (`clips.estUsd` just gets accurate).

- [ ] **Step 1: Preview route** — after `computeBatchTargets`, load the target shots' `startInBeat/endInBeat/clipDurationChoice`, resolve the selected spec once, sum durations, pass `clipSecondsTotal` to `estimateBatchCost`.
- [ ] **Step 2: Verify orchestrator** — suggest-chains step sets `{ endsOn: "next" }` via `inArray` (Task 7's compile fix); its gate (`spec.supportsEndFrame && clipShotIds.length > 0`) unchanged; wave 3 needs no changes (service reads shot rows).
- [ ] **Step 3: Verify + commit** — `npm run test`, tsc, lint; `feat(directing): duration-aware batch cost preview; chain suggestions write ends_on`

---

### Task 11: Stage-1 verification gate

- [ ] Full suite: `npm run test`, `npx tsc --noEmit`, `npm run lint`, `INNGEST_DEV="" npm run build` — all green.
- [ ] Controller live-browser pass on a dev project: regrouped inspector, camera picker persistence, Ends on Free/Next, Length auto/explicit, Advanced negative, project popover, batch dialog estimates.
- [ ] `grep -rn "chainToNext\|chainSkippedReason" src/` → only `db/schema.ts` (column awaiting Task 16 drop).
- [ ] Commit any fixes; Stage 1 is shippable here.

---

# STAGE 2 — Entity references in clips (Tasks 12–13)

### Task 12: Reference resolution in the clip service (pure resolver + wiring)

**Files:**
- Create: `src/lib/clip-references.ts`
- Modify: `src/lib/shot-clip-generation.ts`
- Test: `tests/unit/clip-references.test.ts`

**Interfaces:**
- Produces:
  - `type RefsSkipReason = "disabled" | "model-no-references" | "no-ready-sheets"`
  - `function resolveClipReferences(args: { useEntityRefs: boolean; spec: Pick<ClipModelSpec,"supportsReferences">; taggedEntities: Array<{ id: string; name: string; referenceStatus: string | null; referenceSheetPath: string | null }> }): { sheetPaths: string[]; skipReason?: RefsSkipReason }` — pure; ready = `referenceStatus === "done" && referenceSheetPath`; cap at 4 sheets (Kling elements limit), order = tag order; `skipReason` only when refs were wanted (`useEntityRefs`) but none attach.
  - Service: loads the shot's tagged entities (same query pattern as `resolvePrimaryEntity` in `shot-image-generation.ts` but returning all tagged, in `referencedEntityIds` order), uploads each sheet via `uploadR2ObjectToFal` (fileName `entity-ref-{i}.png`), passes `referenceImageUrls`; response gains `refsApplied?: number` and `refsSkippedReason?: RefsSkipReason`.

- [ ] **Step 1: Failing tests** for the pure resolver (disabled → skip "disabled" with empty paths; unsupported model → "model-no-references"; no done sheets → "no-ready-sheets"; happy path returns ≤4 paths in tag order; 5 tagged → 4 returned).
- [ ] **Step 2: Run → FAIL, implement resolver → PASS.**
- [ ] **Step 3: Wire the service** (load entities via `inArray(entities.id, shot.referencedEntityIds ?? [])` filtered to the project, reorder to match the tag array; uploads only when `sheetPaths.length > 0`; buildInput gets `referenceImageUrls`), extend the done-log line with `refs=N`.
- [ ] **Step 4: Verify + commit** — `feat(directing): entity reference sheets ride into clip generation`

---

### Task 13: "Cast & locations featured" UI + notes

**Files:**
- Modify: `src/components/editor/inspector.tsx`
- Modify: `src/components/editor/editor-store.tsx` (generateClip patches `refsApplied`/`refsSkippedReason` transients)

**Interfaces:**
- Consumes: store `useEntityRefs` field (Task 8), entities list already in the store (`EditorEntity` has `name`, `referenceStatus`).
- Produces: Clip group row — label `Cast & locations featured`, a switch bound to `updateShot(shot.id, { useEntityRefs })`, derived text = tagged entity names joined (", ") + `" — from your tags"`, muted `"(none tagged)"` when empty, muted `"not supported by this model"` when `!selectedModel.supportsReferences`; tag-chip helper text (existing hint line ~inspector.tsx:647) becomes `★ primary · sheets condition the image and the clip · click a chip to tag/untag · the small icon inserts the name into the prompt`; post-generation muted note `Cast refs skipped — {reason copy}` mirrors the camera note.

- [ ] **Step 1: Implement** (switch = existing checkbox styling; the derived names come from `shot.referencedEntityIds` mapped over the store's entities).
- [ ] **Step 2: Verify (tsc/lint/test + quick browser pass) + commit** — `feat(directing): cast & locations featured toggle + refs notes`

---

# STAGE 3 — Frame staging (Tasks 14–17)

### Task 14: Frame-edit service + routes (Kontext)

**Files:**
- Create: `src/lib/shot-frame-edit.ts`
- Create: `src/app/api/projects/[id]/shots/[shotId]/image/edit/route.ts`
- Create: `src/app/api/projects/[id]/shots/[shotId]/end-frame/route.ts`

**Interfaces:**
- Produces:
  - `const FRAME_EDIT_INSTRUCTION_MAX_CHARS = 500`
  - `async function editShotImage(project, shot, instruction): Promise<{ imagePath; imageUrl }>` — Kontext edit of `shot.imagePath` (read the exact endpoint id + input shape from `src/lib/image-generation.ts` FIRST and reuse its constants/idiom; it already calls `fal-ai/flux-pro/kontext` with `{ prompt, image_url }`), overwrites `projects/{p}/shots/{s}/image.png`, imageStatus generating→done/failed lifecycle, throws after failed; ALSO resets `endFrameStatus` to `"pending"` when an end frame exists (stale flag per spec) and mirrors nothing else.
  - `async function createShotEndFrame(project, shot, instruction): Promise<{ endFramePath; endFrameUrl }>` — same Kontext call from `shot.imagePath`, stores `projects/{p}/shots/{s}/end-frame.png`, sets `endFramePath`, `endFrameStatus: "done"`, `endFrameInstruction: instruction`; own generating→done/failed lifecycle.
  - Routes: `POST image/edit` `{ instruction }` (≤500, required non-empty; 400 if no done image) → editShotImage result; `POST end-frame` `{ instruction }` (same guards) → createShotEndFrame result; `DELETE end-frame` → deletes the R2 object via `deleteObject` (non-fatal), nulls `endFramePath/endFrameInstruction`, resets `endFrameStatus: "pending"`, sets `endsOn: "free"` when it was `"custom"`. Rate-limit class: `"generation"` for both POSTs, `"mutation"` for DELETE. Full security stack per Global Constraints.

- [ ] **Step 1: Read `src/lib/image-generation.ts`** — copy its Kontext endpoint id, input shape, output parsing, and fal upload idiom exactly (do not invent a second pattern).
- [ ] **Step 2: Implement service + routes** (services mirror `sfx-generation.ts` structure: header comment, lifecycle, catch-mark-failed-throw; routes mirror the sfx route file structurally).
- [ ] **Step 3: Verify** — tsc, lint, tests green; commit `feat(directing): Kontext frame-edit service — edit image in place + custom end frames`

---

### Task 15: Custom end frame + Edit image UI

**Files:**
- Modify: `src/components/editor/editor-store.tsx` (actions: `editShotImage(shotId, instruction)`, `createEndFrame(shotId, instruction)`, `removeEndFrame(shotId)` — follow generateSfx/removeSfx idioms incl. optimistic status patches)
- Modify: `src/components/editor/inspector.tsx`
- Modify: `src/components/editor/storyboard-view.tsx` (corner badge)

**Interfaces:**
- Consumes: Task 14 routes; `endFrame*` store fields (already serialized since Task 8).
- Produces: Image group gains `Edit image…` button → inline instruction input + Apply (calls `editShotImage`; spinner via imageStatus; the input clears on success); Ends on gains the third segment `Custom…` — selecting it persists `endsOn: "custom"` and reveals: instruction input (prefilled from `endFrameInstruction`), `Create end frame` / `Re-create` button (busy on `endFrameStatus === "generating"`), the end-frame thumbnail when done (same slot as the next-shot thumbnail), a small ✕ that calls `removeEndFrame` (which also flips the segment back to Free per the DELETE semantics — patch store state from the response), and a muted stale hint when `endsOn === "custom" && endFrameStatus === "pending" && endFrameInstruction` ("End frame out of date — re-create it"); storyboard tiles with `endsOn === "custom" && endFramePath` get a tiny `▸▮` corner badge (`title="Directed ending"`).

- [ ] **Step 1: Store actions, Step 2: Inspector UI, Step 3: Storyboard badge** (each per the idioms named above).
- [ ] **Step 4: Verify (tsc/lint/test + browser pass: edit a still, author an end frame, generate a clip landing on it) + commit** — `feat(directing): edit-image and custom end-frame UI`

---

### Task 16: Drop `chain_to_next` + final cleanup

- [ ] **Step 1:** `grep -rn "chainToNext\|chain_to_next" src/` → must show ONLY `src/lib/db/schema.ts`.
- [ ] **Step 2:** Remove the column from `schema.ts`; `npm run db:push` — the ONLY destructive change this feature makes; confirm the drop targets exactly `chain_to_next` before approving the push prompt (data already backfilled into `ends_on` in Task 5; re-verify: `SELECT count(*) FROM shots WHERE chain_to_next=true AND ends_on<>'next'` → 0 BEFORE pushing).
- [ ] **Step 3:** Full gates: `npm run test`, `npx tsc --noEmit`, `npm run lint`, `INNGEST_DEV="" npm run build`.
- [ ] **Step 4: Commit** — `feat(directing): drop chain_to_next (superseded by ends_on)`

---

### Task 17: Docs + verification + final review

**Files:**
- Create: `docs/feature19/feature.md` (per feature-playbook.md, mirror feature18)
- Create: `docs/feature19/test-case.md`

- [ ] **Step 1: feature.md** — summary, architecture (modules from Tasks 1–15, one line each), data model (10 columns + project column + the drop), per-model capability matrix as verified, degrade/skip-note semantics, security notes, cost notes (per-second), known limitations from the spec.
- [ ] **Step 2: test-case.md** — unit suites (mark PASS with counts); route TCs (PATCH allow-lists incl. 400 cases; image/edit + end-frame preconditions; project negativePrompt); UI TCs per locked mockup (group labels/copy verbatim, camera hint flip, ends-on thumbnails incl. custom, length auto/override/reset, featured toggle states incl. "not supported", advanced negative placeholder, storyboard badge); paid TCs marked pending: **hero test** = one Kling v3 clip with camera push-in + 2 entity refs + custom end frame (clock-at-midnight in a single shot), LTX prompt-fallback camera clip, duration auto-match check, batch run with duration-aware preview.
- [ ] **Step 3: Pre-commit checklist** (CLAUDE.md) with grep evidence; **Step 4:** full gates incl. build; commit `docs(directing): feature19 documentation + test cases`.
- [ ] **Step 5: STOP — user gates:** paid smoke (~$3–4, get explicit go-ahead with the estimate), live browser verification, then final whole-branch review (most capable model) and the merge decision per the established workflow.
