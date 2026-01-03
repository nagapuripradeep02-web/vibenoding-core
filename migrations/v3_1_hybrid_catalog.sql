-- V3.1 Hybrid Catalog Migration
-- Adds canonical catalog support and instance-specific overrides
-- Run this migration in Supabase SQL Editor

-- Add new columns to node_library_nodes (idempotent)
ALTER TABLE public.node_library_nodes
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS package_name TEXT,
  ADD COLUMN IF NOT EXISTS package_version TEXT,
  ADD COLUMN IF NOT EXISTS schema_hash TEXT,
  ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ;

-- Create node_library_node_overrides table for instance-specific schemas
CREATE TABLE IF NOT EXISTS public.node_library_node_overrides (
  connection_id UUID NOT NULL REFERENCES n8n_connections(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL,
  config_schema JSONB,
  credential_types TEXT[],
  source TEXT NOT NULL DEFAULT 'n8n_instance',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (connection_id, node_type)
);

CREATE INDEX IF NOT EXISTS idx_node_overrides_lookup 
  ON public.node_library_node_overrides(connection_id, node_type);

CREATE INDEX IF NOT EXISTS idx_node_overrides_node_type 
  ON public.node_library_node_overrides(node_type);

-- Add comment
COMMENT ON TABLE public.node_library_node_overrides IS 
  'Instance-specific node type schema overrides. Used when we can fetch real schemas from user n8n instance.';



