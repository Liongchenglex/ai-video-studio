# Archived plans & superseded docs — kept for history

These documents were written for the **pre-v3.0** architecture and
are **no longer accurate**. They are archived (not deleted) so the history is
recoverable, but **do not build from them**. For current direction see
[`docs/superpowers/specs/`](../../specs/) and the v4.0 plans in the parent
[`plans/`](../) folder.

| File | Why archived |
|---|---|
| `2026-04-19-f03-script-generation.md` | Built around the old **scene-JSON** script model. v3.0 replaced scenes with plain-prose script + user-defined shots on the timeline. The `scenes` table no longer exists. |
| `2026-04-20-phase2-asset-generation.md` | Targets the deleted **`scenes`** table (per-scene image/voiceover/music). Image + voiceover + clip generation were re-implemented on the **`shots`** model in v3.0. |
| `2026-04-20-stepper-ui-flow.md` | The multi-step stepper UI was reworked in the v3.0 editor-first pivot and is further de-emphasized in v4.0 (unified editor). |
| `2026-04-prd-v1.0-draft.md` | The original v1.0 PRD draft (one-click "prompt → finished video" pipeline, scene-based). Superseded by the root `product-requirement.md` (v3.0 editor-first, with the v4.0 unified-editor evolution noted in its header). Formerly lived at the repo root as `# AI Video Studio — Product Requirements.md`. |

**Still current (left in `plans/`):** `2026-04-19-f02-style-profile-system.md`
— the Style Profile System (F-02) still works as that plan describes.
