/**
 * Cast & Locations rail panel (v4.0 Phase 4, Reference Bible — F-16, Task 6).
 *
 * Left-rail renderer over the shared `useEditor()` store (mockup 01): one
 * card per project entity (character/location/object) showing its
 * reference-sheet thumbnail (or a type-icon placeholder / generating
 * spinner / failed ring), its name, and a live "{type} · {n} shots" line —
 * always via the exported `entityShotCount` selector, never the server's
 * as-fetched `entity.shotCount`, which goes stale the instant a shot is
 * tagged/untagged locally (see the store's header comment for why).
 *
 * Clicking a card expands it inline for rename/redraw/delete; clicking the
 * sheet thumbnail (or the expanded preview) opens a full-screen lightbox so
 * the multi-view sheet can actually be inspected. The footer adds entities
 * by hand or via Claude auto-extract. This component makes no direct
 * network calls — every mutation goes through `useEditor()`.
 */
"use client";

import { useEffect, useState } from "react";
import { User, Mountain, Box, Loader2, Sparkles, Plus, X, RefreshCw, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useEditor,
  entityShotCount,
  type EditorEntity,
  type EditorShot,
} from "@/components/editor/editor-store";

const TYPE_ICON: Record<EditorEntity["type"], LucideIcon> = {
  character: User,
  location: Mountain,
  object: Box,
};

const TYPE_OPTIONS: Array<{ value: EditorEntity["type"]; label: string }> = [
  { value: "character", label: "Character" },
  { value: "location", label: "Location" },
  { value: "object", label: "Object" },
];

