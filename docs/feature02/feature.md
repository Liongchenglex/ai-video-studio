# Feature: F-02 Style Profile System

## Feature
Name: Style Profile System
Purpose: Let users upload reference images, get an AI-generated style description, preview the style, and save/reuse style profiles as templates — so every downstream generation call produces visually consistent output.

## Key Files

Frontend:
- `src/components/style-upload.tsx` — drag-and-drop 3-slot image uploader
- `src/components/style-editor.tsx` — style string editor with token counter
- `src/components/style-preview-panel.tsx` — FLUX.1 Kontext preview display
- `src/components/style-template-grid.tsx` — saved template library grid
- `src/components/project-workspace.tsx` — integrates all style components
- `src/app/projects/[id]/page.tsx` — server component passing style data to workspace

Backend:
- `src/app/api/projects/[id]/style/upload/route.ts` — presigned URL generation for R2 uploads
- `src/app/api/projects/[id]/style/analyse/route.ts` — Claude Vision style analysis
- `src/app/api/projects/[id]/style/preview/route.ts` — FLUX.1 Kontext preview generation
- `src/app/api/projects/[id]/style/route.ts` — style profile GET/PUT
- `src/app/api/style-templates/route.ts` — template list/create
- `src/app/api/style-templates/[templateId]/apply/route.ts` — apply template to project

Services:
- `src/lib/r2.ts` — Cloudflare R2 client, presigned URL helpers
- `src/lib/style-analysis.ts` — Claude Vision style string generation
- `src/lib/style-preview.ts` — FLUX.1 Kontext preview generation
- `src/lib/model-routing.ts` — resolves image/video model based on style state

## Data Models
- `projects` table — added: `style_string` (text), `style_ref_paths` (jsonb string[]), `style_preview_path` (text)
- `style_templates` table — `id`, `user_id`, `name`, `style_string`, `ref_paths` (jsonb), `preview_path`, timestamps

## APIs
- `POST /api/projects/:id/style/upload` — returns presigned R2 URLs for direct client upload
- `POST /api/projects/:id/style/analyse` — triggers Claude Vision analysis, returns style string
- `POST /api/projects/:id/style/preview` — generates FLUX.1 Kontext preview, stores in R2
- `GET /api/projects/:id/style` — returns style profile with presigned download URLs
- `PUT /api/projects/:id/style` — saves style string and ref paths
- `GET /api/style-templates` — lists user's templates with download URLs
- `POST /api/style-templates` — creates template from project's current style
- `POST /api/style-templates/:templateId/apply` — copies template style to target project

## State & Ownership
Source of truth: Neon Postgres (style_string, style_ref_paths, style_preview_path on projects table)
Cached on client: style string, ref keys, preview URL in ProjectWorkspace component state
Assets stored in: Cloudflare R2 under `projects/{projectId}/style-refs/` and `projects/{projectId}/style-preview.png`

## Security
Auth required: All endpoints
Ownership enforced on: Every DB query scoped by `userId`; styleRefPaths validated to match project prefix
Rate limiting: `generation` preset (5/min) on analyse + preview; `mutation` preset (30/min) on all other mutations
Error handling: Generic client messages; raw errors logged server-side only

## Dependencies
- Cloudflare R2 (file storage)
- Anthropic API / Claude Vision (style analysis)
- fal.ai / FLUX.1 Kontext (preview generation)
- `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
- `@anthropic-ai/sdk`
- `@fal-ai/client`

## Coding Patterns Used
- Presigned URL pattern: client uploads directly to R2, server only validates and signs
- Server component → client component data flow: page.tsx fetches + resolves URLs, passes to workspace
- useEffect-based parent notification: upload component notifies parent via effect, not during render
- Rate limit presets: `generation` (5/min) for expensive external API calls

## Tradeoffs
- Style conditioning is reference-image + prompt only (no LoRA training in v1.0) — ~80% of LoRA quality, zero training infra
- Token count is estimated (~4 chars/token), not exact — sufficient for UI guidance
- Preview images re-uploaded from fal.ai to R2 — adds ~1s latency but prevents URL expiry
- Templates share R2 assets by path reference, not file copy — cheaper but template breaks if source project's files are deleted
- v1.1 will add optional LoRA training via fal.ai managed trainer for higher fidelity
