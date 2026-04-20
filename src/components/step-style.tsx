/**
 * Step 2: Style — wraps the existing style profile components.
 * Adds Next/Back navigation buttons.
 */
"use client";

import { ArrowLeft, ArrowRight, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
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
