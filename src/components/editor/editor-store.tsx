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
  useMemo,
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
  // Optional (not yet populated by page.tsx until Task 7 wires the server
  // mapping) — helpers and reducer paths must tolerate undefined via `?? []`.
  referencedEntityIds?: string[];
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
          (s.referencedEntityIds ?? []).includes(action.entityId)
            ? {
                ...s,
                referencedEntityIds: (s.referencedEntityIds ?? []).filter(
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
  ): Promise<void>;
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
      >
    >,
  ): Promise<void>;
  deleteShot(shotId: string): Promise<void>;
  splitShot(shotId: string, atInBeat: number): Promise<void>;
  generateImage(shotId: string): Promise<void>;
  generateClip(shotId: string, model?: "ltx" | "hailuo"): Promise<void>;
  recommendShots(): Promise<void>;
  recommending: boolean;
  createEntity(
    name: string,
    type: EditorEntity["type"],
    description?: string,
  ): Promise<void>;
  updateEntity(
    id: string,
    patch: Partial<Pick<EditorEntity, "name" | "description">>,
  ): Promise<void>;
  deleteEntity(id: string): Promise<void>;
  generateReference(id: string): Promise<void>;
  extractEntities(): Promise<void>;
  extracting: boolean;
  tagShot(shotId: string, entityIds: string[]): Promise<void>;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider(props: {
  projectId: string;
  initialBeats: EditorBeat[];
  initialShots: EditorShot[];
  initialEntities?: EditorEntity[];
  children: ReactNode;
}) {
  const { projectId, initialBeats, initialShots, initialEntities = [], children } = props;

  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    beats: withOffsets(initialBeats),
    shots: initialShots,
    entities: initialEntities,
    view: "timeline" as EditorView,
    selection: null as EditorSelection,
  }));
  const [recommending, setRecommending] = useState(false);
  const [extracting, setExtracting] = useState(false);

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
    ) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beatId, startInBeat, endInBeat, imagePrompt, motionPrompt }),
        });
        if (!res.ok) {
          console.warn("[editor-store] create shot failed:", await res.text());
          return;
        }
        const shot = (await res.json()) as EditorShot;
        dispatch({ type: "addShot", shot });
        dispatch({ type: "select", selection: { type: "shot", shotId: shot.id } });
      } catch (err) {
        console.error("[editor-store] create shot error:", err);
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
        >
      >,
    ) => {
      const prevShot = state.shots.find((s) => s.id === shotId);
      dispatch({ type: "patchShot", shotId, patch });
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          console.warn("[editor-store] update shot failed:", await res.text());
          if (prevShot) dispatch({ type: "patchShot", shotId, patch: prevShot });
          return;
        }
        const updated = (await res.json()) as Partial<EditorShot>;
        // Spread-merge so client-only fields (imageUrl, clipUrl) survive —
        // the PATCH response only contains raw DB fields.
        dispatch({ type: "patchShot", shotId, patch: updated });
      } catch (err) {
        console.error("[editor-store] update shot error:", err);
        if (prevShot) dispatch({ type: "patchShot", shotId, patch: prevShot });
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

  const generateClip = useCallback(
    async (shotId: string, model: "ltx" | "hailuo" = "ltx") => {
      const endpoint = model === "hailuo" ? "clip-hailuo" : "clip";
      dispatch({ type: "patchShot", shotId, patch: { clipStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/${endpoint}`, {
          method: "POST",
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
        };
        dispatch({
          type: "patchShot",
          shotId,
          patch: {
            clipPath: data.clipPath,
            clipUrl: data.clipUrl,
            clipStatus: "done",
            clipDurationSeconds: data.clipDurationSeconds,
          },
        });
      } catch (err) {
        console.error("[editor-store] clip generation error:", err);
        dispatch({ type: "patchShot", shotId, patch: { clipStatus: "failed" } });
      }
    },
    [projectId],
  );

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
      const shots = data.shots.map((s) => ({ ...s, imageUrl: null, clipUrl: null }));
      dispatch({ type: "setShots", shots });
    } catch (err) {
      console.error("[editor-store] recommend shots fetch failed:", err);
    } finally {
      setRecommending(false);
    }
  }, [projectId]);

  // ── Entity mutations ──

  const createEntity = useCallback(
    async (name: string, type: EditorEntity["type"], description?: string) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/entities`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type, description }),
        });
        if (!res.ok) {
          console.warn("[editor-store] create entity failed:", await res.text());
          return;
        }
        const entity = (await res.json()) as EditorEntity;
        dispatch({ type: "addEntity", entity });
      } catch (err) {
        console.error("[editor-store] create entity error:", err);
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
      const prevEntity = state.entities.find((e) => e.id === id);
      dispatch({ type: "patchEntity", entityId: id, patch: { referenceStatus: "generating" } });
      try {
        const res = await fetch(`/api/projects/${projectId}/entities/${id}/reference`, {
          method: "POST",
        });
        if (!res.ok) {
          console.warn("[editor-store] generate reference failed:", await res.text());
          if (prevEntity) {
            dispatch({
              type: "patchEntity",
              entityId: id,
              patch: { referenceStatus: prevEntity.referenceStatus },
            });
          }
          return;
        }
        const updated = (await res.json()) as Partial<EditorEntity>;
        // Spread-merge so client-only fields survive — the response
        // carries the fresh referenceSheetUrl + referenceStatus: "done".
        dispatch({ type: "patchEntity", entityId: id, patch: updated });
      } catch (err) {
        console.error("[editor-store] generate reference error:", err);
        if (prevEntity) {
          dispatch({
            type: "patchEntity",
            entityId: id,
            patch: { referenceStatus: prevEntity.referenceStatus },
          });
        }
      }
    },
    [projectId, state.entities],
  );

  const extractEntities = useCallback(async () => {
    setExtracting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/entities/extract`, {
        method: "POST",
      });
      if (!res.ok) {
        console.error("[editor-store] extract entities server error:", await res.text());
        return;
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
    } catch (err) {
      console.error("[editor-store] extract entities fetch failed:", err);
    } finally {
      setExtracting(false);
    }
  }, [projectId]);

  const tagShot = useCallback(
    (shotId: string, entityIds: string[]) => updateShot(shotId, { referencedEntityIds: entityIds }),
    [updateShot],
  );

  const value: EditorContextValue = {
    projectId,
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
    generateClip,
    recommendShots,
    recommending,
    createEntity,
    updateEntity,
    deleteEntity,
    generateReference,
    extractEntities,
    extracting,
    tagShot,
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
  return shots.filter((s) => (s.referencedEntityIds ?? []).includes(entityId)).length;
}

/** Every entity tagged onto a shot, in entity-list order. */
export function entitiesOfShot(shot: EditorShot, entities: EditorEntity[]): EditorEntity[] {
  const ids = shot.referencedEntityIds ?? [];
  return entities.filter((e) => ids.includes(e.id));
}
