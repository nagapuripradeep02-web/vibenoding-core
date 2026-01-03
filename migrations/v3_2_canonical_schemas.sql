-- V3.2 Canonical Schemas Migration
-- Creates version-aware canonical schemas table with unique constraint
-- Run this migration in Supabase SQL Editor

-- Create node_library_canonical_schemas table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.node_library_canonical_schemas (
  node_type TEXT NOT NULL,
  type_version INTEGER NOT NULL DEFAULT 0,
  package_version TEXT NOT NULL DEFAULT '',
  config_schema JSONB,
  credential_types TEXT[],
  schema_hash TEXT,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'canonical',
  PRIMARY KEY (node_type, type_version, package_version)
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_canonical_schemas_node_type 
  ON public.node_library_canonical_schemas(node_type);

CREATE INDEX IF NOT EXISTS idx_canonical_schemas_version_lookup 
  ON public.node_library_canonical_schemas(node_type, package_version, type_version);

-- Add comment
COMMENT ON TABLE public.node_library_canonical_schemas IS 
  'Version-aware canonical node type schemas. Used for typeVersion-aware resolution.';

