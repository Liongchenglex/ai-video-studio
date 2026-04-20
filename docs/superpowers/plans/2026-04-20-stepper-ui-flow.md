# Stepper UI Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the project workspace into a 3-step stepper flow: Step 1 (Video Concept) → Step 2 (Style) → Step 3 (Script) — with a collapsible brief summary on Step 3 for quick editing without navigating back.

**Architecture:** A new `ProjectStepper` component manages the current step and renders the appropriate content. The existing `VideoBrief`, style components, and `ScriptTable` are reused as-is — they just move into step containers. A new `BriefSummary` component shows a collapsed view of the brief on Step 3 with an expand-to-edit toggle. No API or schema changes needed.

**Tech Stack:** React 19, shadcn/ui, Tailwind CSS v4, Lucide icons.

---

## File Structure

```
src/
├── components/
│   ├── project-stepper.tsx          # CREATE — stepper header bar + step navigation
│   ├── brief-summary.tsx            # CREATE — collapsible brief display for Step 3
│   ├── step-concept.tsx             # CREATE — Step 1 content (brief + duration + tone)
│   ├── step-style.tsx               # CREATE — Step 2 content (existing style profile UI)
│   ├── step-script.tsx              # CREATE — Step 3 content (brief summary + script table)
│   ├── project-workspace.tsx        # REWRITE — orchestrate stepper + state management
│   └── video-brief.tsx              # MODIFY — remove Generate Script button (moves to Step 3)
└── app/
    └── projects/
        └── [id]/
            └── page.tsx             # NO CHANGE — already passes all needed data
```

---

## Task 1: Project Stepper Component

**Files:**
- Create: `src/components/project-stepper.tsx`

A horizontal stepper bar showing 3 steps. Clickable to navigate between steps. Shows completion state per step.

- [ ] **Step 1: Create the stepper component**

Create `src/components/project-stepper.tsx`:

