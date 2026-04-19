/**
 * Style template library grid. Displays saved style templates
 * with thumbnail previews for reuse across projects.
 */
"use client";

import { useState, useEffect } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Template {
  id: string;
  name: string;
  styleString: string;
  refUrls: string[];
  previewUrl: string | null;
}

interface StyleTemplateGridProps {
  projectId: string;
  onApply: (templateId: string) => void;
  onCreateNew: () => void;
}

export function StyleTemplateGrid({
  projectId: _projectId,
  onApply,
  onCreateNew,
}: StyleTemplateGridProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const res = await fetch("/api/style-templates");
        if (res.ok) {
          const data = await res.json();
          setTemplates(data);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchTemplates();
  }, []);

  async function handleApply(templateId: string) {
    setApplying(templateId);
    onApply(templateId);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Saved styles</h3>
        <Button variant="ghost" size="sm" onClick={onCreateNew}>
          <Plus className="mr-1 h-3 w-3" />
          New style
        </Button>
      </div>

      {templates.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          No saved styles yet. Create a style profile and save it as a template.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {templates.map((t) => (
            <Card
              key={t.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => handleApply(t.id)}
            >
              <CardContent className="p-2">
                {t.previewUrl || t.refUrls[0] ? (
                  <img
                    src={t.previewUrl || t.refUrls[0]}
                    alt={t.name}
                    className="mb-2 aspect-square w-full rounded-md object-cover"
                  />
                ) : (
                  <div className="mb-2 flex aspect-square items-center justify-center rounded-md bg-muted">
                    <span className="text-xs text-muted-foreground">No preview</span>
                  </div>
                )}
                <p className="truncate text-xs font-medium">{t.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.styleString.slice(0, 60)}...
                </p>
                {applying === t.id && (
                  <Loader2 className="mt-1 h-3 w-3 animate-spin" />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
