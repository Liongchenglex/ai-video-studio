# v4.0 Unified Directing Editor — Roadmap

**This is the index. Start here, then open the phase plan you're building.**

Design spec (source of truth):
[`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../specs/2026-06-13-unified-directing-editor-design.md)
Feature doc for the new feature:
[`docs/feature16/feature.md`](../../feature16/feature.md)
Visual reference: [`docs/superpowers/specs/mockups/`](../specs/mockups/)

## Why phased

The spec spans several subsystems with a hard dependency order. Per the
writing-plans discipline, each phase is its own plan that produces working,
testable software on its own. **Build the phases in order** — each sits on the
one before it.

| Phase | Plan file | Delivers | Depends on |
|---|---|---|---|
| **1. Beat data model + per-beat VO** | `2026-06-13-v4-phase1-beat-data-model-and-vo.md` ✅ written | `beats` + `entities` tables, `shots` gains `beatId` + offsets + `referencedEntityIds`; segmentation; per-beat ElevenLabs VO with prosody-continuity; sequential timing helper; backfill of existing projects | — (foundation) |
| **2. Unified editor + two views** | `2026-07-02-v4-phase2-unified-editor.md` ✅ **shipped 2026-07-03** | Beat/shot two-layer timeline, inline editable script (re-voices one beat), Timeline⇄Storyboard toggle over one shared store, inspector; legacy continuous-VO model retired | Phase 1 |
| **3. Batch "Generate all"** | _to be written_ | Server-side fan-out for all images/clips **and missing entity reference sheets** (sheets generate FIRST so every shot in the same batch is entity-conditioned — decision 2026-07-04), queue + per-item status surfaced in the Storyboard view, retry, cost preview + confirm step before dispatch | Phase 2 ✅ + Phase 4 ✅ |
| **4. Reference Bible (F-16)** | `2026-07-04-v4-phase4-reference-bible.md` ✅ **shipped 2026-07-04** | `entities` CRUD + multi-view reference-sheet generation, auto-extract + auto-tag, single-entity FLUX conditioning (multi-entity later) | Phase 2 ✅ (UI rail) + Phase 1 (`referencedEntityIds`) |

**Note on Phase 3 (still to be written):** it must route its fan-out through
the same `POST /shots/:shotId/image` endpoint Phase 4 already conditions on
the primary tagged entity — batch generation therefore does not need any
extra entity-conditioning work of its own; it inherits it for free by calling
the existing route per shot. **Batch ordering (decision 2026-07-04): the
"Generate all" fan-out includes cast & location reference sheets — every
tagged entity with `referenceStatus` ≠ `done` gets its sheet generated in a
first wave (via the existing `POST /entities/:entityId/reference`), and only
then do the shot images fan out, so no shot in the batch generates
unconditioned when its entity's sheet was merely pending.** Include a cost
preview + confirm step before dispatch (sheets + images + clips itemized).

**Phase 2 docs:** [`docs/feature08/feature.md`](../../feature08/feature.md) ·
[`docs/feature08/testcase-v4-phase2.md`](../../feature08/testcase-v4-phase2.md) ·
[`docs/feature08/security-review.md`](../../feature08/security-review.md) (§ "v4.0 Phase 2") ·
[`docs/feature05/feature.md`](../../feature05/feature.md) ·
[`docs/feature03/feature.md`](../../feature03/feature.md).

**Phase 4 docs:** [`docs/feature16/feature.md`](../../feature16/feature.md) ·
[`docs/feature16/testcase.md`](../../feature16/testcase.md) ·
[`docs/feature16/security-review.md`](../../feature16/security-review.md).

Phase 3 is deliberately **not written yet** — its detail will shift based on
what Phases 1–2 revealed (e.g. exact beat/shot timing edge cases). Generate
its plan when you reach it, from the spec section it implements.

## Deferred items (tracked, not in these phases)

See spec §8 and `docs/backlog.md` #14–17: script re-segmentation policy,
multi-entity-per-shot conditioning, true multi-pose sheets, view-sync edge
cases. Final render/export is unchanged and still pending separately.

## House conventions (all phases follow these)

- **No unit-test harness in this repo.** Verification per task = `npx tsc
  --noEmit` (types), `npm run db:push` (schema), `npm run lint`, plus manual
  curl / Playwright e2e where behavior must be observed. This matches the
  existing plans' style.
- **Commit per task.** Small, frequent commits with `feat(v4-pN): …`.
- **Migrations are additive-first.** Add new tables/columns before removing
  legacy ones; drop the old continuous-VO `projects` fields only in Phase 2
  once the editor reads beats. This keeps every phase shippable.
