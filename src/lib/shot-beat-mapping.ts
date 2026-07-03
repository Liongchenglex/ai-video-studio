/**
 * Shot ↔ beat mapping (v4.0 Phase 2).
 * Shared constant for clamping a shot's in-beat range to a sane minimum
 * length. Consumed by the shot create/update/split routes.
 */

/** Shots shorter than this (after clamping) are stretched to it. */
export const MIN_SHOT_SECONDS = 0.25;
