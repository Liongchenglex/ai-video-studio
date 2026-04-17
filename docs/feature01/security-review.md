# F-01 — Auth & Project Management: Security Review

**Date:** 2026-04-16  
**Status:** PASS  
**Reviews conducted:** 2 (Early + Final)

---

## Early Security Review (Pre-Implementation)

Conducted during architecture design. Verified that the planned design addressed all security-playbook.md requirements. Key decisions:

- Server-side session verification on every API route
- Ownership checks on every project mutation
- Input validation at all API boundaries
- Secrets in env vars only
- Soft-delete pattern for data recovery

**Result:** PASS — Proceeded to implementation.

---

## Final Security Review — Round 1

Conducted after implementation. Found 5 issues:

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Hardcoded `http://localhost:3000` in auth-client.ts | High | FIXED |
| 2 | No CSRF protection on project API routes | Medium | FIXED |
| 3 | No UUID validation on `[id]` path params | Medium | FIXED |
| 4 | No rate limiting on any endpoint | Medium | FIXED |
| 5 | Missing foreign key on `projects.userId` | Medium | FIXED |

### Fixes Applied

1. **auth-client.ts:** Removed hardcoded baseURL. BetterAuth auto-detects origin.
2. **CSRF:** Added `verifyCsrf()` in `api-utils.ts` — validates Origin header matches Host on all POST/PATCH/DELETE routes.
3. **UUID:** Added `isValidUUID()` in `api-utils.ts` — regex check before any DB query using path param ID.
4. **Rate limiting:** Added `src/lib/rate-limit.ts` (in-memory sliding window) and `applyRateLimit()` helper. Auth: 10 req/60s. Mutations: 30 req/60s.
5. **Foreign key:** Added `.references(() => user.id, { onDelete: "cascade" })` to `projects.userId`.

---

## Final Security Review — Round 2

Conducted after fixes. Verified all 5 issues resolved. Found 4 new low-severity items:

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| NEW-1 | Missing UUID validation on server-side project page | Low | FIXED |
| NEW-2 | No confirmation dialog before project deletion | Low | Accepted (soft-delete mitigates) |
| NEW-3 | In-memory rate limiter not multi-instance ready | Info | Accepted (documented in feature.md) |
| NEW-4 | No maxLength on signup name field | Low | FIXED |

**Result:** PASS — No blocking issues.

---

## Security Playbook Checklist

### 1. Authentication (AuthN)
- [x] Auth token verified server-side (BetterAuth session on every API route)
- [x] Token expiry handled (7-day session, 24h refresh)
- [x] Anonymous vs authenticated behavior defined (middleware redirects)

### 2. Authorization (AuthZ)
- [x] Ownership validated on every mutation (`project.userId === session.user.id`)
- [x] Cross-user access impossible (all queries scoped by userId)

### 3. Data Access & Storage
- [x] No sensitive data exposed to unauthorized users
- [x] DB queries scoped per user
- [x] Foreign keys with cascade delete enforced

### 4. Input Validation
- [x] Validation on all API inputs (name, topic, status, UUID)
- [x] Malformed input rejected safely (400 with generic message)
- [x] No reliance on frontend validation alone

### 5. API Security
- [x] Auth enforced on all protected endpoints
- [x] CSRF protection via origin verification
- [x] Rate limiting on auth and mutation endpoints
- [x] Proper HTTP status codes (400, 401, 403, 404, 429)

### 6. Error Handling
- [x] Client errors are generic (no stack traces)
- [x] No PII leaked in error responses

### 7. Network Security
- [x] HTTPS enforced (Neon requires SSL, deployment-level HTTPS)
- [x] No hardcoded HTTP URLs

### 8. Environment & Secrets
- [x] No secrets in repo (.env in .gitignore)
- [x] .env.example has placeholder values only
- [x] All credentials from env vars

### 9. Abuse & Edge Scenarios
- [x] Rate limiting applied
- [x] Soft-delete prevents accidental data loss
- [x] Double-delete returns 404

---

## Known Accepted Risks

1. **In-memory rate limiter** — resets on server restart, not shared across instances. Acceptable for single-instance dev/staging. Replace with Upstash Redis for production.
2. **No email verification** — users can sign up with unverified emails. Acceptable for v1, add in future iteration.
3. **No delete confirmation UI** — mitigated by soft-delete with 30-day recovery.