```typescript
/**
 * Horizontal stepper navigation for the project workspace.
 * Shows 3 steps: Concept → Style → Script.
 * Steps are clickable for navigation. Shows completion state.
 */
"use client";

import { Check } from "lucide-react";

interface Step {
  label: string;
  description: string;
  completed: boolean;
}

interface ProjectStepperProps {
  currentStep: number;
  steps: Step[];
  onStepClick: (step: number) => void;
}

export function ProjectStepper({
  currentStep,
  steps,
  onStepClick,
}: ProjectStepperProps) {
  return (
    <nav className="mb-8">
      <ol className="flex items-center">
        {steps.map((step, index) => (
          <li key={index} className="flex items-center flex-1">
            <button
              onClick={() => onStepClick(index)}
              className="flex items-center gap-3 group w-full"
            >
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-medium transition-colors ${
                  index === currentStep
                    ? "border-primary bg-primary text-primary-foreground"
                    : step.completed
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-muted-foreground/30 text-muted-foreground"
                }`}
              >
                {step.completed && index !== currentStep ? (
                  <Check className="h-4 w-4" />
                ) : (
                  index + 1
                )}
              </div>
              <div className="hidden sm:block text-left">
                <p
                  className={`text-sm font-medium ${
                    index === currentStep
                      ? "text-foreground"
                      : "text-muted-foreground group-hover:text-foreground"
                  }`}
                >
                  {step.label}
                </p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </button>
            {index < steps.length - 1 && (
              <div
                className={`mx-4 h-px flex-1 ${
                  step.completed ? "bg-primary" : "bg-muted-foreground/30"
                }`}
              />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/project-stepper.tsx
git commit -m "feat: add project stepper navigation component"
```

---

## Task 2: Brief Summary Component (for Step 3)

**Files:**
- Create: `src/components/brief-summary.tsx`

Shows the video concept as a collapsed read-only summary with an "Edit" toggle that expands to a full editable brief. Used on Step 3 so the user can tweak the brief without navigating back to Step 1.

- [ ] **Step 1: Create the brief summary component**

Create `src/components/brief-summary.tsx`:

```typescript
/**
 * Collapsible video concept summary for the Script step.
 * Shows brief, duration, and tone in a compact read-only view.
 * Expands to an editable form when the user clicks Edit.
 */
"use client";

import { useState, useCallback } from "react";
import { ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface BriefSummaryProps {
  projectId: string;
  brief: string;
  duration: number;
  tone: string;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
}

const DURATIONS = [
  { value: "3", label: "3 min" },
  { value: "5", label: "5 min" },
  { value: "8", label: "8 min" },
  { value: "10", label: "10 min" },
];

const TONES = [
  { value: "educational", label: "Educational" },
  { value: "entertaining", label: "Entertaining" },
  { value: "documentary", label: "Documentary" },
  { value: "satirical", label: "Satirical" },
];

function toneLabel(value: string): string {
  return TONES.find((t) => t.value === value)?.label || value;
}

export function BriefSummary({
  projectId,
  brief,
  duration,
  tone,
  onBriefChange,
  onDurationChange,
  onToneChange,
}: BriefSummaryProps) {
  const [editing, setEditing] = useState(false);
  const [localBrief, setLocalBrief] = useState(brief);

  const saveField = useCallback(
    async (field: string, value: string | number) => {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
    },
    [projectId],
  );

  const handleSaveBrief = useCallback(() => {
    const trimmed = localBrief.trim();
    if (trimmed && trimmed !== brief) {
      onBriefChange(trimmed);
      saveField("brief", trimmed);
    }
    setEditing(false);
  }, [localBrief, brief, onBriefChange, saveField]);

  const handleDurationChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      const num = Number(value);
      onDurationChange(num);
      saveField("targetDuration", num);
    },
    [onDurationChange, saveField],
  );

  const handleToneChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      onToneChange(value);
      saveField("tone", value);
    },
    [onToneChange, saveField],
  );

  if (editing) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Video concept</h3>
          <Button variant="ghost" size="sm" onClick={handleSaveBrief}>
            <ChevronUp className="mr-1 h-3 w-3" />
            Done
          </Button>
        </div>
        <Textarea
          value={localBrief}
          onChange={(e) => setLocalBrief(e.target.value)}
          rows={4}
          className="resize-none"
        />
        <div className="flex gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Duration</Label>
            <Select value={String(duration)} onValueChange={handleDurationChange}>
              <SelectTrigger className="h-8 w-[120px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Tone</Label>
            <Select value={tone} onValueChange={handleToneChange}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TONES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium mb-1">Video concept</h3>
          <p className="text-sm text-muted-foreground line-clamp-2">{brief}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {duration} min · {toneLabel(tone)}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { setLocalBrief(brief); setEditing(true); }}>
          <Pencil className="mr-1 h-3 w-3" />
          Edit
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/brief-summary.tsx
git commit -m "feat: add collapsible brief summary component for script step"
```

---

## Task 3: Step Content Components

**Files:**
- Create: `src/components/step-concept.tsx`
- Create: `src/components/step-style.tsx`
- Create: `src/components/step-script.tsx`
- Modify: `src/components/video-brief.tsx`

Each step gets its own wrapper component that contains the relevant UI. This keeps the main workspace orchestrator clean.

- [ ] **Step 1: Modify VideoBrief to remove the Generate Script button**

The Generate Script button moves to Step 3. VideoBrief becomes a pure input form. In `src/components/video-brief.tsx`, remove the `onGenerateScript`, `generating`, and `hasScenes` props and the button. Also add a `Next` button to advance to Step 2.

Replace the entire file with:

```typescript
/**
 * Video brief input section. Captures the creative brief, target duration,
 * and tone — the three inputs that feed script generation (F-03).
 * Used on Step 1 of the project stepper.
 */
"use client";

import { useState, useCallback } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface VideoBriefProps {
  projectId: string;
  initialBrief: string;
  initialDuration: number;
  initialTone: string;
  onNext: () => void;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
}