export function ReferenceBiblePanel() {
  const { entities, shots, extractEntities, extracting } = useEditor();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [extractMessage, setExtractMessage] = useState<string | null>(null);
  // Lightbox target — held as an id and resolved each render so the viewer
  // stays fresh if the entity is renamed/redrawn/deleted while open.
  const [viewerId, setViewerId] = useState<string | null>(null);
  const viewerEntity = viewerId ? entities.find((e) => e.id === viewerId) ?? null : null;

  useEffect(() => {
    if (!extractMessage) return;
    const timer = setTimeout(() => setExtractMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [extractMessage]);

  // If the expanded card's entity is deleted (locally or by the extract
  // wholesale-replace), drop the stale expandedId so a later card never
  // re-expands under a reused id.
  useEffect(() => {
    if (expandedId && !entities.some((e) => e.id === expandedId)) {
      setExpandedId(null);
    }
  }, [expandedId, entities]);

  const handleExtract = async () => {
    // The store's extractEntities() returns the exact counts from the API
    // response — no need to diff store snapshots (which would be stale
    // right after the await, since passive effects run after paint).
    const result = await extractEntities();
    setExtractMessage(
      result
        ? `${result.created} found · ${result.taggedShots} shots tagged`
        : "Extraction failed",
    );
  };

  return (
    <aside className="w-56 shrink-0">
      <div className="sticky top-4 space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Cast &amp; Locations
        </h3>

        {entities.length === 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Recurring characters &amp; places get one AI-generated reference sheet each, so every
            shot tagged with them stays visually consistent.
          </p>
        ) : (
          <div className="space-y-2">
            {entities.map((entity) => (
              <EntityCard
                key={entity.id}
                entity={entity}
                shots={shots}
                expanded={expandedId === entity.id}
                onToggle={() => setExpandedId((cur) => (cur === entity.id ? null : entity.id))}
                onViewSheet={() => setViewerId(entity.id)}
              />
            ))}
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          {showAddForm ? (
            <AddEntityForm onDone={() => setShowAddForm(false)} />
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => setShowAddForm(true)}
            >
              <Plus className="size-3.5" />
              Add entity
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={handleExtract}
            disabled={extracting}
          >
            {extracting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            Auto-extract from script
          </Button>

          {extractMessage && (
            <p className="text-[10px] text-muted-foreground">{extractMessage}</p>
          )}
        </div>

        <p className="text-[11px] leading-4 text-muted-foreground">
          Each entity = one multi-view reference sheet. Tagged shots condition on it.
        </p>
      </div>

      {viewerEntity?.referenceSheetUrl && (
        <SheetLightbox entity={viewerEntity} onClose={() => setViewerId(null)} />
      )}
    </aside>
  );
}

// ─── Full-screen sheet viewer ─────────────────────────────────────────

function SheetLightbox({
  entity,
  onClose,
}: {
  entity: EditorEntity;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-6"
      onClick={onClose}
      role="dialog"
      aria-label={`${entity.name} reference sheet`}
    >
      <button
        type="button"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/25"
        onClick={onClose}
        title="Close (Esc)"
      >
        <X className="size-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={entity.referenceSheetUrl!}
        alt={`${entity.name} reference sheet`}
        className="max-h-[82vh] max-w-[92vw] rounded object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <div
        className="max-w-2xl text-center text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold">
          {entity.name} <span className="font-normal text-white/60">· {entity.type}</span>
        </p>
        {entity.description && (
          <p className="mt-1 text-xs leading-5 text-white/70">{entity.description}</p>
        )}
      </div>
    </div>
  );
}

// ─── Entity card ───────────────────────────────────────────────────────

function EntityCard({
  entity,
  shots,
  expanded,
  onToggle,
  onViewSheet,
}: {
  entity: EditorEntity;
  shots: EditorShot[];
  expanded: boolean;
  onToggle: () => void;
  onViewSheet: () => void;
}) {
  const { updateEntity, deleteEntity, generateReference } = useEditor();
  const shotCount = entityShotCount(entity.id, shots);
  const Icon = TYPE_ICON[entity.type];
  const generating = entity.referenceStatus === "generating";
  const failed = entity.referenceStatus === "failed";

  const [name, setName] = useState(entity.name);
  const [description, setDescription] = useState(entity.description);
  useEffect(() => {
    setName(entity.name);
    setDescription(entity.description);
  }, [entity.id, entity.name, entity.description]);

  const persistName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== entity.name) updateEntity(entity.id, { name: trimmed });
  };
  const persistDescription = () => {
    if (description !== entity.description) updateEntity(entity.id, { description });
  };

  return (
    <Card size="sm" className={`gap-2 p-2 ${failed ? "ring-2 ring-destructive" : ""}`}>
      <div className="flex cursor-pointer items-center gap-2" onClick={onToggle}>
        <div
          className={`relative size-10 shrink-0 overflow-hidden rounded bg-muted ${
            entity.referenceSheetUrl ? "cursor-zoom-in" : ""
          }`}
          title={entity.referenceSheetUrl ? "View reference sheet" : undefined}
          onClick={
            entity.referenceSheetUrl
              ? (e) => {
                  e.stopPropagation(); // view the sheet, don't toggle the card
                  onViewSheet();
                }
              : undefined
          }
        >
          {entity.referenceSheetUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={entity.referenceSheetUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <Icon className="size-4" />
            </div>
          )}
          {generating && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70">
              <Loader2 className="size-4 animate-spin" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{entity.name}</p>
          <p className="text-[10px] text-muted-foreground">
            {entity.type} · {shotCount} shots
          </p>
        </div>
      </div>

      {expanded && (
        <div className="space-y-2 pt-1">
          {entity.referenceSheetUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={entity.referenceSheetUrl}
              alt={`${entity.name} reference sheet`}
              title="View full size"
              className="w-full cursor-zoom-in rounded border object-cover"
              onClick={onViewSheet}
            />
          )}
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Name
            </p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={persistName}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Description
            </p>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={persistDescription}
              rows={3}
              placeholder="Visual description for the reference sheet…"
              className="text-xs"
            />
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 text-[11px]"
              disabled={generating}
              onClick={() => generateReference(entity.id)}
            >
              {generating ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Redraw
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 text-[11px]"
              onClick={() => deleteEntity(entity.id)}
            >
              <Trash2 className="size-3" />
              Delete
            </Button>
          </div>
          {failed && (
            <p className="text-[10px] text-destructive">
              Sheet generation failed. Redraw to retry.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Add-entity mini-form ──────────────────────────────────────────────

function AddEntityForm({ onDone }: { onDone: () => void }) {
  const { createEntity } = useEditor();
  const [name, setName] = useState("");
  const [type, setType] = useState<EditorEntity["type"]>("character");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const ok = await createEntity(trimmed, type, description.trim() || undefined);
      if (ok) {
        onDone();
      } else {
        setFailed(true);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg border p-2">
      <Input
        placeholder="Name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setFailed(false);
        }}
        className="h-7 text-xs"
      />
      <Select value={type} onValueChange={(v) => setType(v as EditorEntity["type"])}>
        <SelectTrigger className="h-7 w-full text-xs" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TYPE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        className="text-xs"
      />
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7 flex-1 text-[11px]"
          onClick={handleCreate}
          disabled={!name.trim() || creating}
        >
          {creating ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          Create
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          onClick={onDone}
          disabled={creating}
        >
          <X className="size-3" />
          Cancel
        </Button>
      </div>
      {failed && (
        <p className="text-[10px] text-destructive">
          Couldn&apos;t create — an entity with this name may already exist.
        </p>
      )}
    </div>
  );
}
