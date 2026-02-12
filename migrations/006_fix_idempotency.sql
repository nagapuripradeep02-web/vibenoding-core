-- Fix idempotency index: Use a standard UNIQUE INDEX instead of partial
-- This ensures compatibility with Supabase/PostgREST upsert (ON CONFLICT) logic.
-- PostgreSQL allows multiple NULL values in a unique index, so this is safe.

DROP INDEX IF EXISTS idx_step_applications_idempotency_unique;
DROP INDEX IF EXISTS idx_step_applications_idempotency_key;
DROP INDEX IF EXISTS step_applications_idempotency_key_uq;

CREATE UNIQUE INDEX IF NOT EXISTS step_applications_idempotency_key_uq
ON public.step_applications (idempotency_key);
