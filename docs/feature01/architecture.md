# F-01 — Auth & Project Management: Architecture

**Status:** Approved  
**Date:** 2026-04-16  
**Phase:** 1 — Foundation

---

## Tech Choices

| Concern | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15 (App Router) | Full-stack, SSR, API routes |
| Auth | BetterAuth | Per PRD; email/password + Google OAuth, session management |
| Database | PostgreSQL via Drizzle ORM | Type-safe, migrations, lightweight |
| Storage | Cloudflare R2 (S3-compatible) | Per PRD; cheap, no egress fees |
| Styling | Tailwind CSS + shadcn/ui | Rapid UI, consistent design system |

---

## Data Models

### users (managed by BetterAuth)

| Column | Type | Constraint |
|---|---|---|
| id | UUID | PK |
| name | TEXT | |
| email | TEXT | UNIQUE |
| emailVerified | BOOLEAN | |
| image | TEXT | Avatar URL |
| createdAt | TIMESTAMP | |
| updatedAt | TIMESTAMP | |

BetterAuth also manages: `sessions`, `accounts`, `verifications` tables.

### projects

| Column | Type | Constraint |
|---|---|---|
| id | UUID | PK |
| userId | UUID | FK → users.id, NOT NULL |
| name | TEXT | NOT NULL |
| topic | TEXT | |
| status | ENUM | 'draft', 'generating', 'ready', 'published' |
| createdAt | TIMESTAMP | DEFAULT now() |
| updatedAt | TIMESTAMP | DEFAULT now() |
| deletedAt | TIMESTAMP | NULL (soft delete, 30-day recovery) |

**Index:** `(userId, deletedAt)` — filter active projects per user.

---

## API Routes

| Method | Route | Purpose | Auth |
|---|---|---|---|
| GET | `/api/projects` | List user's active projects | Required |
| POST | `/api/projects` | Create a new project | Required |
| GET | `/api/projects/[id]` | Get project details | Required + ownership |
| PATCH | `/api/projects/[id]` | Update project name/topic/status | Required + ownership |
| DELETE | `/api/projects/[id]` | Soft-delete project | Required + ownership |
| POST | `/api/projects/[id]/restore` | Restore soft-deleted project | Required + ownership |

---

## Pages

| Path | Purpose |
|---|---|
| `/` | Landing / redirect to dashboard |
| `/login` | Sign in (email/password + Google) |
| `/signup` | Register |
| `/dashboard` | Project list with status badges |
| `/projects/new` | Create project form |
| `/projects/[id]` | Project workspace (future phases plug in here) |

---

## Folder Structure

```
src/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── signup/page.tsx
│   ├── (dashboard)/
│   │   └── dashboard/page.tsx
│   ├── projects/
│   │   ├── new/page.tsx
│   │   └── [id]/page.tsx
│   ├── api/
│   │   ├── auth/[...all]/route.ts   ← BetterAuth handler
│   │   └── projects/
│   │       ├── route.ts              ← list + create
│   │       └── [id]/
│   │           ├── route.ts          ← get + update + delete
│   │           └── restore/route.ts
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   ├── auth.ts           ← BetterAuth server config
│   ├── auth-client.ts    ← BetterAuth client config
│   └── db/
│       ├── index.ts      ← Drizzle client
│       ├── schema.ts     ← All table definitions
│       └── migrate.ts
├── components/
│   ├── ui/               ← shadcn components
│   ├── project-card.tsx
│   └── project-list.tsx
└── middleware.ts          ← Route protection
```

---

## Security Design (Early Review)

- All API routes verify session server-side via BetterAuth
- Every project mutation checks `project.userId === session.user.id`
- No project data exposed without ownership verification
- API keys / OAuth tokens stored server-side only, never sent to client
- Input validation on all API boundaries (name length, valid status values)
- Soft-delete: `deletedAt` timestamp; scheduled job purges after 30 days
- CSRF protection via BetterAuth built-in mechanisms
- Rate limiting on auth endpoints to prevent brute force

---

## Decisions & Rationale

1. **Drizzle over Prisma** — lighter, faster migrations, better edge-runtime compatibility with Next.js
2. **BetterAuth over NextAuth** — per PRD specification; simpler API, built-in email/password + OAuth
3. **Soft-delete over hard-delete** — 30-day recovery window per acceptance criteria
4. **shadcn/ui over custom components** — accessible, composable, no runtime overhead
5. **Cloudflare R2 over AWS S3** — zero egress fees, S3-compatible API, per PRD recommendation
