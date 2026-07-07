# Wallet / Cost Ledger — Design Spec

**Date:** 2026-07-08
**Status:** Approved concept, pending spec review
**Feature docs slot:** docs/feature18/

## 1. Problem & goals

The app spends real money across three AI providers (Anthropic Claude, ElevenLabs, fal.ai) with no centralized record. The user wants a wallet: top up a virtual balance (e.g. $10), have every paid AI action deduct its computed cost, see spend broken down by provider, and be blocked when the balance runs out.

Decisions locked during brainstorming:

| Question | Decision |
|---|---|
| Wallet type | **Virtual budget now, Stripe-ready design** — user manually credits the wallet today; the data model must survive a future switch to real payments for other users |
| Balance shape | **One balance per user + per-provider breakdown** via ledger attribution |
| Enforcement | **Block new actions** when estimated cost exceeds balance; in-flight work finishes and is still debited (balance may dip slightly negative) |
| Meter scope | **Everything paid** — all Claude, ElevenLabs, and fal calls, including suggest-prompt buttons and `/api/test/*` endpoints |
| Pricing | **Usage-based where the API returns usage** (Claude tokens, ElevenLabs characters), flat per-generation for fal |
| Architecture | **B: append-only ledger + cached balance column**, updated atomically in the same transaction |

Explicitly out of scope (future work, recorded here so it is not re-litigated): Stripe checkout/webhooks, per-provider budget alerts, DB-driven price table with admin UI, multi-currency, refunds, invoice reconciliation.

## 2. Data model (Drizzle, `src/lib/db/schema.ts`)

New enums:

- `wallet_txn_type`: `credit` | `debit` | `adjustment`
- `wallet_provider`: `anthropic` | `elevenlabs` | `fal`

### `wallets` — one row per user (cached balance)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | |
| `user_id` | text, NOT NULL, **unique**, FK → `user.id` | better-auth user PK is text |
| `balance_usd` | numeric(12,6) NOT NULL default 0 | cache of ledger sum; may go slightly negative by design |
| `created_at` / `updated_at` | timestamp | house pattern (`$onUpdate`) |

Separate table (not a column on `user`) so the better-auth-managed table is never touched. Row is lazily created (insert-on-conflict-do-nothing) on first wallet read.

### `wallet_transactions` — append-only ledger (source of truth)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | text NOT NULL, FK → `user.id` | |
| `type` | wallet_txn_type NOT NULL | |
| `amount_usd` | numeric(12,6) NOT NULL | **positive** for credit/debit (type carries direction); **signed** for adjustment (positive adds, negative subtracts) |
| `provider` | wallet_provider, nullable | null on credits/adjustments |
| `action` | text NOT NULL | debit slugs listed in §4; credits use `topup`, adjustments use `adjustment` |
| `model` | text, nullable | e.g. `claude-sonnet-4-5`, `flux-pro/kontext`, `eleven_multilingual_v2` |
| `usage` | jsonb, nullable | raw meter that priced the debit — `{inputTokens, outputTokens, webSearches}`, `{characters}`, `{count}`, `{durationSeconds}` |
| `project_id` | uuid, nullable, FK → `projects.id` (no cascade delete — ledger outlives projects; FK is `on delete set null`) | project-level attribution is sufficient (user decision) |
| `description` | text, nullable | human note, mainly on credits/adjustments |
| `created_at` | timestamp NOT NULL default now() | |

Index: `(user_id, created_at desc)`.

**Invariant:** `wallets.balance_usd == SUM(CASE type WHEN 'credit' THEN amount_usd WHEN 'debit' THEN -amount_usd ELSE amount_usd END)` over the user's ledger rows. Enforced by performing every ledger insert and the balance `UPDATE` in one DB transaction. The ledger is truth; the column is a rebuildable cache.

**Immutability:** no update or delete endpoint for ledger rows exists. Corrections are new `adjustment` rows.

## 3. Price table (`src/lib/generation-costs.ts` grows into it)

Existing exports (`SHEET_EST_USD`, `IMAGE_EST_USD`, `CLIP_EST_USD`, `estimateBatchCost`) are kept so the Generate-all preview keeps working unchanged. New named constants, each commented with the provider pricing-page URL and a "last verified" date. **The implementation plan must include a rate-verification task** — the figures below are design-time defaults:

