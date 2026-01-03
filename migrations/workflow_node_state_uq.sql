-- Idempotent migration: ensure UNIQUE constraint/index exists for workflow_node_state
-- Target: (connection_id, workflow_id, node_id)
-- Index name: workflow_node_state_uq
--
-- Safe dedupe strategy:
-- If duplicates exist, keep the most recently updated row and delete older ones.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'workflow_node_state'
  ) THEN
    -- Dedupe rows before creating unique index (keep latest updated_at)
    WITH ranked AS (
      SELECT
        ctid,
        ROW_NUMBER() OVER (
          PARTITION BY connection_id, workflow_id, node_id
          ORDER BY updated_at DESC NULLS LAST
        ) AS rn
      FROM public.workflow_node_state
    )
    DELETE FROM public.workflow_node_state w
    USING ranked r
    WHERE w.ctid = r.ctid
      AND r.rn > 1;

    -- Create unique index if it does not already exist
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'workflow_node_state_uq'
    ) THEN
      CREATE UNIQUE INDEX workflow_node_state_uq
        ON public.workflow_node_state (connection_id, workflow_id, node_id);
    END IF;
  END IF;
END $$;