const DURATIONS = [
  { value: "3", label: "3 minutes" },
  { value: "5", label: "5 minutes" },
  { value: "8", label: "8 minutes" },
  { value: "10", label: "10 minutes" },
];

const TONES = [
  { value: "educational", label: "Educational" },
  { value: "entertaining", label: "Entertaining" },
  { value: "documentary", label: "Documentary" },
  { value: "satirical", label: "Satirical" },
];

export function VideoBrief({
  projectId,
  initialBrief,
  initialDuration,
  initialTone,
  onNext,
  onBriefChange,
  onDurationChange,
  onToneChange,
}: VideoBriefProps) {
  const [brief, setBrief] = useState(initialBrief);
  const [duration, setDuration] = useState(String(initialDuration));
  const [tone, setTone] = useState(initialTone);

  const saveField = useCallback(
    async (field: string, value: string | number) => {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
    },
    [projectId],
  );

  const handleBriefBlur = useCallback(() => {
    if (brief.trim()) {
      onBriefChange(brief.trim());
      saveField("brief", brief.trim());
    }
  }, [brief, saveField, onBriefChange]);

  const handleDurationChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      setDuration(value);
      onDurationChange(Number(value));
      saveField("targetDuration", Number(value));
    },
    [saveField, onDurationChange],
  );

  const handleToneChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      setTone(value);
      onToneChange(value);
      saveField("tone", value);
    },
    [saveField, onToneChange],
  );

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Video concept</h2>
        <p className="text-sm text-muted-foreground">
          Describe what your video is about. Be specific — include topics, structure, and emphasis.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="brief">Brief</Label>
        <Textarea
          id="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onBlur={handleBriefBlur}
          placeholder="Describe your video concept in detail. Include the topic, key points to cover, structure preferences, and any specific instructions..."
          rows={6}
          className="resize-none"
        />
      </div>

      <div className="flex gap-4">
        <div className="space-y-2">
          <Label>Target duration</Label>
          <Select value={duration} onValueChange={handleDurationChange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Tone</Label>
          <Select value={tone} onValueChange={handleToneChange}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex justify-end pt-4">
        <Button onClick={onNext} disabled={!brief.trim()}>
          Next: Style
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Create Step Style wrapper**

Create `src/components/step-style.tsx`:

```typescript
/**
 * Step 2: Style — wraps the existing style profile components.
 * Adds Next/Back navigation buttons.
 */
"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Save } from "lucide-react";
import { StyleUpload } from "@/components/style-upload";
import { StyleEditor } from "@/components/style-editor";
import { StylePreviewPanel } from "@/components/style-preview-panel";
import { StyleTemplateGrid } from "@/components/style-template-grid";

interface StepStyleProps {
  projectId: string;
  styleString: string;
  styleRefUrls: string[];
  styleRefPaths: string[];
  previewUrl: string | null;
  hasRefImages: boolean;
  generatingPreview: boolean;
  templateRefreshKey: number;
  templateSaved: boolean;
  showTemplateSave: boolean;
  savingTemplate: boolean;
  templateName: string;
  onUploadComplete: (keys: string[]) => void;
  onStyleSave: (styleString: string) => void;
  onPreviewRequest: () => void;
  onApplyTemplate: (templateId: string) => void;
  onSaveTemplate: () => void;
  onSetTemplateName: (name: string) => void;
  onShowTemplateSave: (show: boolean) => void;
  onCreateNewStyle: () => void;
  onNext: () => void;
  onBack: () => void;
}

export function StepStyle({
  projectId,
  styleString,
  styleRefUrls,
  styleRefPaths,
  previewUrl,
  hasRefImages,
  generatingPreview,
  templateRefreshKey,
  templateSaved,
  showTemplateSave,
  savingTemplate,
  templateName,
  onUploadComplete,
  onStyleSave,
  onPreviewRequest,
  onApplyTemplate,
  onSaveTemplate,
  onSetTemplateName,
  onShowTemplateSave,
  onCreateNewStyle,
  onNext,
  onBack,
}: StepStyleProps) {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Visual style</h2>
        <p className="text-sm text-muted-foreground">
          Upload reference images to define your video's look. Claude will analyse them and generate a style description.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">Reference images</h3>
            <StyleUpload
              projectId={projectId}
              existingUrls={styleRefUrls}
              existingKeys={styleRefPaths}
              onUploadComplete={onUploadComplete}
            />
          </div>

          <StyleEditor
            projectId={projectId}
            initialStyleString={styleString}
            hasRefImages={hasRefImages}
            onSave={onStyleSave}
            onPreviewRequest={onPreviewRequest}
          />

          {styleString && hasRefImages && (
            <div>
              {templateSaved ? (
                <p className="text-sm text-muted-foreground">Template saved</p>
              ) : showTemplateSave ? (
                <div className="flex gap-2">
                  <Input
                    placeholder="Template name"
                    value={templateName}
                    onChange={(e) => onSetTemplateName(e.target.value)}
                    maxLength={100}
                    className="max-w-xs"
                  />
                  <Button
                    size="sm"
                    onClick={onSaveTemplate}
                    disabled={savingTemplate || !templateName.trim()}
                  >
                    <Save className="mr-1 h-3 w-3" />
                    {savingTemplate ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onShowTemplateSave(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onShowTemplateSave(true)}
                >
                  Save as template
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <StylePreviewPanel
            projectId={projectId}
            previewUrl={previewUrl}
            generating={generatingPreview}
          />

          <Separator />

          <StyleTemplateGrid
            projectId={projectId}
            refreshKey={templateRefreshKey}
            onApply={onApplyTemplate}
            onCreateNew={onCreateNewStyle}
          />
        </div>
      </div>

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={onNext}>
          Next: Script
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Create Step Script wrapper**

Create `src/components/step-script.tsx`:

```typescript
/**
 * Step 3: Script — shows brief summary + generate button + script table.
 */
"use client";

import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BriefSummary } from "@/components/brief-summary";
import { ScriptTable } from "@/components/script-table";

