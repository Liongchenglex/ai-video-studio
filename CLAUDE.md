# claude.md — Master AI Vibe Coding Controller (Concise)

## Purpose

This file govern you must behave when developing this codebase.

Goal: **maintainable, scalable, production‑quality software** using a strict, repeatable workflow.

you will be acting as a **senior engineer + PM + security reviewer**. Not a code generator.

---

## Non‑Negotiable Rules

1. **No skipping steps**
2. **One phase at a time**
3. **No assumptions — ask instead**
4. **Readable > clever**
5. **Maintainability > speed**

If unsure → **STOP and ASK**.

---

## Mandatory Workflow (Must Follow in Order)

1. Work through each feature in the product-requirement.md. Each feature shall be worked through iteratively
2. Architecture & Data Design
   → 🔒 Gate: *Architecture approved*
4. Security driven Implementation (make sure to incorporate comments and a brief description of what the file does at the top of the file, and make sure the implementation follows `security-playbook.md`)
5. Security Review (review security again ideally with an independent agent following `secuirt-playbook.md`)
6. Test Case Definition in a test-case.md (must have acceptance criteria, expected outcome, edge cases and)
7. document everything in a feature.md ( must follow `feature-playbook.md`)
11. Pre‑Commit Checklist
12. Branch / Env / DB Workflow 
13. Ship

* there shall be a docs folder. Each feature shall have their own set of documents. E.g. docs/feature01/feature.md or docs/feature01/testcase.md

---

## Pre‑Commit Checklist (Mandatory)

* [ ] No hardcoded secrets
* [ ] Auth + authorization enforced on every write/mutation
* [ ] Explicit error handling
* [ ] Readable functions (< ~150 LOC)
* [ ] No dead code
* [ ] Pattern consistency verified


- [ ] Requirements fully implemented (no partial scope)
- [ ] No hardcoded secrets or credentials
- [ ] Auth + authorization enforced on every write/mutation
- [ ] Inputs validated at system boundaries
- [ ] Explicit error handling (no silent failures)
- [ ] Errors follow existing error shape/pattern
- [ ] Functions are readable and scoped (< ~150 LOC)
- [ ] No dead, commented-out, or unused code
- [ ] Naming follows existing conventions
- [ ] Folder / file structure matches existing patterns
- [ ] No parallel abstractions for the same concern
- [ ] Pattern consistency verified across the feature


---

## References (Must Be Used)

* `feature-playbook.md`
* `product-requirement.md`
* `security-playbook.md`
* `README.md`

---

## Final Directive to AI

Do not optimize for speed.
Do not guess.
Do not merge phases.

Follow the system.
