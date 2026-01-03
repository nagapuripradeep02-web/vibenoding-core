-- ============================================================================
-- Node Library Schema Validation Queries
-- ============================================================================
-- Use these queries to verify that node_library_nodes.config_schema contains
-- real schemas (not stubs) and that workflow_nodes.params_summary is populated.
--
-- Run these in Supabase SQL Editor or your PostgreSQL client.
-- ============================================================================

-- Count rows with real schema vs stub
SELECT
  COUNT(*) AS total,
  SUM((config_schema IS NOT NULL AND config_schema->>'source' = 'n8n_instance')::int) AS with_real_schema,
  SUM((config_schema IS NOT NULL AND config_schema->>'source' = 'stub')::int) AS with_stub,
  SUM((config_schema IS NULL)::int) AS with_null_schema,
  SUM((credential_types IS NOT NULL AND array_length(credential_types, 1) > 0)::int) AS with_creds
FROM public.node_library_nodes;

-- List node_types missing schema (NULL or stub)
SELECT 
  node_type, 
  display_name, 
  category,
  CASE 
    WHEN config_schema IS NULL THEN 'NULL'
    WHEN config_schema->>'source' = 'stub' THEN 'stub'
    WHEN config_schema->>'source' = 'n8n_instance' THEN 'real'
    ELSE 'unknown'
  END AS schema_status
FROM public.node_library_nodes
WHERE config_schema IS NULL 
   OR config_schema->>'source' = 'stub'
   OR (config_schema->>'source' = 'n8n_instance' AND 
       (config_schema->'properties' IS NULL OR jsonb_array_length(config_schema->'properties') = 0) AND
       (config_schema->'credentials' IS NULL))
ORDER BY node_type;

-- Count workflow_nodes with params_summary
SELECT
  COUNT(*) AS total,
  SUM((params_summary IS NOT NULL)::int) AS with_summary,
  SUM((params_summary IS NULL)::int) AS without_summary,
  ROUND(100.0 * SUM((params_summary IS NOT NULL)::int) / COUNT(*), 2) AS summary_coverage_pct
FROM public.workflow_nodes;

-- List workflow_nodes missing params_summary
SELECT 
  connection_id,
  workflow_id,
  node_id,
  node_name,
  node_type,
  created_at
FROM public.workflow_nodes
WHERE params_summary IS NULL
ORDER BY created_at DESC
LIMIT 50;

-- Check node types with real properties array
SELECT 
  node_type,
  display_name,
  jsonb_array_length(config_schema->'properties') AS properties_count,
  CASE 
    WHEN config_schema->'credentials' IS NOT NULL THEN 'yes'
    ELSE 'no'
  END AS has_credentials
FROM public.node_library_nodes
WHERE config_schema IS NOT NULL 
  AND config_schema->>'source' = 'n8n_instance'
  AND (
    jsonb_array_length(config_schema->'properties') > 0 OR
    config_schema->'credentials' IS NOT NULL
  )
ORDER BY properties_count DESC
LIMIT 20;

-- Summary: Overall health check
SELECT 
  'node_library_nodes' AS table_name,
  COUNT(*) AS total_rows,
  SUM((config_schema IS NOT NULL AND config_schema->>'source' = 'n8n_instance')::int) AS real_schemas,
  SUM((config_schema IS NULL OR config_schema->>'source' = 'stub')::int) AS needs_repair
FROM public.node_library_nodes
UNION ALL
SELECT 
  'workflow_nodes' AS table_name,
  COUNT(*) AS total_rows,
  SUM((params_summary IS NOT NULL)::int) AS with_summary,
  SUM((params_summary IS NULL)::int) AS needs_backfill
FROM public.workflow_nodes;



