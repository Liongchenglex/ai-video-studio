# F-01 — Auth & Project Management

## Feature
- **Name:** Auth & Project Management
- **Purpose:** User authentication and project workspace. Each project contains one video's worth of assets. This is the foundation that all other features depend on.

## Key Files

Frontend:
- `src/app/(auth)/login/page.tsx` — Login page (email/password + Google OAuth)
- `src/app/(auth)/signup/page.tsx` — Signup page
- `src/app/(dashboard)/dashboard/page.tsx` — Dashboard server page
- `src/app/projects/new/page.tsx` — Create project server page
- `src/app/projects/[id]/page.tsx` — Project workspace server page
- `src/components/navbar.tsx` — Top navigation bar with sign-out
- `src/components/dashboard-content.tsx` — Dashboard client content (project list header)
- `src/components/new-project-form.tsx` — Create project form
- `src/components/project-workspace.tsx` — Project detail view
- `src/components/project-list.tsx` — Fetches and renders project cards
- `src/components/project-card.tsx` — Individual project card with actions

Backend:
- `src/app/api/auth/[...all]/route.ts` — BetterAuth catch-all handler with rate limiting
- `src/app/api/projects/route.ts` — GET (list) + POST (create)
- `src/app/api/projects/[id]/route.ts` — GET + PATCH + DELETE (soft-delete)
- `src/app/api/projects/[id]/restore/route.ts` — POST (restore soft-deleted)
- `src/lib/auth.ts` — BetterAuth server config (Drizzle adapter, email/password, Google OAuth)
- `src/lib/auth-client.ts` — BetterAuth React client (signIn, signUp, signOut, useSession)
- `src/lib/api-utils.ts` — Shared helpers: session retrieval, error responses, CSRF, UUID validation, rate limiting
- `src/lib/rate-limit.ts` — In-memory sliding window rate limiter
- `src/lib/db/index.ts` — Drizzle ORM client
- `src/lib/db/schema.ts` — All table definitions (BetterAuth + projects)
- `src/middleware.ts` — Route protection (cookie-based redirect)

Config:
- `drizzle.config.ts` — Drizzle Kit migration config
- `next.config.ts` — Next.js config with better-auth external package
- `.env.example` — Required environment variables

## Data Models
- `user` — BetterAuth managed, PK text id
- `session` — BetterAuth managed, FK to user
- `account` — BetterAuth managed, FK to user (OAuth providers)
- `verification` — BetterAuth managed (email verification tokens)
- `projects` — App table, FK to user.id with cascade delete. Soft-delete via `deletedAt` timestamp. Status enum: draft, generating, ready, published.

## APIs
- `GET /api/projects` — List active projects for authenticated user
- `POST /api/projects` — Create project (name required, topic optional)
- `GET /api/projects/[id]` — Get project details (owner only)
- `PATCH /api/projects/[id]` — Update name/topic/status (owner only)
- `DELETE /api/projects/[id]` — Soft-delete project (owner only)
- `POST /api/projects/[id]/restore` — Restore soft-deleted project (owner only)
- `* /api/auth/*` — BetterAuth endpoints (sign-in, sign-up, sign-out, OAuth callbacks, session)

## State & Ownership
- **Source of truth:** PostgreSQL (Neon) via Drizzle ORM
- **Cached on client:** No persistent client cache. Project list fetched on mount. Session checked server-side on protected pages.

## Security
- **Auth required:** All API routes and protected pages
- **Ownership enforced on:** Every project read/write (userId === session.user.id)
- **CSRF:** Origin header verification on all mutation endpoints
- **Rate limiting:** Auth endpoints (10 req/min), mutation endpoints (30 req/min)
- **Input validation:** UUID format, name/topic length limits, status enum whitelist
- **Secrets:** All in env vars, never exposed to client

## Dependencies
- **External services:** Neon (PostgreSQL), Google OAuth
- **Libraries:** better-auth, drizzle-orm, postgres (driver)
- **Shared utilities:** `src/lib/api-utils.ts` (used by all API routes)

## Coding Patterns Used
- **Server/client split:** Server components fetch session + data, pass as props to client components. Avoids `useSession` SSR issues.
- **Ownership guard:** `getOwnedProject()` helper checks existence + ownership in one call, returns typed error.
- **Soft-delete:** `deletedAt` timestamp, filtered with `isNull(deletedAt)` on list queries.
- **Layered security:** Rate limit -> CSRF check -> Auth check -> UUID validation -> Ownership check -> Business logic.

## Tradeoffs
- **In-memory rate limiter:** Not suitable for multi-instance production. Replace with Redis/Upstash for horizontal scaling.
- **No email verification flow:** BetterAuth supports it but not configured for v1. Users can sign up with any email.
- **No delete confirmation dialog:** Mitigated by soft-delete with 30-day recovery window.
- **force-dynamic on root layout:** Required because client components use auth hooks. Prevents static page generation.
