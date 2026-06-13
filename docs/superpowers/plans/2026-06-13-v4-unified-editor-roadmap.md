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
| **2. Unified editor + two views** | _to be written_ | Beat/shot two-layer timeline, inline editable script (re-voices one beat), Timeline⇄Storyboard toggle over one shared store, inspector | Phase 1 |
| **3. Batch "Generate all"** | _to be written_ | Server-side fan-out for all images/clips, queue + per-item status surfaced in the Storyboard view, retry | Phase 2 |
| **4. Reference Bible (F-16)** | _to be written_ | `entities` CRUD + multi-view reference-sheet generation, auto-extract + auto-tag, single-entity FLUX conditioning (multi-entity later) | Phase 2 (UI rail) + Phase 1 (`referencedEntityIds`) |

Phases 2–4 are deliberately **not written yet** — their detail will shift based
on what Phase 1 reveals (e.g. exact beat/shot timing edge cases). Generate each
phase plan when you reach it, from the spec section it implements.

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
