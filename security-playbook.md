# security-playbook.md — Mobile App Security Standard

## Purpose

This playbook defines the **minimum, non-negotiable security standards** for building and shipping this mobile application.

The goal is to:

* Protect user data
* Prevent unauthorized access
* Minimize blast radius of failures
* Follow **industry-standard mobile + backend security practices**

Security is treated as a **design constraint**, not a post-build fix.

---

## Core Principles

1. **Zero Trust by Default**

   * Never trust the client
   * Never trust network boundaries

2. **Least Privilege**

   * Every user, service, and function gets only what it needs

3. **Fail Closed, Not Open**

   * Errors must block access, not allow it

4. **Defense in Depth**

   * Auth, validation, and checks must exist at multiple layers

---

## Security Must Be Addressed Twice

Security is reviewed in **two mandatory phases**:

1. **Early / Architecture Security Review** (before implementation)
2. **Final / Implementation Security Review** (before shipping)

Skipping either is not allowed.

---

## 1. Authentication (AuthN)

### Requirements

* All authenticated users must have a stable, unique identity
* Anonymous users must have **explicitly limited capabilities**
* Auth state must be validated on the backend, not trusted from client

### Rules

* Client-side auth is **never sufficient**
* Backend must re-verify identity on every request
* Expired or invalid tokens must be rejected

### Checklist

* [ ] Auth token verified server-side
* [ ] Token expiry handled correctly
* [ ] Anonymous vs authenticated behavior clearly defined

---

## 2. Authorization (AuthZ)

### Requirements

* Every read/write must check **who is allowed** to perform it
* Ownership rules must be explicit

### Rules

* Never rely on frontend checks for permissions
* Authorization logic must live close to the data

### Checklist

* [ ] Ownership validated on every mutation
* [ ] Role-based access (if applicable) enforced
* [ ] Cross-user access impossible by default

---

## 3. Data Access & Storage

### Mobile Client

* No sensitive secrets stored in the app binary
* No credentials stored in plaintext

### Backend / Database

* Data access must be scoped per user
* Public access must be explicitly intentional

### Rules

* Client SDK rules are mandatory (e.g. row-level security, rules engine)
* Admin privileges must be isolated

### Checklist

* [ ] No sensitive data exposed to unauthorized users
* [ ] DB rules reviewed and tested
* [ ] Admin credentials never used on client

---

## 4. Input Validation & Sanitization

### Requirements

* All external inputs must be validated at boundaries

### Rules

* Never trust client input
* Validate shape, type, length, and format

### Checklist

* [ ] Validation exists on all API inputs
* [ ] Malformed input rejected safely
* [ ] No reliance on frontend validation alone

---

## 5. API Security

### Requirements

* All APIs must be protected by auth (unless explicitly public)
* Rate limits should exist where abuse is possible

### Rules

* No unauthenticated mutation endpoints
* HTTP methods must match intent

### Checklist

* [ ] Auth enforced on all protected endpoints
* [ ] Proper HTTP status codes used
* [ ] Idempotency considered where relevant

---

## 6. Error Handling & Logging

### Requirements

* Errors must not leak sensitive information
* Logs must be useful but safe

### Rules

* No stack traces or secrets in client-facing errors
* Internal logs may contain details but must be protected

### Checklist

* [ ] Client errors are generic
* [ ] Internal logs capture sufficient context
* [ ] No PII leaked in logs

---

## 7. Network Security

### Requirements

* All communication must use HTTPS
* Certificate validation must not be bypassed

### Rules

* No HTTP fallback
* No insecure transport allowed

### Checklist

* [ ] HTTPS enforced
* [ ] No disabled certificate checks

---

## 8. Environment & Secrets Management

### Requirements

* Secrets must never be committed to source control
* Environment separation must be enforced

### Rules

* Dev, staging, and prod must not share secrets
* Secrets must be injected via secure env mechanisms

### Checklist

* [ ] No secrets in repo
* [ ] Env variables managed securely
* [ ] Production keys not used in development

---

## 9. Mobile-Specific Considerations

### Requirements

* Assume app can be reverse-engineered
* Assume network traffic can be inspected

### Rules

* Never rely on obscurity for security
* Sensitive logic must live server-side

### Checklist

* [ ] No business-critical logic solely on client
* [ ] App remains secure if source is inspected

---

## 10. Abuse, Misuse & Edge Scenarios

### Requirements

* System must tolerate malicious or repeated actions

### Examples

* Repeated submissions
* Replay attacks
* Brute-force attempts

### Checklist

* [ ] Replays prevented or harmless
* [ ] Abuse vectors identified
* [ ] Rate limiting or guards applied where needed

---

## Final Security Gate

Before shipping, AI must explicitly confirm:

* [ ] All auth/authz paths reviewed
* [ ] Data access scoped correctly
* [ ] Inputs validated
* [ ] Errors safe
* [ ] Secrets secure
* [ ] Mobile-specific risks addressed

If any item is uncertain:

* STOP
* FLAG RISK
* ASK FOR DECISION

---

## Final Directive to AI

Security issues are **release blockers**, not TODOs.

If security requirements conflict with convenience or speed:
**security wins**.