| Constant | Default | Basis |
|---|---|---|
| `SONNET_USD_PER_MTOK_IN` / `_OUT` | 3.00 / 15.00 | Anthropic pricing |
| `HAIKU_USD_PER_MTOK_IN` / `_OUT` | 1.00 / 5.00 | Anthropic pricing |
| `WEB_SEARCH_USD_PER_1K` | 10.00 | Anthropic server-tool pricing; `usage.server_tool_use.web_search_requests` |
| `ELEVEN_USD_PER_CHAR` | 0.00022 | derived from user's plan tier (Creator ≈ $22/100k chars) — tune to actual plan |
| `ELEVEN_MUSIC_USD_PER_TRACK` | 0.50 | flat; music API returns no usage metadata |
| `IMAGE_USD` / `SHEET_USD` | 0.04 | fal FLUX Kontext flat (reuse existing values) |
| `CLIP_USD_PER_SECOND` | 0.04 | LTX-2.3; fallback flat `CLIP_USD_FLAT = 0.25` when `video.duration` missing |
| `STYLE_PREVIEW_USD` | 0.08 | FLUX Kontext Max multi |
| `HAILUO_CLIP_USD` | 0.27 | minimax hailuo-02 standard, ~6 s |

Helper functions exported alongside: `claudeCostUsd(model, usage)`, `elevenTtsCostUsd(characters)`, `clipCostUsd(durationSeconds | null)`. Debits store both the computed amount and the raw usage, so historical rows remain correct after any rate change.

Pre-check estimates (used only for balance gating on token-priced actions whose true cost is unknowable upfront): `PRE_CHECK_EST_USD` map — script 0.25 (includes web search), shot-prompts 0.10, entity-extraction 0.10, style-analysis 0.05, suggest-prompt 0.01, voiceover 0.10, music 0.50, image/sheet/clip use their real flat prices.

Accuracy expectation (documented in feature.md): computed debits track real invoices to within a few percent (prompt-caching discounts, rounding), not to the cent. The `usage` jsonb enables re-audit against provider invoices.

## 4. Wallet service (`src/lib/wallet.ts`, new)

- `getWallet(userId)` → lazily creates row, returns `{ balanceUsd }`.
- `recordSpend(userId, { provider, action, model?, usage?, amountUsd, projectId? })` → one `db.transaction`: insert debit row + `UPDATE wallets SET balance_usd = balance_usd - $x` (arithmetic in SQL, never JS floats). Ensures wallet row exists first.
- `recordCredit(userId, { amountUsd, description? })` → same transactional pattern, type `credit`, action `topup`.
- `assertSufficientBalance(userId, estimatedUsd)` → throws `InsufficientBalanceError { balanceUsd, requiredUsd }`; routes map it to **HTTP 402** `{ error: "Insufficient balance", balanceUsd, requiredUsd }` (house error shape + two fields).
- `getSpendBreakdown(userId)` → per-provider and per-action totals (this month / all-time) via `GROUP BY` on the ledger.

**recordSpend failure policy:** if the debit transaction fails *after* the provider call succeeded, the generation is NOT failed — the asset exists and the money is spent either way. Log loudly (`[wallet] LEDGER MISS`) and continue. Track-accurately > punish-the-user.

**Debit timing:** immediately after the provider call returns successfully, inside each service — before R2 upload / DB status writes. Provider call throwing → no debit.

### Metered call sites (complete list — meter scope is "everything paid")

Services gain a `userId` parameter threaded from callers (routes pass `session.user.id`; the Inngest batch orchestrator already fetches the project row and passes `project.userId`).

| Action slug | Provider | Call site |
|---|---|---|
| `script` | anthropic (+ web search) | `src/lib/script-generation.ts` `generateScript()` |
| `shot_prompts` | anthropic | `src/lib/shot-recommendation.ts` `recommendShotsForBeats()` |
| `entity_extraction`, `shot_tagging` | anthropic | `src/lib/entity-extraction.ts` `extractEntities()` / `tagShots()` |
| `style_analysis` | anthropic | `src/lib/style-analysis.ts` `analyseStyleImages()` (non-stream; read `response.usage`) |
| `suggest_image_prompt` / `suggest_motion_prompt` | anthropic (haiku) | suggest-image / suggest-motion routes |
| `shot_image` / `entity_sheet` | fal | shared sink `src/lib/image-generation.ts` `generateImage()` — takes an `action` param so the two are attributed distinctly |
| `style_preview` | fal | `src/lib/style-preview.ts` |
| `shot_clip` | fal | `src/lib/shot-clip-generation.ts` (uses `video.duration` for per-second pricing) |
| `clip_hailuo` | fal | clip-hailuo route |
| `voiceover` | elevenlabs | `src/lib/beat-voiceover-generation.ts` (characters = input text length) |
| `music` | elevenlabs | `src/lib/music-generation.ts` (flat per track) |
| `test_image`, `test_animation`, `test_music`, `test_voiceover`, `test_longcat` | varies | `src/app/api/test/*` routes |

