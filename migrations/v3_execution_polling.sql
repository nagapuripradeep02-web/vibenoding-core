-- V3 execution polling migration (idempotent)
-- Adds columns used by execution poller to record node-level last run metadata.

alter table public.workflow_node_state
  add column if not exists last_run_at timestamptz;

alter table public.workflow_node_state
  add column if not exists last_execution_id text;