interface SceneData {
  id: string;
  sortOrder: number;
  voiceover: string;
  sceneDescription: string;
  imagePrompt: string;
  durationSeconds: number;
  isHook: boolean;
}

interface StepScriptProps {
  projectId: string;
  brief: string;
  duration: number;
  tone: string;
  scenes: SceneData[];
  scriptKey: number;
  generatingScript: boolean;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
  onGenerateScript: () => void;
  onBack: () => void;
}

export function StepScript({
  projectId,
  brief,
  duration,
  tone,
  scenes,
  scriptKey,
  generatingScript,
  onBriefChange,
  onDurationChange,
  onToneChange,
  onGenerateScript,
  onBack,
}: StepScriptProps) {
  return (
    <section className="space-y-6">
      <BriefSummary
        projectId={projectId}
        brief={brief}
        duration={duration}
        tone={tone}
        onBriefChange={onBriefChange}
        onDurationChange={onDurationChange}
        onToneChange={onToneChange}
      />

      <div className="flex items-center gap-3">
        <Button
          onClick={onGenerateScript}
          disabled={generatingScript || !brief.trim()}
        >
          {generatingScript ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating script...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {scenes.length > 0 ? "Regenerate script" : "Generate script"}
            </>
          )}
        </Button>
      </div>

      {scenes.length > 0 && (
        <ScriptTable
          key={scriptKey}
          projectId={projectId}
          initialScenes={scenes}
          targetDuration={duration}
        />
      )}

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/components/video-brief.tsx src/components/step-style.tsx src/components/step-script.tsx
git commit -m "feat: add step wrapper components for concept, style, and script"
```

---

## Task 4: Rewrite Project Workspace as Stepper Orchestrator

**Files:**
- Rewrite: `src/components/project-workspace.tsx`

The workspace now manages: current step, step completion state, and renders the appropriate step content. All the existing state (style, brief, scenes) stays here — step components receive it as props.

- [ ] **Step 1: Rewrite project-workspace.tsx**

Replace the entire file with:

```typescript
/**
 * Project workspace orchestrator (client component).
 * Manages the 3-step stepper flow: Concept → Style → Script.
 * All state lives here; step components are pure renderers.
 */
"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ProjectStepper } from "@/components/project-stepper";
import { VideoBrief } from "@/components/video-brief";
import { StepStyle } from "@/components/step-style";
import { StepScript } from "@/components/step-script";

interface ProjectWorkspaceProps {
  project: {
    id: string;
    name: string;
    topic: string | null;
    status: string;
    styleString: string | null;
    styleRefPaths: string[] | null;
    styleRefUrls: string[];
    stylePreviewUrl: string | null;
    brief: string | null;
    targetDuration: number;
    tone: string;
  };
  initialScenes: Array<{
    id: string;
    sortOrder: number;
    voiceover: string;
    sceneDescription: string;
    imagePrompt: string;
    durationSeconds: number;
    isHook: boolean;
  }>;
}

const statusLabel: Record<string, string> = {
  draft: "Draft",
  generating: "Generating",
  ready: "Ready",
  published: "Published",
};

export function ProjectWorkspace({ project, initialScenes }: ProjectWorkspaceProps) {
  const router = useRouter();

  // ── Step navigation ──
  const [currentStep, setCurrentStep] = useState(() => {
    // Auto-advance to the furthest completed step on load
    if (initialScenes.length > 0) return 2;
    if (project.styleString || (project.styleRefPaths && project.styleRefPaths.length > 0)) return 1;
    return 0;
  });

  // ── Brief state ──
  const [brief, setBrief] = useState(project.brief || "");
  const [targetDuration, setTargetDuration] = useState(project.targetDuration);
  const [tone, setTone] = useState(project.tone);

  // ── Style state ──
  const [styleString, setStyleString] = useState(project.styleString || "");
  const [refKeys, setRefKeys] = useState<string[]>(project.styleRefPaths || []);
  const [previewUrl, setPreviewUrl] = useState<string | null>(project.stylePreviewUrl);
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [showTemplateSave, setShowTemplateSave] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [templateRefreshKey, setTemplateRefreshKey] = useState(0);

  // ── Script state ──
  const [scenes, setScenes] = useState(initialScenes);
  const [scriptKey, setScriptKey] = useState(0);
  const [generatingScript, setGeneratingScript] = useState(false);

  const hasRefImages = refKeys.length > 0;

  // ── Step completion ──
  const steps = [
    {
      label: "Concept",
      description: "Video brief",
      completed: brief.trim().length > 0,
    },
    {
      label: "Style",
      description: "Visual identity",
      completed: styleString.length > 0 || hasRefImages,
    },
    {
      label: "Script",
      description: "Scene breakdown",
      completed: scenes.length > 0,
    },
  ];

  // ── Style handlers ──
  const handleUploadComplete = useCallback(
    async (keys: string[]) => {
      setRefKeys(keys);
      await fetch(`/api/projects/${project.id}/style`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleRefPaths: keys }),
      });
    },
    [project.id],
  );

  const handleStyleSave = useCallback((newStyleString: string) => {
    setStyleString(newStyleString);
  }, []);

  const handlePreviewRequest = useCallback(async () => {
    setGeneratingPreview(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/style/preview`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setPreviewUrl(data.previewUrl);
      }
    } finally {
      setGeneratingPreview(false);
    }
  }, [project.id]);

  const handleApplyTemplate = useCallback(
    async (templateId: string) => {
      const res = await fetch(`/api/style-templates/${templateId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      if (res.ok) {
        router.refresh();
      }
    },
    [project.id, router],
  );

  const handleSaveTemplate = useCallback(async () => {
    if (!templateName.trim()) return;
    setSavingTemplate(true);
    try {
      const res = await fetch("/api/style-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          name: templateName.trim(),
        }),
      });
      if (res.ok) {
        setShowTemplateSave(false);
        setTemplateName("");
        setTemplateSaved(true);
        setTemplateRefreshKey((k) => k + 1);
      }
    } finally {
      setSavingTemplate(false);
    }
  }, [project.id, templateName]);

  // ── Script handlers ──
  const handleGenerateScript = useCallback(async () => {
    setGeneratingScript(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/script/generate`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setScenes(data.scenes);
        setScriptKey((k) => k + 1);
      }
    } finally {
      setGeneratingScript(false);
    }
  }, [project.id]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <Button
        variant="ghost"
        className="mb-6"
        onClick={() => router.push("/dashboard")}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to dashboard
      </Button>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">{project.name}</h1>
          {project.topic && (
            <p className="mt-1 text-muted-foreground">{project.topic}</p>
          )}
        </div>
        <Badge variant="secondary">{statusLabel[project.status]}</Badge>
      </div>

      <ProjectStepper
        currentStep={currentStep}
        steps={steps}
        onStepClick={setCurrentStep}
      />

      <Separator className="mb-8" />

      {/* Step 1: Concept */}
      {currentStep === 0 && (
        <VideoBrief
          projectId={project.id}
          initialBrief={brief}
          initialDuration={targetDuration}
          initialTone={tone}
          onNext={() => setCurrentStep(1)}
          onBriefChange={setBrief}
          onDurationChange={setTargetDuration}
          onToneChange={setTone}
        />
      )}

      {/* Step 2: Style */}
      {currentStep === 1 && (
        <StepStyle
          projectId={project.id}
          styleString={styleString}
          styleRefUrls={project.styleRefUrls}
          styleRefPaths={refKeys}
          previewUrl={previewUrl}
          hasRefImages={hasRefImages}
          generatingPreview={generatingPreview}
          templateRefreshKey={templateRefreshKey}
          templateSaved={templateSaved}
          showTemplateSave={showTemplateSave}
          savingTemplate={savingTemplate}
          templateName={templateName}
          onUploadComplete={handleUploadComplete}
          onStyleSave={handleStyleSave}
          onPreviewRequest={handlePreviewRequest}
          onApplyTemplate={handleApplyTemplate}
          onSaveTemplate={handleSaveTemplate}
          onSetTemplateName={setTemplateName}
          onShowTemplateSave={setShowTemplateSave}
          onCreateNewStyle={() => {
            setStyleString("");
            setRefKeys([]);
            setPreviewUrl(null);
          }}
          onNext={() => setCurrentStep(2)}
          onBack={() => setCurrentStep(0)}
        />
      )}

      {/* Step 3: Script */}
      {currentStep === 2 && (
        <StepScript
          projectId={project.id}
          brief={brief}
          duration={targetDuration}
          tone={tone}
          scenes={scenes}
          scriptKey={scriptKey}
          generatingScript={generatingScript}
          onBriefChange={setBrief}
          onDurationChange={setTargetDuration}
          onToneChange={setTone}
          onGenerateScript={handleGenerateScript}
          onBack={() => setCurrentStep(1)}
        />
      )}
    </main>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Start dev server and test the stepper**

Run: `npm run dev`

Test:
1. Open a project — should auto-advance to the correct step based on existing data
2. Step 1: brief + duration + tone, "Next: Style" button
3. Step 2: full style profile, "Back" and "Next: Script" buttons
4. Step 3: collapsed brief summary with Edit toggle, Generate/Regenerate button, script table
5. Stepper header: clickable steps, completion indicators

- [ ] **Step 4: Commit**

```bash
git add src/components/project-workspace.tsx
git commit -m "feat: rewrite project workspace as 3-step stepper orchestrator"
```