## 5. Enforcement integration

**Route guard order** (generation routes only): rate-limit → CSRF → session → UUID → ownership → **`assertSufficientBalance(userId, PRE_CHECK_EST_USD[action])`** → do the work. 402 on failure.

**Generate-all batch:**
- Dispatch route: after recomputing targets, check balance against `estimateBatchCost(...)` total (with clips if requested) → 402 before any Inngest event is sent.
- Orchestrator: each per-item `step.run` calls `assertSufficientBalance` before its provider call; insufficient balance produces the existing per-item `{ok:false, error}` result — the batch never halts, remaining items fail individually if the wallet drains mid-run.
- Concurrent items may overlap on the last few cents and dip the balance slightly negative — accepted by design.

## 6. API routes

- `GET /api/wallet` — session required; returns `{ balanceUsd, breakdown, transactions }` (recent 50; `?before=<cursor>` pagination by created_at). Reads own wallet only.
- `POST /api/wallet/credits` — full mutation guard stack (rate-limit `mutation`, CSRF, session). Manual body parse (house pattern, no zod): `amountUsd` must be a finite number, > 0, ≤ 1000, max 2 decimal places; optional `description` ≤ 200 chars. Inserts credit + atomic balance update; returns new balance.
- **Stripe-migration flag:** this self-credit route is the placeholder for real payments. When Stripe arrives it must be REMOVED (or admin-gated) and replaced by checkout + signature-verified webhook inserting the credit row. Recorded in feature.md as a release-gate note for that future phase.

## 7. UI

- **Navbar balance pill** — formatted `$4.23` beside the user name in `src/components/navbar.tsx` (new optional `balanceUsd` prop; server pages that render Navbar fetch `getWallet` and pass it). Links to the wallet page.
- **Wallet page** `src/app/(dashboard)/wallet/page.tsx` — balance headline, "Add credit" form (amount + note), spend-by-provider summary (this month / all-time), transaction history table (date, action, provider, model, amount, project name). Client component fetches `GET /api/wallet`; credit form POSTs and refreshes.
- **Editor touches** — Generate-all dialog shows `Balance: $X` (preview GET response gains `balanceUsd`) and disables Confirm when estimate > balance (server enforces regardless). Any 402 from generation actions surfaces a toast: "Insufficient balance — top up in Wallet" with link.

## 8. Security

- Server computes every debit amount; no client-supplied cost is ever trusted. The only user-chosen number is the credit `amountUsd`, validated and capped.
- Ledger rows immutable; corrections are new adjustment rows (no adjustment endpoint in this phase — psql only).
- All wallet reads/writes scoped to `session.user.id`; ownership pattern identical to existing routes.
- Money as `numeric(12,6)` end-to-end; balance arithmetic in SQL, JS only formats for display.
- Balance pre-checks server-side; UI disabling is cosmetic.
- Follows `security-playbook.md`; independent security review before merge (house workflow).

## 9. Migration & rollout

- One Drizzle migration: two enums + two tables + index. No backfill — wallet rows lazily created, existing spend history is not reconstructed (starts from $0; user credits actual remaining provider balances if desired).
- No behavior change for a user who never tops up… **except** blocking: balance 0 means paid actions 402. This is intended (it's the whole point) but must be called out: after deploy, the user tops up before generating.

## 10. Verification plan (house style: `npx tsc --noEmit` + `npm run lint` + live e2e; no unit harness)

Paid (~$0.10):
1. Top up $5 via wallet page UI → psql: credit row exists, balance 5.000000.
2. One suggest-image-prompt (~$0.001) → debit row with anthropic provider, token usage jsonb, computed amount plausible.
3. One shot image ($0.04) → fal debit row; navbar pill and wallet page reflect new balance without reload weirdness.
4. Invariant check via psql: ledger sum == wallets.balance_usd.

Free (psql state flips):
5. Set balance to 0.001 → single generation route returns 402 + toast; Generate-all dialog shows balance and disables Confirm; dispatch route 402s.
6. Restore balance; batch on throwaway project with balance set to cover only part of it → per-item insufficient-balance failures, batch completes, no halt.
7. Breakdown correctness: GROUP BY totals match hand-computed sums.

## 11. Future: Stripe path (design constraint, not built now)

The ledger/balance model is unchanged for real payments. The switch: credits come from a Stripe webhook (signature-verified, idempotent by event id) instead of the self-credit route; add `stripe_event_id` nullable column then (or store in a `metadata` jsonb — decide at that phase). Nothing in this phase's schema blocks that.
