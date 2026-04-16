# feature-playbook.md — Feature Documentation Standard

## Purpose

This playbook defines **when and how `feature.md` must be created and maintained**.

`feature.md` exists to:

* Preserve system context
* Prevent AI and human context loss
* Enforce pattern consistency
* Make future changes safe and fast

---

## When `feature.md` Is Required

A `feature.md` **must exist** when a feature:

* Touches multiple files
* Has backend + frontend logic
* Introduces new APIs or data models
* Has non-trivial business logic

For trivial changes (copy tweaks, small UI fixes), `feature.md` is optional.

---

## Role of `feature.md`

`feature.md` is the **navigation map** for a feature.

It answers:

* Where is this feature implemented?
* What does it depend on?
* What owns the data?
* What must not be accidentally broken?

It does **not** restate requirements or implementation details.

---

## Mandatory Sections in `feature.md`

A feature document is **invalid** unless all sections below are present.

---

## 1. Feature Overview

```md
## Feature
Name:
Purpose:
```

---

## 2. Key Files

List all files directly involved in this feature.

```md
## Key Files
Frontend:
- path/to/file

Backend:
- path/to/file
```

---

## 3. Data Models

```md
## Data Models
- table / collection name
```

Include ownership and lifecycle if non-obvious.

---

## 4. APIs

```md
## APIs
- METHOD /endpoint
```

---

## 5. State & Ownership

```md
## State & Ownership
Source of truth:
Cached on client:
```

---

## 6. Security Notes

```md
## Security
Auth required:
Ownership enforced on:
```

---

## 7. Dependencies

```md
## Dependencies
- External services
- Shared utilities
- Feature flags
```

---
## 8. Coding Patterns Used
- <pattern name>


## 9. Known Tradeoffs / Debt

```md
## Tradeoffs
- Known limitations
```

This section must be honest and explicit.

---

## Maintenance Rules

* `feature.md` must be updated when files are added or removed
* AI must read `feature.md` before modifying a feature
* AI must update `feature.md` if responsibilities change

---

## Final Directive to AI

If `feature.md` exists and is outdated:

* STOP
* UPDATE IT FIRST

If a feature meets the criteria and `feature.md` does not exist:

* CREATE IT BEFORE IMPLEMENTATION
