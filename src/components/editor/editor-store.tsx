/**
 * Unified-editor shared store (v4.0 Pillar A/B, entities: Pillar C/Phase 4).
 * One React context owns beats, shots, entities, selection, and view;
 * Timeline, Storyboard, Script strip, Inspector, and the Cast & Locations
 * rail are all renderers of this state — the spec §5 "two views over one
 * source of truth" invariant. All API mutations live here so no view talks
 * to the network directly.
 *
 * Entity shot counts: the server computes `shotCount` at fetch time, but
 * the store keeps `shots` as the single live source of truth. Rather than
 * trust the server snapshot after local tag/untag actions, consumers that
 * need a live count call the exported `entityShotCount(entityId, shots)`
 * selector, which recomputes from `state.shots` on every render. The raw
 * `shotCount` field on `EditorEntity` is kept only as the as-fetched value.
 */
"use client";

import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { computeBeatOffsets, totalDurationSeconds } from "@/lib/beat-timing";

// ── Types ──

export interface EditorBeat {
  id: string;
  sortOrder: number;
  text: string;
  voStatus: string;
  voDurationSeconds: number | null;
  voUrl: string | null;
  startSeconds: number; // computed, kept fresh by the reducer
  endSeconds: number; // computed, kept fresh by the reducer
}

export interface EditorShot {
  id: string;
  beatId: string | null;
  sortOrder: number;
  startInBeat: number | null;
  endInBeat: number | null;
  imagePrompt: string;
  motionPrompt: string;
  imagePath: string | null;
  imageStatus: string;
  imageUrl: string | null;
  clipPath: string | null;
  clipStatus: string;
  clipUrl: string | null;
  clipDurationSeconds: number | null;
  clipModel: string | null;
  // ── Directing controls (Task 5/7/8) ──
  cameraMove: string | null;
  cameraStrength: string | null;
  // "free" (model decides) | "next" (ends on the next shot's image) |
  // "custom" (ends on an authored end frame). Supersedes the legacy
  // boolean chain-to-next flag, which the store no longer reads or writes.
  endsOn: "free" | "next" | "custom";
  clipDurationChoice: number | null;
  negativePrompt: string | null;
  useEntityRefs: boolean;
  // Authored custom end frame (endsOn = "custom"); serialized now (Task 8)
  // though only Stage 3 UI consumes it, to avoid a second serializer pass.
  endFramePath: string | null;
  endFrameStatus: string;
  endFrameInstruction: string | null;
  endFrameUrl: string | null;
  sfxPath: string | null;
  sfxStatus: string;
  sfxUrl: string | null;
  // Reference Bible tagging (F-16) — populated server-side by page.tsx from
  // the DB column (which defaults to [] there too); always an array here.
  referencedEntityIds: string[];
  // Client-only — why a requested end frame was skipped on the most
  // recent clip generation. Never persisted: both server
  // serializers (shots GET route, page.tsx) omit it, so it starts
  // undefined on load and is only ever set from a generateClip response.
  endFrameSkippedReason?: string | null;
  // Client-only — whether the most recent clip generation applied the
  // selected camera move as a best-effort prompt suffix (the model has no
  // hard camera-control param). Same lifecycle as endFrameSkippedReason.
  cameraBestEffort?: boolean;
  // Client-only — how many tagged-entity reference sheets rode into the most
  // recent clip generation as cast/location refs. Same lifecycle as
  // cameraBestEffort: cleared at generateClip start, patched from response.
  refsApplied?: number;
  // Client-only — why entity references were skipped on the most recent clip
  // generation ("disabled" | "model-no-references" | "no-ready-sheets").
  // Same lifecycle as cameraBestEffort.
  refsSkippedReason?: string | null;
}

export interface EditorEntity {
  id: string;
  name: string;
  type: "character" | "location" | "object";
  description: string;
  referenceStatus: string;
  referenceSheetUrl: string | null;
  shotCount: number;
}

export interface GenerateAllPreview {
  sheets: { count: number; estUsd: number };
  images: { count: number; estUsd: number };
  clips: { count: number; estUsd: number };
  sfx: { count: number; estUsd: number };
  totalUsd: number;
  totalWithClipsUsd: number;
  batchRunning: boolean;
}

// ── AI Assistant Director (Task 6/7/8) ──
// Deliberately hand-typed (not imported from db/schema) so this client
// module never pulls server-only drizzle types into the browser bundle —
// same reasoning as EditorShot/EditorEntity above.

/** One director_events row as the GET route serializes it — critique events carry `frameUrls` (presigned at read time), never `frameKeys`. */
export interface DirectorEventView {
  id: string;
  seq: number;
  type: string; // 'note' | 'critique' | 'action' | 'cost' | 'error'
  payload: Record<string, unknown>;
  createdAt: string;
}

