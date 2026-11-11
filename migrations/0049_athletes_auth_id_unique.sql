-- 0049_athletes_auth_id_unique — Phase A Step 2c closure (design step2c §5.4, §10 step 3).
--
-- One user id may not sit on two athlete rows. Added ONLY after server/scripts/checkAthleteAuthCollisions.ts
-- reported NO COLLISIONS on both dev and prod (dev: the pre-existing duplicate 'demo' row was repaired by
-- server/scripts/fixDuplicateAthleteRow.ts with its dependency-inventory precondition; prod: zero athlete rows).
-- Partial: rows without a user (auth_id IS NULL) are unconstrained. Idempotent.
--
-- This does not protect against two users overwriting one row — linkUserToAthlete's atomic conditional
-- write does (Step 2c review). It protects against one user spread over two rows.

CREATE UNIQUE INDEX IF NOT EXISTS athletes_auth_id_uq ON athletes (auth_id) WHERE auth_id IS NOT NULL;
