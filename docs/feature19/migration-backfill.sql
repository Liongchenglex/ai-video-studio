-- Directing Controls (Clip Engine v3) deploy sequence — run BEFORE drizzle-kit push
-- 1. Backfill legacy chaining flags into ends_on (idempotent):
UPDATE shots SET ends_on = 'next' WHERE chain_to_next = true AND ends_on <> 'next';
-- 2. Verify zero unmigrated rows (must return 0):
SELECT count(*) FROM shots WHERE chain_to_next = true AND ends_on <> 'next';
-- 3. Only then apply the schema push that drops chain_to_next.