/** A director_runs row as the GET route serializes it, plus the presigned `candidateUrl`. */
export interface DirectorRunView {
  id: string;
  shotId: string;
  status: string; // 'running' | 'awaiting_approval' | 'approved' | 'rejected' | 'stopped' | 'failed'
  budgetUsd: number;
  spentUsd: number;
  guidance: string | null;
  verdict: string | null;
  clipCandidatePath: string | null;
  candidateDurationSeconds: number | null;
  candidateModel: string | null;
  candidateUrl: string | null;
  // The DirectingSettings snapshot `finalizeRun` stamps on every terminal
  // run (director-resolve.ts's promotionPlan is the authoritative reader);
  // the inspector's verdict card (Task 14) reads it client-side to compute
  // the settings diff against the shot's current fields. Null until the
  // run reaches a terminal state.
  settingsSnapshot: Record<string, unknown> | null;
  // propose_entity_update tool calls (director-tools.ts), each shaped
  // `{ entityId, entityName, field, from, to, rationale }` — indexes into
  // this array are what the resolve route's `approvedProposalIds` refers to.
  proposals: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

/** One entry of the resolve route's approve response `proposals` array — a per-proposal apply outcome (Task 13). */
export interface DirectorProposalResult {
  index: number;
  entityId: unknown;
  applied: boolean;
  error?: string;
}

/** Per-shot director poll state — undefined until the shot's status has been checked at least once (see the "mounted shot" effect in EditorProvider). `run: null` means checked, no run ever started. */
export interface DirectorShotState {
  run: DirectorRunView | null;
  events: DirectorEventView[];
}

export type EditorView = "timeline" | "storyboard";

export type EditorSelection =
  | { type: "beat"; beatId: string }
  | { type: "shot"; shotId: string }
  | { type: "gap"; beatId: string; startInBeat: number; endInBeat: number }
  | null;

// ── Reducer ──

interface State {
  beats: EditorBeat[];
  shots: EditorShot[];
  entities: EditorEntity[];
  view: EditorView;
  selection: EditorSelection;
}

type Action =
  | { type: "setBeats"; beats: EditorBeat[] }
  | { type: "patchBeat"; beatId: string; patch: Partial<EditorBeat> }
  | { type: "setShots"; shots: EditorShot[] }
  | { type: "addShot"; shot: EditorShot }
  | { type: "patchShot"; shotId: string; patch: Partial<EditorShot> }
  | { type: "removeShot"; shotId: string }
  | { type: "setEntities"; entities: EditorEntity[] }
  | { type: "addEntity"; entity: EditorEntity }
  | { type: "patchEntity"; entityId: string; patch: Partial<EditorEntity> }
  | { type: "removeEntity"; entityId: string }
  | { type: "setView"; view: EditorView }
  | { type: "select"; selection: EditorSelection };

function withOffsets(beats: EditorBeat[]): EditorBeat[] {
  const offsets = computeBeatOffsets(beats);
  const byId = new Map(offsets.map((o) => [o.id, o]));
  return [...beats]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((b) => ({
      ...b,
      startSeconds: byId.get(b.id)?.startSeconds ?? 0,
      endSeconds: byId.get(b.id)?.endSeconds ?? 0,
    }));
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "setBeats":
      return { ...state, beats: withOffsets(action.beats) };
    case "patchBeat":
      return {
        ...state,
        beats: withOffsets(
          state.beats.map((b) => (b.id === action.beatId ? { ...b, ...action.patch } : b)),
        ),
      };
    case "setShots":
      return { ...state, shots: action.shots };
    case "addShot":
      return { ...state, shots: [...state.shots, action.shot] };
    case "patchShot":
      return {
        ...state,
        shots: state.shots.map((s) => (s.id === action.shotId ? { ...s, ...action.patch } : s)),
      };
    case "removeShot":
      return {
        ...state,
        shots: state.shots.filter((s) => s.id !== action.shotId),
        selection:
          state.selection?.type === "shot" && state.selection.shotId === action.shotId
            ? null
            : state.selection,
      };
    case "setEntities":
      return { ...state, entities: action.entities };
    case "addEntity":
      return { ...state, entities: [...state.entities, action.entity] };
    case "patchEntity":
      return {
        ...state,
        entities: state.entities.map((e) =>
          e.id === action.entityId ? { ...e, ...action.patch } : e,
        ),
      };
    case "removeEntity":
      return {
        ...state,
        entities: state.entities.filter((e) => e.id !== action.entityId),
        // Mirror the server's DELETE side-effect: strip the removed id from
        // every shot's local tag list so chips/badges disappear immediately.
        shots: state.shots.map((s) =>
          s.referencedEntityIds.includes(action.entityId)
            ? {
                ...s,
                referencedEntityIds: s.referencedEntityIds.filter(
                  (id) => id !== action.entityId,
                ),
              }
            : s,
        ),
      };
    case "setView":
      return { ...state, view: action.view };
    case "select":
      return { ...state, selection: action.selection };
  }
}

// ── Context ──

interface EditorContextValue {
  projectId: string;
  // Project-level directing default (Directing Controls task 9) — the
  // negative-prompt seed shots fall back to when they have no override of
  // their own (see shot-clip-generation.ts). Edited via the toolbar's
  // project-settings popover; per-shot fields read it for their placeholder.
  projectNegativePrompt: string | null;
  saveProjectSettings(patch: { negativePrompt?: string | null }): Promise<void>;
  beats: EditorBeat[];
  shots: EditorShot[];
  entities: EditorEntity[];
  totalDuration: number;
  view: EditorView;
  setView(v: EditorView): void;
  selection: EditorSelection;
  select(s: EditorSelection): void;
  revoiceBeat(beatId: string, text?: string): Promise<void>;
  createShot(
    beatId: string,
    startInBeat: number,
    endInBeat: number,
    imagePrompt: string,
    motionPrompt?: string,
  ): Promise<EditorShot | null>;
  updateShot(
    shotId: string,
    patch: Partial<
      Pick<
        EditorShot,
        | "beatId"
        | "startInBeat"
        | "endInBeat"
        | "imagePrompt"
        | "motionPrompt"
        | "referencedEntityIds"
        | "clipModel"
        | "cameraMove"
        | "cameraStrength"
        | "endsOn"
        | "clipDurationChoice"
        | "negativePrompt"
        | "useEntityRefs"
      >
    >,
  ): Promise<void>;
  deleteShot(shotId: string): Promise<void>;
  splitShot(shotId: string, atInBeat: number): Promise<void>;
  generateImage(shotId: string): Promise<void>;
  editShotImage(shotId: string, instruction: string): Promise<boolean>;
  generateClip(shotId: string, model?: string): Promise<void>;
  generateSfx(shotId: string, prompt?: string): Promise<void>;
  removeSfx(shotId: string): Promise<void>;
  createEndFrame(shotId: string, instruction: string): Promise<void>;
  removeEndFrame(shotId: string): Promise<void>;
  recommendShots(): Promise<void>;
  recommending: boolean;
  createEntity(
    name: string,
    type: EditorEntity["type"],
    description?: string,
  ): Promise<boolean>;
  updateEntity(
    id: string,
    patch: Partial<Pick<EditorEntity, "name" | "description">>,
  ): Promise<void>;
  deleteEntity(id: string): Promise<void>;
  generateReference(id: string): Promise<void>;
  extractEntities(): Promise<{ created: number; taggedShots: number } | null>;
  extracting: boolean;
  tagShot(shotId: string, entityIds: string[]): Promise<void>;
  fetchGenerateAllPreview(opts?: {
    clipModel?: string;
    includeSfx?: boolean;
  }): Promise<GenerateAllPreview | null>;
  generateAll(opts: {
    includeClips: boolean;
    clipModel?: string;
    suggestChains?: boolean;
    includeSfx?: boolean;
  }): Promise<boolean>;
  batchActive: boolean;
  // AI Assistant Director (Task 8/13/14) — startDirector's 4th param
  // mirrors the route's optional `guidance`; its 5th, `retryOfRunId`,
  // powers the verdict card's "Reject & retry" flow (the server seeds the
  // new run's guidance from the prior run + the rejection note). directorState
  // is keyed by shotId; entries are populated lazily (see EditorProvider's
  // "mounted shot" effect) and kept fresh by a 3s poll while any entry's run
  // is `running` OR `awaiting_approval` (so a resolve from another tab is
  // reflected here without user action).
  startDirector(
    shotId: string,
    budgetUsd: number,
    guidance?: string,
    retryOfRunId?: string,
  ): Promise<boolean>;
  stopDirector(shotId: string): Promise<void>;
  // Closes out an `awaiting_approval`/`stopped` run (resolve route, Task
  // 13). Returns the parsed response on success (so the verdict card can
  // surface per-proposal apply failures on approve) or null on any failure
  // — including a 409/400 lost-race/bad-state response, which this still
  // re-polls the run for before returning null, so the UI reflects
  // whatever actually happened server-side rather than getting stuck.
  resolveDirector(
    shotId: string,
    action: "approve" | "reject" | "dismiss",
    note?: string,
    approvedProposalIds?: number[],
  ): Promise<{ status: string; proposals: DirectorProposalResult[] } | null>;
  directorState: Record<string, DirectorShotState>;
}

