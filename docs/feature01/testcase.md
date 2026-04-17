# F-01 — Auth & Project Management: Test Cases

**Date:** 2026-04-16

---

## 1. Authentication — Email/Password

### TC-1.1: Successful signup
- **Action:** Fill in name, email, password (8+ chars) on /signup, submit
- **Expected:** Account created, auto-redirected to /dashboard
- **Edge cases:**
  - Password exactly 8 characters (minimum) — should succeed
  - Password exactly 128 characters (maximum) — should succeed
  - Name with 100 characters (max) — should succeed

### TC-1.2: Signup with existing email
- **Action:** Sign up with an email that already has an account
- **Expected:** Error message displayed, no duplicate account created

### TC-1.3: Signup with invalid password
- **Action:** Attempt signup with password < 8 characters
- **Expected:** Client-side validation prevents submission; server rejects if bypassed

### TC-1.4: Successful login
- **Action:** Enter valid email/password on /login, submit
- **Expected:** Redirected to /dashboard, navbar shows user name

### TC-1.5: Login with wrong password
- **Action:** Enter valid email but incorrect password
- **Expected:** Generic error message ("Invalid credentials"), no information leak about whether email exists

### TC-1.6: Login with non-existent email
- **Action:** Enter email that has no account
- **Expected:** Same generic error message as wrong password

### TC-1.7: Sign out
- **Action:** Click sign out button in navbar
- **Expected:** Session cleared, redirected to /login, accessing /dashboard redirects to /login

---

## 2. Authentication — Google OAuth

### TC-2.1: Successful Google sign-in
- **Action:** Click "Continue with Google" on /login, complete OAuth flow
- **Expected:** Redirected to /dashboard, user name from Google displayed in navbar

### TC-2.2: Successful Google sign-up
- **Action:** Click "Continue with Google" on /signup with a new Google account
- **Expected:** Account created, redirected to /dashboard

### TC-2.3: Google OAuth cancelled
- **Action:** Click "Continue with Google", then cancel in Google's consent screen
- **Expected:** Returned to login/signup page, no error crash

---

## 3. Route Protection

### TC-3.1: Unauthenticated access to /dashboard
- **Action:** Visit /dashboard without being logged in
- **Expected:** Redirected to /login

### TC-3.2: Unauthenticated access to /projects/new
- **Action:** Visit /projects/new without being logged in
- **Expected:** Redirected to /login

### TC-3.3: Unauthenticated access to /projects/[id]
- **Action:** Visit /projects/some-uuid without being logged in
- **Expected:** Redirected to /login

### TC-3.4: Authenticated access to /login
- **Action:** Visit /login while already logged in
- **Expected:** Redirected to /dashboard

### TC-3.5: Authenticated access to /signup
- **Action:** Visit /signup while already logged in
- **Expected:** Redirected to /dashboard

---

## 4. Project CRUD

### TC-4.1: Create project with name only
- **Action:** Fill in project name, leave topic empty, submit
- **Expected:** Project created with status "Draft", redirected to project workspace

### TC-4.2: Create project with name and topic
- **Action:** Fill in both name and topic, submit
- **Expected:** Project created, both fields visible in workspace

### TC-4.3: Create project with empty name
- **Action:** Attempt to submit with empty name field
- **Expected:** Client-side validation prevents submission; API returns 400 if bypassed

### TC-4.4: Create project with name exceeding 200 chars
- **Action:** Submit project with 201+ character name (bypass client maxLength)
- **Expected:** API returns 400 "Project name must be under 200 characters"

### TC-4.5: Create project with topic exceeding 500 chars
- **Action:** Submit project with 501+ character topic (bypass client maxLength)
- **Expected:** API returns 400 "Topic must be under 500 characters"

### TC-4.6: View project list
- **Action:** Navigate to /dashboard after creating projects
- **Expected:** All active projects displayed with name, topic, status badge, and date

### TC-4.7: View project workspace
- **Action:** Click on a project card from dashboard
- **Expected:** Project workspace page shows name, topic, status, and future-phase placeholder

### TC-4.8: Delete project (soft-delete)
- **Action:** Click delete from project card dropdown menu
- **Expected:** Project removed from dashboard list, still exists in DB with deletedAt set

### TC-4.9: Deleted project not in list
- **Action:** After deleting a project, refresh /dashboard
- **Expected:** Deleted project does not appear in the project list

---

## 5. Authorization & Ownership

### TC-5.1: Access another user's project via URL
- **Action:** Log in as User A, copy a project URL. Log in as User B, visit that URL
- **Expected:** 404 Not Found (not 403, to avoid confirming project existence)

### TC-5.2: Access another user's project via API
- **Action:** As User B, call GET /api/projects/[user-a-project-id]
- **Expected:** 403 Access denied

### TC-5.3: Delete another user's project via API
- **Action:** As User B, call DELETE /api/projects/[user-a-project-id]
- **Expected:** 403 Access denied, project unchanged

### TC-5.4: Update another user's project via API
- **Action:** As User B, call PATCH /api/projects/[user-a-project-id]
- **Expected:** 403 Access denied, project unchanged

---

## 6. Input Validation & Security

### TC-6.1: Invalid UUID in project URL
- **Action:** Visit /projects/not-a-uuid
- **Expected:** 404 page, no server crash

### TC-6.2: Invalid UUID in API request
- **Action:** Call GET /api/projects/not-a-uuid
- **Expected:** 400 "Invalid project ID"

### TC-6.3: Invalid JSON body on POST /api/projects
- **Action:** Send POST with malformed JSON body
- **Expected:** 400 "Invalid request body"

### TC-6.4: Invalid status value on PATCH
- **Action:** Send PATCH with `{ "status": "invalid_value" }`
- **Expected:** 400 "Status must be one of: draft, generating, ready, published"

### TC-6.5: CSRF — cross-origin mutation attempt
- **Action:** From a different origin, send POST to /api/projects with valid session cookie
- **Expected:** 403 Forbidden (origin mismatch)

### TC-6.6: Rate limiting on auth
- **Action:** Send 11+ POST requests to /api/auth/sign-in/email within 60 seconds
- **Expected:** 429 "Too many requests" after 10th request

### TC-6.7: Rate limiting on mutations
- **Action:** Send 31+ POST requests to /api/projects within 60 seconds
- **Expected:** 429 "Too many requests" after 30th request

---

## 7. Edge Cases

### TC-7.1: Double-delete a project
- **Action:** Delete a project, then call DELETE again on the same ID
- **Expected:** 404 Not Found (already soft-deleted)

### TC-7.2: Restore non-deleted project
- **Action:** Call POST /api/projects/[id]/restore on an active project
- **Expected:** 400 "Project is not deleted"

### TC-7.3: Update a soft-deleted project
- **Action:** Call PATCH /api/projects/[id] on a deleted project
- **Expected:** 404 Not Found

### TC-7.4: Empty update body
- **Action:** Send PATCH with `{}`
- **Expected:** 400 "No valid fields to update"

### TC-7.5: Concurrent project creation
- **Action:** Rapidly create multiple projects simultaneously
- **Expected:** All projects created successfully with unique IDs, rate limit applies if exceeded
