/**
 * Project card component for the dashboard.
 * Displays project name, topic, status badge, and action dropdown.
 */
"use client";

import Link from "next/link";
import { MoreVertical, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ProjectStatus = "draft" | "generating" | "ready" | "published";

interface ProjectCardProps {
  id: string;
  name: string;
  topic: string | null;
  status: ProjectStatus;
  updatedAt: string;
  onDelete: (id: string) => void;
}

const statusVariant: Record<ProjectStatus, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "secondary",
  generating: "outline",
  ready: "default",
  published: "default",
};

const statusLabel: Record<ProjectStatus, string> = {
  draft: "Draft",
  generating: "Generating",
  ready: "Ready",
  published: "Published",
};

export function ProjectCard({
  id,
  name,
  topic,
  status,
  updatedAt,
  onDelete,
}: ProjectCardProps) {
  const formattedDate = new Date(updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Card className="group relative transition-colors hover:border-primary/30">
      <Link href={`/projects/${id}`} className="absolute inset-0 z-0" />
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div className="space-y-1 pr-8">
          <CardTitle className="text-lg leading-tight">{name}</CardTitle>
          {topic && (
            <p className="text-sm text-muted-foreground line-clamp-1">
              {topic}
            </p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="relative z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
          >
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(id)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="flex items-center justify-between">
        <Badge variant={statusVariant[status]}>
          {statusLabel[status]}
        </Badge>
        <span className="text-xs text-muted-foreground">{formattedDate}</span>
      </CardContent>
    </Card>
  );
}