const EditorContext = createContext<EditorContextValue | null>(null);

// Monotonic per-shot update sequence — see updateShot. Module scope is fine:
// one editor mounts at a time and shot ids are globally unique.
const shotUpdateSeq = new Map<string, number>();

export function EditorProvider(props: {
  projectId: string;
  initialBeats: EditorBeat[];
  initialShots: EditorShot[];
  initialEntities?: EditorEntity[];
  initialNegativePrompt?: string | null;
  children: ReactNode;
}) {
  const {
    projectId,
    initialBeats,
    initialShots,
    initialEntities = [],
    initialNegativePrompt = null,
    children,
  } = props;

  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    beats: withOffsets(initialBeats),
    shots: initialShots,
    entities: initialEntities,
    view: "timeline" as EditorView,
    selection: null as EditorSelection,
  }));
  const [recommending, setRecommending] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [projectNegativePrompt, setProjectNegativePrompt] = useState(initialNegativePrompt);

  const totalDuration = useMemo(() => totalDurationSeconds(state.beats), [state.beats]);

  const setView = useCallback((v: EditorView) => dispatch({ type: "setView", view: v }), []);
  const select = useCallback((s: EditorSelection) => dispatch({ type: "select", selection: s }), []);

  // ── Beat mutations ──

  const revoiceBeat = useCallback(
    async (beatId: string, text?: string) => {
      const prevBeat = state.beats.find((b) => b.id === beatId);
      dispatch({ type: "patchBeat", beatId, patch: { voStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/beats/${beatId}/revoice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(text !== undefined ? { text } : {}),
        });
        if (!res.ok) {
          console.warn("[editor-store] revoice failed:", await res.text());
          if (prevBeat) {
            dispatch({ type: "patchBeat", beatId, patch: { voStatus: prevBeat.voStatus } });
          }
          return;
        }
        const updated = (await res.json()) as Partial<EditorBeat>;
        // Spread-merge so any client-only fields survive; the response
        // carries the fresh voUrl + duration, so offsets ripple downstream.
        dispatch({ type: "patchBeat", beatId, patch: { ...updated, voStatus: "done" } });
      } catch (err) {
        console.error("[editor-store] revoice error:", err);
        if (prevBeat) {
          dispatch({ type: "patchBeat", beatId, patch: { voStatus: prevBeat.voStatus } });
        }
      }
    },
    [projectId, state.beats],
  );

  // ── Shot mutations ──

  const createShot = useCallback(
    async (
      beatId: string,
      startInBeat: number,
      endInBeat: number,
      imagePrompt: string,
      motionPrompt?: string,
    ): Promise<EditorShot | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beatId, startInBeat, endInBeat, imagePrompt, motionPrompt }),
        });
        if (!res.ok) {
          console.warn("[editor-store] create shot failed:", await res.text());
          return null;
        }
        const raw = (await res.json()) as EditorShot;
        const shot: EditorShot = { ...raw, referencedEntityIds: raw.referencedEntityIds ?? [] };
        dispatch({ type: "addShot", shot });
        dispatch({ type: "select", selection: { type: "shot", shotId: shot.id } });
        // Returned so callers (the gap-create form) can chain follow-ups
        // like tagging the freshly created shot.
        return shot;
      } catch (err) {
        console.error("[editor-store] create shot error:", err);
        return null;
      }
    },
    [projectId],
  );

  const updateShot = useCallback(
    async (
      shotId: string,
      patch: Partial<
        Pick<
          EditorShot,
          | "beatId"
          | "startInBeat"
          | "endInBeat"
          | "imagePrompt"
          | "motionPrompt"
          | "referencedEntityIds"
          | "clipModel"
          | "cameraMove"
          | "cameraStrength"
          | "endsOn"
          | "clipDurationChoice"
          | "negativePrompt"
          | "useEntityRefs"
        >
      >,
    ) => {
      const prevShot = state.shots.find((s) => s.id === shotId);
      dispatch({ type: "patchShot", shotId, patch });
      // Rapid updates to the same shot overlap on the network (a PATCH can
      // take seconds): an EARLIER request's response must never stomp a
      // LATER request's optimistic state — only the latest request for a
      // shot gets to merge its response or revert, and it only touches the
      // keys it actually changed.
      const seq = (shotUpdateSeq.get(shotId) ?? 0) + 1;
      shotUpdateSeq.set(shotId, seq);
      const isLatest = () => shotUpdateSeq.get(shotId) === seq;
      const keys = Object.keys(patch) as (keyof EditorShot)[];
      const pick = (source: Partial<EditorShot>): Partial<EditorShot> =>
        Object.fromEntries(
          keys.filter((k) => k in source).map((k) => [k, source[k]]),
        ) as Partial<EditorShot>;
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          console.warn("[editor-store] update shot failed:", await res.text());
          if (prevShot && isLatest()) {
            dispatch({ type: "patchShot", shotId, patch: pick(prevShot) });
          }
          return;
        }
        const updated = (await res.json()) as Partial<EditorShot>;
        // Merge only the keys this request changed (server-authoritative for
        // them) so client-only fields and newer optimistic patches survive.
        if (isLatest()) {
          dispatch({ type: "patchShot", shotId, patch: pick(updated) });
        }
      } catch (err) {
        console.error("[editor-store] update shot error:", err);
        if (prevShot && isLatest()) {
          dispatch({ type: "patchShot", shotId, patch: pick(prevShot) });
        }
      }
    },
    [projectId, state.shots],
  );

  const deleteShot = useCallback(
    async (shotId: string) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
          method: "DELETE",
        });
        if (res.ok) {
          dispatch({ type: "removeShot", shotId });
        } else {
          console.warn("[editor-store] delete shot failed:", await res.text());
        }
      } catch (err) {
        console.error("[editor-store] delete shot error:", err);
      }
    },
    [projectId],
  );

  const splitShot = useCallback(
    async (shotId: string, atInBeat: number) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/split`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ atInBeat }),
        });
        if (!res.ok) {
          console.warn("[editor-store] split rejected:", await res.text());
          return;
        }
        const { left, right } = (await res.json()) as { left: EditorShot; right: EditorShot };
        const original = state.shots.find((s) => s.id === shotId);
        // The split response rows are raw DB fields — no presigned URLs.
        // Preserve the original's client-side URLs on the LEFT half, since
        // the underlying R2 asset didn't move, only the shot bounds
        // narrowed. The RIGHT half is a brand-new range with no asset yet.
        const mergedLeft: EditorShot = original
          ? { ...original, ...left, imageUrl: original.imageUrl, clipUrl: original.clipUrl }
          : { ...left, imageUrl: null, clipUrl: null };
        const mergedRight: EditorShot = { ...right, imageUrl: null, clipUrl: null };
        dispatch({
          type: "setShots",
          shots: [...state.shots.filter((s) => s.id !== shotId), mergedLeft, mergedRight],
        });
        dispatch({ type: "select", selection: { type: "shot", shotId: mergedRight.id } });
      } catch (err) {
        console.error("[editor-store] split error:", err);
      }
    },
    [projectId, state.shots],
  );

  const generateImage = useCallback(
    async (shotId: string) => {
      dispatch({ type: "patchShot", shotId, patch: { imageStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/image`, {
          method: "POST",
        });
        if (!res.ok) {
          console.warn("[editor-store] image generation failed:", await res.text());
          dispatch({ type: "patchShot", shotId, patch: { imageStatus: "failed" } });
          return;
        }
        const data = (await res.json()) as {
          imagePath: string;
          imageUrl: string;
          imageStatus: string;
        };
        dispatch({
          type: "patchShot",
          shotId,
          patch: { imagePath: data.imagePath, imageUrl: data.imageUrl, imageStatus: "done" },
        });
      } catch (err) {
        console.error("[editor-store] image generation error:", err);
        dispatch({ type: "patchShot", shotId, patch: { imageStatus: "failed" } });
      }
    },
    [projectId],
  );

  // Returns true only on success (createEntity idiom) — the inspector's
  // inline edit form keeps the typed instruction around on failure so a
  // failed paid call doesn't wipe the user's text.
  const editShotImage = useCallback(
    async (shotId: string, instruction: string): Promise<boolean> => {
      dispatch({ type: "patchShot", shotId, patch: { imageStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/image/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction }),
        });
        if (!res.ok) {
          console.warn("[editor-store] image edit failed:", await res.text());
          // The route only allows editing when imageStatus was already
          // "done" with an intact image, and a failed edit never touches
          // that image — restore "done" (not "failed") so the UI doesn't
          // show a false failure over a still-good image (mirrors
          // shot-frame-edit.ts's editShotImage; final-review finding #2).
          dispatch({ type: "patchShot", shotId, patch: { imageStatus: "done" } });
          return false;
        }
        const data = (await res.json()) as {
          imagePath: string;
          imageUrl: string;
          imageStatus: string;
        };
        // Mirror the server (shot-frame-edit.ts's editShotImage): the edit
        // just changed the image underneath any previously authored end
        // frame, so flag it stale for re-roll — the route doesn't echo this
        // decision back, so it's derived here from the current shot state.
        const hasEndFrame = !!state.shots.find((s) => s.id === shotId)?.endFramePath;
        dispatch({
          type: "patchShot",
          shotId,
          patch: {
            imagePath: data.imagePath,
            imageUrl: data.imageUrl,
            imageStatus: "done",
            ...(hasEndFrame ? { endFrameStatus: "pending" as const } : {}),
          },
        });
        return true;
      } catch (err) {
        console.error("[editor-store] image edit error:", err);
        // Same precondition as the non-ok branch above: restore "done", not
        // "failed" (final-review finding #2).
        dispatch({ type: "patchShot", shotId, patch: { imageStatus: "done" } });
        return false;
      }
    },
    [projectId, state.shots],
  );

  const generateClip = useCallback(
    async (shotId: string, model?: string) => {
      // Clear any stale transients from a previous generation — a fresh run
      // may chain / apply the camera move successfully, or fail differently.
      dispatch({
        type: "patchShot",
        shotId,
        patch: {
          clipStatus: "generating",
          endFrameSkippedReason: null,
          cameraBestEffort: false,
          refsApplied: 0,
          refsSkippedReason: null,
        },
      });
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
          endFrameSkippedReason?: string;
          cameraBestEffort?: boolean;
          refsApplied?: number;
          refsSkippedReason?: string;
        };
        if (data.endFrameSkippedReason) {
          console.warn(`[editor-store] end frame skipped: ${data.endFrameSkippedReason}`);
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
            endFrameSkippedReason: data.endFrameSkippedReason ?? null,
            cameraBestEffort: data.cameraBestEffort ?? false,
            refsApplied: data.refsApplied ?? 0,
            refsSkippedReason: data.refsSkippedReason ?? null,
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

  const createEndFrame = useCallback(
    async (shotId: string, instruction: string) => {
      dispatch({ type: "patchShot", shotId, patch: { endFrameStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/end-frame`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction }),
        });
        if (!res.ok) {
          console.warn("[editor-store] end frame creation failed:", await res.text());
          dispatch({ type: "patchShot", shotId, patch: { endFrameStatus: "failed" } });
          return;
        }
        const data = (await res.json()) as { endFramePath: string; endFrameUrl: string };
        dispatch({
          type: "patchShot",
          shotId,
          patch: {
            endFramePath: data.endFramePath,
            endFrameUrl: data.endFrameUrl,
            endFrameStatus: "done",
            // The route doesn't echo the instruction back in its response —
            // persist what was sent, matching what createShotEndFrame wrote
            // to the DB (shot-frame-edit.ts).
            endFrameInstruction: instruction,
          },
        });
      } catch (err) {
        console.error("[editor-store] end frame creation error:", err);
        dispatch({ type: "patchShot", shotId, patch: { endFrameStatus: "failed" } });
      }
    },
    [projectId],
  );

  const removeEndFrame = useCallback(
    async (shotId: string) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/end-frame`, {
          method: "DELETE",
        });
        if (!res.ok) {
          console.warn("[editor-store] end frame removal failed:", await res.text());
          return;
        }
        const data = (await res.json()) as {
          endFramePath: null;
          endFrameInstruction: null;
          endFrameStatus: string;
          endsOn: "free" | "next" | "custom";
        };
        // Response is authoritative for endsOn too — the route flips it back
        // to "free" when it was "custom" (DELETE semantics, end-frame route).
        dispatch({
          type: "patchShot",
          shotId,
          patch: {
            endFramePath: data.endFramePath,
            endFrameUrl: null,
            endFrameInstruction: data.endFrameInstruction,
            endFrameStatus: data.endFrameStatus,
            endsOn: data.endsOn,
          },
        });
      } catch (err) {
        console.error("[editor-store] end frame removal error:", err);
      }
    },
    [projectId],
  );

  // ── AI Assistant Director (Task 8) ──

  const [directorState, setDirectorState] = useState<Record<string, DirectorShotState>>({});
  // Per-shot "highest seq already merged" — lets every poll (interval tick
  // or one-off refresh) request only new events via ?since=, while events
  // themselves accumulate in directorState. A ref (not state) because it's
  // write-then-immediately-read within the same tick, never rendered.
  const directorSeqRef = useRef<Record<string, number>>({});
  // Mirrors directorState for the interval poll below, so its 3s timer
  // (set up once per active/inactive transition, not torn down every tick)
  // always reads the CURRENT set of running shot ids rather than whatever
  // was running when the interval was created.
  const directorStateRef = useRef<Record<string, DirectorShotState>>({});
  useEffect(() => {
    directorStateRef.current = directorState;
  }, [directorState]);

  /** One GET poll for a single shot's run+events, merged into directorState. 404 (no run ever started) resolves to `{ run: null, events: [] }` rather than leaving the shot unloaded, so callers never re-fetch it. */
  const pollDirectorOnce = useCallback(
    async (shotId: string) => {
      const since = directorSeqRef.current[shotId] ?? 0;
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/director?since=${since}`);
        if (res.status === 404) {
          setDirectorState((prev) => ({ ...prev, [shotId]: prev[shotId] ?? { run: null, events: [] } }));
          return;
        }
        if (!res.ok) {
          console.warn("[editor-store] director poll failed:", await res.text());
          return;
        }
        const data = (await res.json()) as { run: DirectorRunView; events: DirectorEventView[] };
        setDirectorState((prev) => {
          const prevEntry = prev[shotId];
          // Run boundary: a restart creates a NEW run whose seq count
          // starts over — the GET route always returns the shot's LATEST
          // run, so when its id differs from the tracked one, RESET the
          // feed to this batch instead of stacking the old run's history
          // under it. (The batch can be partial when this tick raced the
          // restart with the old run's high cursor; the cursor recompute
          // below drops back to the fresh batch's max, so the next poll
          // self-heals any gap.)
          const sameRun = prevEntry?.run?.id === data.run.id;
          const base = sameRun ? prevEntry?.events ?? [] : [];
          // Dedup by event id: a one-off refresh (start/stop) can race an
          // in-flight interval tick that read the same `since` cursor —
          // without this both would append the same rows (duplicate React
          // keys included).
          const seen = new Set(base.map((e) => e.id));
          const merged = [...base, ...data.events.filter((e) => !seen.has(e.id))];
          // Advance the cursor to the max seq actually present in state
          // after this merge — derived from `merged`, never from the raw
          // batch, so it can't run ahead of what's rendered. Writing the
          // ref inside the updater is safe: the write is idempotent, so
          // React's double-invoke of updaters lands the same value twice.
          directorSeqRef.current[shotId] = merged.reduce((max, e) => Math.max(max, e.seq), 0);
          return { ...prev, [shotId]: { run: data.run, events: merged } };
        });
      } catch (err) {
        console.error("[editor-store] director poll error:", err);
      }
    },
    [projectId],
  );

  const startDirector = useCallback(
    async (
      shotId: string,
      budgetUsd: number,
      guidance?: string,
      retryOfRunId?: string,
    ): Promise<boolean> => {
      try {
        const trimmed = guidance?.trim();
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/director`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            budgetUsd,
            ...(trimmed ? { guidance: trimmed } : {}),
            ...(retryOfRunId ? { retryOfRunId } : {}),
          }),
        });
        if (!res.ok) {
          console.warn("[editor-store] director start failed:", await res.text());
          return false;
        }
        // A brand-new run starts its own seq count at 0 — reset so the
        // immediate refresh below fetches its events from the beginning
        // rather than the previous run's high-water mark.
        directorSeqRef.current[shotId] = 0;
        await pollDirectorOnce(shotId);
        return true;
      } catch (err) {
        console.error("[editor-store] director start error:", err);
        return false;
      }
    },
    [projectId, pollDirectorOnce],
  );

  const stopDirector = useCallback(
    async (shotId: string): Promise<void> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/director/stop`, {
          method: "POST",
        });
        if (!res.ok) {
          console.warn("[editor-store] director stop failed:", await res.text());
          return;
        }
        await pollDirectorOnce(shotId);
      } catch (err) {
        console.error("[editor-store] director stop error:", err);
      }
    },
    [projectId, pollDirectorOnce],
  );

  // Re-fetches one shot's directing/generation fields from the authoritative
  // list route and merges them in — same source and field set the "generate
  // all" batch poll below uses, reused here because an approved director run
  // mutates the shot server-side (clip, settings, possibly the still) via
  // the same shots-row columns that route serializes. Only the returned
  // keys are patched, so unrelated local state (prompts mid-edit, tags,
  // selection) is untouched.
  const refreshShot = useCallback(
    async (shotId: string): Promise<void> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots`);
        if (!res.ok) {
          console.warn("[editor-store] shot refresh failed:", await res.text());
          return;
        }
        const { shots: freshShots } = (await res.json()) as { shots: EditorShot[] };
        const fresh = freshShots.find((s) => s.id === shotId);
        if (!fresh) return;
        dispatch({
          type: "patchShot",
          shotId,
          patch: {
            motionPrompt: fresh.motionPrompt,
            imagePath: fresh.imagePath,
            imageStatus: fresh.imageStatus,
            imageUrl: fresh.imageUrl,
            clipPath: fresh.clipPath,
            clipStatus: fresh.clipStatus,
            clipUrl: fresh.clipUrl,
            clipDurationSeconds: fresh.clipDurationSeconds,
            clipModel: fresh.clipModel,
            cameraMove: fresh.cameraMove,
            cameraStrength: fresh.cameraStrength,
            endsOn: fresh.endsOn,
            clipDurationChoice: fresh.clipDurationChoice,
            negativePrompt: fresh.negativePrompt,
            useEntityRefs: fresh.useEntityRefs,
            endFramePath: fresh.endFramePath,
            endFrameStatus: fresh.endFrameStatus,
            endFrameInstruction: fresh.endFrameInstruction,
            endFrameUrl: fresh.endFrameUrl,
            sfxPath: fresh.sfxPath,
            sfxStatus: fresh.sfxStatus,
            sfxUrl: fresh.sfxUrl,
            referencedEntityIds: fresh.referencedEntityIds,
          },
        });
      } catch (err) {
        console.error("[editor-store] shot refresh error:", err);
      }
    },
    [projectId],
  );

  const resolveDirector = useCallback(
    async (
      shotId: string,
      action: "approve" | "reject" | "dismiss",
      note?: string,
      approvedProposalIds?: number[],
    ): Promise<{ status: string; proposals: DirectorProposalResult[] } | null> => {
      try {
        const trimmedNote = note?.trim();
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/director/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            ...(trimmedNote ? { note: trimmedNote } : {}),
            ...(approvedProposalIds && approvedProposalIds.length > 0 ? { approvedProposalIds } : {}),
          }),
        });
        if (!res.ok) {
          // 409 (lost race — someone else resolved this run first) and 400
          // (bad state — e.g. already resolved from another tab) both mean
          // this client's view is stale, not that the action itself needs
          // retrying. Re-poll so directorState reflects whatever actually
          // happened server-side rather than leaving a now-invalid verdict
          // card on screen.
          console.warn("[editor-store] director resolve failed:", await res.text());
          await pollDirectorOnce(shotId);
          return null;
        }
        const data = (await res.json()) as {
          status: string;
          proposals?: DirectorProposalResult[];
        };
        const proposals = data.proposals ?? [];
        const failed = proposals.filter((p) => !p.applied);
        if (failed.length > 0) {
          // The clip promotion itself already succeeded (per director-resolve
          // route contract) — a proposal failure is reported, never fatal.
          console.warn("[editor-store] some approved proposals failed to apply:", failed);
        }
        if (action === "approve" && data.status === "approved") {
          // The shot row changed server-side (clip/settings/maybe image) —
          // pull it in the same way a batch poll would, so the promoted
          // clip appears without a manual reload.
          await refreshShot(shotId);
        }
        // The run's terminal status now lives server-side — re-poll so
        // directorState picks it up (the inspector's history-row logic
        // takes it from there).
        await pollDirectorOnce(shotId);
        return { status: data.status, proposals };
      } catch (err) {
        console.error("[editor-store] director resolve error:", err);
        return null;
      }
    },
    [projectId, pollDirectorOnce, refreshShot],
  );

  // "Mounted shot has an active run" — when selection moves onto a shot
  // whose director status has never been checked this session (e.g. a page
  // reload while a run is mid-flight), check it once. Guarded by the
  // directorState entry itself so a checked shot (even one that 404'd) is
  // never re-fetched by this effect again.
  useEffect(() => {
    if (state.selection?.type !== "shot") return;
    const shotId = state.selection.shotId;
    if (directorState[shotId]) return;
    pollDirectorOnce(shotId);
  }, [state.selection, directorState, pollDirectorOnce]);

  // 3s poll while any shot's director run is `running` OR `awaiting_approval`
  // (idiom: the batch poll above). `awaiting_approval` stays in this set —
  // unlike a run turning fully terminal (approved/rejected/stopped/failed,
  // which does drop out, since nothing more can change it — so one final
  // fetch inside startDirector/stopDirector/resolveDirector/the previous
  // tick is enough) — a run can sit in `awaiting_approval` indefinitely
  // while the user reads the verdict card, and another tab/session
  // resolving it in the meantime needs to be picked up here without the
  // user having to act first.
  const directorPollActive = useMemo(
    () =>
      Object.values(directorState).some(
        (s) => s.run?.status === "running" || s.run?.status === "awaiting_approval",
      ),
    [directorState],
  );
  useEffect(() => {
    if (!directorPollActive) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const pollableIds = Object.entries(directorStateRef.current)
          .filter(([, s]) => s.run?.status === "running" || s.run?.status === "awaiting_approval")
          .map(([id]) => id);
        await Promise.all(pollableIds.map((id) => pollDirectorOnce(id)));
      } finally {
        inFlight = false;
      }
    };
    const interval = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [directorPollActive, pollDirectorOnce]);

  const recommendShots = useCallback(async () => {
    setRecommending(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shots/recommend`, {
        method: "POST",
      });
      if (!res.ok) {
        console.error("[editor-store] recommend shots server error:", await res.text());
        return;
      }
      const data = (await res.json()) as { shots: EditorShot[] };
      // The recommend response rows are raw DB fields — no presigned URLs.
      const shots = data.shots.map((s) => ({
        ...s,
        imageUrl: null,
        clipUrl: null,
        sfxUrl: null,
        endFrameUrl: null,
      }));
      dispatch({ type: "setShots", shots });
    } catch (err) {
      console.error("[editor-store] recommend shots fetch failed:", err);
    } finally {
      setRecommending(false);
    }
  }, [projectId]);

  // ── Project-level mutations (Directing Controls task 9) ──
  // Optimistic-patch-then-revert, same idiom as updateShot/updateEntity —
  // only negativePrompt is settable today, but the patch shape leaves room
  // for future project-settings fields without a new helper.
  const saveProjectSettings = useCallback(
    async (patch: { negativePrompt?: string | null }) => {
      const prev = projectNegativePrompt;
      if (patch.negativePrompt !== undefined) setProjectNegativePrompt(patch.negativePrompt);
      try {
        const res = await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          console.warn("[editor-store] save project settings failed:", await res.text());
          if (patch.negativePrompt !== undefined) setProjectNegativePrompt(prev);
          return;
        }
        const updated = (await res.json()) as { negativePrompt?: string | null };
        if (patch.negativePrompt !== undefined) {
          setProjectNegativePrompt(updated.negativePrompt ?? null);
        }
      } catch (err) {
        console.error("[editor-store] save project settings error:", err);
        if (patch.negativePrompt !== undefined) setProjectNegativePrompt(prev);
      }
    },
    [projectId, projectNegativePrompt],
  );

  // ── Entity mutations ──

  const createEntity = useCallback(
    async (
      name: string,
      type: EditorEntity["type"],
      description?: string,
    ): Promise<boolean> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/entities`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type, description }),
        });
        if (!res.ok) {
          console.warn("[editor-store] create entity failed:", await res.text());
          return false;
        }
        const row = (await res.json()) as Partial<EditorEntity>;
        const entity: EditorEntity = { shotCount: 0, ...row } as EditorEntity;
        dispatch({ type: "addEntity", entity });
        return true;
      } catch (err) {
        console.error("[editor-store] create entity error:", err);
        return false;
      }
    },
    [projectId],
  );

  const updateEntity = useCallback(
    async (id: string, patch: Partial<Pick<EditorEntity, "name" | "description">>) => {
      const prevEntity = state.entities.find((e) => e.id === id);
      dispatch({ type: "patchEntity", entityId: id, patch });
      try {
        const res = await fetch(`/api/projects/${projectId}/entities/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          console.warn("[editor-store] update entity failed:", await res.text());
          if (prevEntity) dispatch({ type: "patchEntity", entityId: id, patch: prevEntity });
          return;
        }
        const updated = (await res.json()) as Partial<EditorEntity>;
        // Spread-merge so client-only fields survive — the PATCH response
        // carries the raw DB row + a fresh referenceSheetUrl.
        dispatch({ type: "patchEntity", entityId: id, patch: updated });
      } catch (err) {
        console.error("[editor-store] update entity error:", err);
        if (prevEntity) dispatch({ type: "patchEntity", entityId: id, patch: prevEntity });
      }
    },
    [projectId, state.entities],
  );

  const deleteEntity = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/entities/${id}`, {
          method: "DELETE",
        });
        if (res.ok) {
          dispatch({ type: "removeEntity", entityId: id });
        } else {
          console.warn("[editor-store] delete entity failed:", await res.text());
        }
      } catch (err) {
        console.error("[editor-store] delete entity error:", err);
      }
    },
    [projectId],
  );

  const generateReference = useCallback(
    async (id: string) => {
      dispatch({ type: "patchEntity", entityId: id, patch: { referenceStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/entities/${id}/reference`, {
          method: "POST",
        });
        if (!res.ok) {
          console.warn("[editor-store] generate reference failed:", await res.text());
          dispatch({
            type: "patchEntity",
            entityId: id,
            patch: { referenceStatus: "failed" },
          });
          return;
        }
        const updated = (await res.json()) as Partial<EditorEntity>;
        // Spread-merge so client-only fields survive — the response
        // carries the fresh referenceSheetUrl + referenceStatus: "done".
        dispatch({ type: "patchEntity", entityId: id, patch: updated });
      } catch (err) {
        console.error("[editor-store] generate reference error:", err);
        dispatch({
          type: "patchEntity",
          entityId: id,
          patch: { referenceStatus: "failed" },
        });
      }
    },
    [projectId],
  );

  const extractEntities = useCallback(async (): Promise<{
    created: number;
    taggedShots: number;
  } | null> => {
    setExtracting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/entities/extract`, {
        method: "POST",
      });
      if (!res.ok) {
        console.error("[editor-store] extract entities server error:", await res.text());
        return null;
      }
      const data = (await res.json()) as {
        entities: EditorEntity[];
        taggedShots: number;
        created: number;
        skipped: number;
        shotTags: Record<string, string[]>;
      };
      // The extract response is the full authoritative entity list (raw
      // rows + urls + shotCount) — replace wholesale, same idiom as
      // recommendShots replacing the shot list.
      dispatch({ type: "setEntities", entities: data.entities });
      for (const [shotId, entityIds] of Object.entries(data.shotTags)) {
        dispatch({ type: "patchShot", shotId, patch: { referencedEntityIds: entityIds } });
      }
      // The response is the exact authoritative counts — return them so
      // callers don't have to diff stale store snapshots after the await.
      return { created: data.created, taggedShots: data.taggedShots };
    } catch (err) {
      console.error("[editor-store] extract entities fetch failed:", err);
      return null;
    } finally {
      setExtracting(false);
    }
  }, [projectId]);

  const tagShot = useCallback(
    (shotId: string, entityIds: string[]) => updateShot(shotId, { referencedEntityIds: entityIds }),
    [updateShot],
  );

  // ── Batch "Generate all" (v4 P3) ──
  // graceActive opens a grace window between POST and the orchestrator's
  // first status flip, so batchActive doesn't flicker false before wave 1.
  // It closes on the first observed running row OR after 60s via a real
  // timeout — whichever comes first — so batchActive can never stick true
  // if the dispatched work dies before ever flipping a status.
  const [graceActive, setGraceActive] = useState(false);
  const graceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (graceTimeoutRef.current) clearTimeout(graceTimeoutRef.current);
    },
    [],
  );

  const fetchGenerateAllPreview = useCallback(
    async (opts?: {
      clipModel?: string;
      includeSfx?: boolean;
    }): Promise<GenerateAllPreview | null> => {
      try {
        const qs = new URLSearchParams();
        if (opts?.clipModel) qs.set("clipModel", opts.clipModel);
        if (opts?.includeSfx) qs.set("includeSfx", "true");
        const res = await fetch(
          `/api/projects/${projectId}/generate-all/preview${qs.size ? `?${qs}` : ""}`,
        );
        if (!res.ok) return null;
        return (await res.json()) as GenerateAllPreview;
      } catch (err) {
        console.error("[editor-store] preview fetch error:", err);
        return null;
      }
    },
    [projectId],
  );

  const generateAll = useCallback(
    async (opts: {
      includeClips: boolean;
      clipModel?: string;
      suggestChains?: boolean;
      includeSfx?: boolean;
    }): Promise<boolean> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/generate-all`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });
        if (!res.ok) {
          console.warn("[editor-store] generate-all dispatch failed:", await res.text());
          return false;
        }
        const data = (await res.json()) as { dispatched: boolean };
        if (data.dispatched) {
          if (graceTimeoutRef.current) clearTimeout(graceTimeoutRef.current);
          setGraceActive(true);
          graceTimeoutRef.current = setTimeout(() => setGraceActive(false), 60_000);
        }
        return data.dispatched;
      } catch (err) {
        console.error("[editor-store] generate-all error:", err);
        return false;
      }
    },
    [projectId],
  );

  const anyRowGenerating = useMemo(
    () =>
      state.entities.some((e) => e.referenceStatus === "generating") ||
      state.shots.some(
        (s) => s.imageStatus === "generating" || s.clipStatus === "generating",
      ),
    [state.entities, state.shots],
  );
  // 60s grace after dispatch covers the Inngest pickup delay.
  const batchActive = anyRowGenerating || graceActive;

  // Poll while a batch is live (covers on-load detection too: rows already
  // `generating` at mount start the loop). Merges ONLY generation fields so
  // in-flight local edits (prompts, offsets, tags) are never clobbered.
  useEffect(() => {
    if (!batchActive) return;
    let cancelled = false;
    // A tick that fires while a poll is still in flight is skipped: slow
    // responses (dev compiles, cold routes) would otherwise overlap and
    // resolve out of order, letting an older snapshot (statuses pending,
    // urls null) overwrite the newer merged state. No overlap → no
    // reordering, so no sequence counter is needed.
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
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
              clipModel: f.clipModel,
              endsOn: f.endsOn,
              endFramePath: f.endFramePath,
              endFrameStatus: f.endFrameStatus,
              endFrameUrl: f.endFrameUrl,
              sfxPath: f.sfxPath,
              sfxStatus: f.sfxStatus,
              sfxUrl: f.sfxUrl,
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
        if (running) {
          if (graceTimeoutRef.current) clearTimeout(graceTimeoutRef.current);
          setGraceActive(false);
        }
      } catch (err) {
        console.error("[editor-store] batch poll error:", err);
      } finally {
        inFlight = false;
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [batchActive, projectId]);

  const value: EditorContextValue = {
    projectId,
    projectNegativePrompt,
    saveProjectSettings,
    beats: state.beats,
    shots: state.shots,
    entities: state.entities,
    totalDuration,
    view: state.view,
    setView,
    selection: state.selection,
    select,
    revoiceBeat,
    createShot,
    updateShot,
    deleteShot,
    splitShot,
    generateImage,
    editShotImage,
    generateClip,
    generateSfx,
    removeSfx,
    createEndFrame,
    removeEndFrame,
    recommendShots,
    recommending,
    createEntity,
    updateEntity,
    deleteEntity,
    generateReference,
    extractEntities,
    extracting,
    tagShot,
    fetchGenerateAllPreview,
    generateAll,
    batchActive,
    startDirector,
    stopDirector,
    resolveDirector,
    directorState,
  };

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used within an EditorProvider");
  return ctx;
}

// ── Pure helpers ──

const BEAT_HUES = [258, 38, 152, 205, 328, 96]; // purple, amber, green, blue, pink, lime — mockup palette

export function beatColor(index: number) {
  const h = BEAT_HUES[index % BEAT_HUES.length];
  return {
    block: `hsl(${h} 45% 38%)`,
    textUnderline: `hsl(${h} 70% 55%)`,
  };
}

export function absoluteShotRange(
  shot: EditorShot,
  beats: EditorBeat[],
): { start: number; end: number } | null {
  if (!shot.beatId || shot.startInBeat == null || shot.endInBeat == null) return null;
  const beat = beats.find((b) => b.id === shot.beatId);
  if (!beat) return null;
  return { start: beat.startSeconds + shot.startInBeat, end: beat.startSeconds + shot.endInBeat };
}

/**
 * The entity whose reference sheet conditions this shot's image — MUST
 * mirror the server's resolvePrimaryEntity rule (shot image route): among
 * tagged entities with a finished sheet, in tag order, the first CHARACTER
 * wins; otherwise the first with a sheet. Null → unconditioned generation.
 */
export function primaryEntityOfShot(
  shot: EditorShot,
  entities: EditorEntity[],
): EditorEntity | null {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const ready = (shot.referencedEntityIds ?? [])
    .map((id) => byId.get(id))
    .filter((e): e is EditorEntity => !!e && e.referenceStatus === "done");
  return ready.find((e) => e.type === "character") ?? ready[0] ?? null;
}

/**
 * Every beat a shot's time range overlaps, in order. Shots may span beat
 * boundaries (anchor-beat spillover), so narration display concatenates
 * these beats' text and labels read "beat N" or "beats N–M".
 */
export function beatsSpanned(shot: EditorShot, beats: EditorBeat[]): EditorBeat[] {
  const range = absoluteShotRange(shot, beats);
  if (!range) return [];
  // Zero-duration beats (unvoiced) carry no narration — skip them so they
  // never pad the joined text or widen the "beats N–M" label.
  return beats.filter(
    (b) =>
      b.endSeconds > b.startSeconds &&
      b.startSeconds < range.end &&
      b.endSeconds > range.start,
  );
}

/**
 * Live shot count for an entity, recomputed from the current `shots` slice
 * rather than trusting the server's as-fetched `shotCount` — see the store
 * header comment for the single-source-of-truth rationale.
 */
export function entityShotCount(entityId: string, shots: EditorShot[]): number {
  return shots.filter((s) => s.referencedEntityIds.includes(entityId)).length;
}

/**
 * Every entity tagged onto a shot, in TAG order (referencedEntityIds), not
 * entity-list order — must mirror the server's loadTaggedEntities
 * (shot-clip-generation.ts): tag order decides which sheets survive the
 * first-4 reference cap, so any list derived from this (e.g. the "Cast &
 * locations featured" names) reflects what actually rides into the clip.
 * Unknown ids (entity deleted, stale tag) are dropped.
 */
export function entitiesOfShot(shot: EditorShot, entities: EditorEntity[]): EditorEntity[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  return (shot.referencedEntityIds ?? [])
    .map((id) => byId.get(id))
    .filter((e): e is EditorEntity => e !== undefined);
}
