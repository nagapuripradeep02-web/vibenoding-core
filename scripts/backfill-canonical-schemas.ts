/**
 * Backfill Script: Copy legacy node_library_nodes rows to node_library_canonical_schemas
 * 
 * Usage:
 *   ENABLE_NODE_LIBRARY_BACKFILL=1 ADMIN_SECRET=your-secret ts-node scripts/backfill-canonical-schemas.ts
 * 
 * This script copies existing node_library_nodes rows (with non-null config_schema)
 * into node_library_canonical_schemas with defaults:
 * - type_version: 0
 * - package_version: ''
 * - source: 'canonical'
 * 
 * Guarded by ENABLE_NODE_LIBRARY_BACKFILL=1 env flag.
 */

import { supabaseAdmin } from '../src/lib/supabase';
import { computeSchemaHash } from '../src/v3/nodeLibrary';

const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

async function backfillCanonicalSchemas() {
  // Guard: require env flag
  const enableBackfill = process.env.ENABLE_NODE_LIBRARY_BACKFILL === '1';
  if (!enableBackfill) {
    console.error('ERROR: ENABLE_NODE_LIBRARY_BACKFILL=1 is required to run this script');
    process.exit(1);
  }

  console.log('[backfill] Starting canonical schemas backfill...');

  // Find all rows in node_library_nodes with non-null config_schema
  const { data: legacyNodes, error: queryError } = await supabaseAdmin
    .from('node_library_nodes')
    .select('node_type, config_schema, credential_types, source, fetched_at')
    .not('config_schema', 'is', null);

  if (queryError) {
    console.error('[backfill] Failed to query legacy nodes:', queryError);
    process.exit(1);
  }

  if (!legacyNodes || legacyNodes.length === 0) {
    console.log('[backfill] No legacy nodes found to backfill');
    process.exit(0);
  }

  console.log(`[backfill] Found ${legacyNodes.length} legacy nodes to process`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const node of legacyNodes) {
    const typeVersion = 0; // Default
    const packageVersion = ''; // Default
    const schemaHash = node.config_schema ? computeSchemaHash(node.config_schema as Record<string, unknown>) : null;

    // Check if canonical_schemas row already exists for this triplet
    const { data: existing } = await supabaseAdmin
      .from('node_library_canonical_schemas')
      .select('config_schema')
      .eq('node_type', node.node_type)
      .eq('type_version', typeVersion)
      .eq('package_version', packageVersion)
      .single();

    // For default triplet (type_version=0, package_version=''), update if incoming config_schema is non-null
    // Otherwise, skip if already exists
    if (existing && existing.config_schema !== null && node.config_schema === null) {
      skipped++;
      if (debugEnabled) {
        console.log(`[backfill] Skipped ${node.node_type} (already exists with non-null schema)`);
      }
      continue;
    }

    const canonicalSchemaData = {
      node_type: node.node_type,
      type_version: typeVersion,
      package_version: packageVersion,
      config_schema: node.config_schema,
      credential_types: node.credential_types || null,
      schema_hash: schemaHash,
      fetched_at: node.fetched_at || new Date().toISOString(),
      source: 'canonical',
    };

    const { error: upsertError } = await supabaseAdmin
      .from('node_library_canonical_schemas')
      .upsert(canonicalSchemaData, { onConflict: 'node_type,type_version,package_version' });

    if (upsertError) {
      if (debugEnabled) {
        console.error(`[backfill] Failed to upsert ${node.node_type}:`, upsertError);
      }
      skipped++;
    } else {
      if (existing) {
        updated++;
        if (debugEnabled) {
          console.log(`[backfill] Updated ${node.node_type} (typeVersion: ${typeVersion}, packageVersion: ${packageVersion})`);
        }
      } else {
        inserted++;
        if (debugEnabled) {
          console.log(`[backfill] Inserted ${node.node_type} (typeVersion: ${typeVersion}, packageVersion: ${packageVersion})`);
        }
      }
    }
  }

  console.log(`[backfill] Complete: scanned=${legacyNodes.length}, inserted=${inserted}, updated=${updated}, skipped=${skipped}`);
  process.exit(0);
}

backfillCanonicalSchemas().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});

