/**
 * Build canonical.json from database usage data
 * Generates starter entries for top missing node types
 */

import * as fs from 'fs';
import * as path from 'path';
import { supabaseAdmin } from '../lib/supabase';
import type { CanonicalCatalog, CanonicalNodeEntry } from './loader';

/**
 * Title-case a string (e.g., "openAi" -> "Open AI")
 */
function titleCase(str: string): string {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/[._-]/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

/**
 * Extract display name from node_type
 */
function inferDisplayName(nodeType: string): string {
  // Try to get from existing node_library_nodes first
  // Otherwise infer from node_type
  const parts = nodeType.split('.');
  if (parts.length > 1) {
    // e.g., "@n8n/n8n-nodes-langchain.openAi" -> "Open AI"
    return titleCase(parts[parts.length - 1]);
  }
  return titleCase(nodeType);
}

/**
 * Infer category from node_type
 */
function inferCategory(nodeType: string): string {
  // Extract package name prefix if present
  if (nodeType.startsWith('@n8n/n8n-nodes-')) {
    const match = nodeType.match(/@n8n\/n8n-nodes-([^.]+)/);
    if (match) {
      return match[1];
    }
  }
  // Extract first part before dot
  const parts = nodeType.split('.');
  if (parts.length > 1) {
    return parts[0].replace(/^@/, '').replace(/\//g, '-');
  }
  return 'general';
}

async function buildCanonicalFromDb(): Promise<void> {
  console.log('[buildCanonical] Querying top missing node types...');

  // Query workflow_nodes and node_library_nodes separately (no RPC needed)
  const { data: workflowNodes, error: workflowError } = await supabaseAdmin
    .from('workflow_nodes')
    .select('node_type');

  const { data: libraryNodes, error: libraryError } = await supabaseAdmin
    .from('node_library_nodes')
    .select('node_type, config_schema');

  if (workflowError || libraryError) {
    console.error('[buildCanonical] Failed to query data:', workflowError || libraryError);
    process.exit(1);
  }

  if (!workflowNodes || !libraryNodes) {
    console.error('[buildCanonical] No data returned');
    process.exit(1);
  }

  // Build map of nodes with schemas
  const hasSchema = new Set(
    libraryNodes
      .filter(n => n.config_schema !== null)
      .map(n => n.node_type)
  );

  // Count usage of missing nodes
  const usageCount = new Map<string, number>();
  for (const wn of workflowNodes) {
    if (wn.node_type && !hasSchema.has(wn.node_type)) {
      usageCount.set(wn.node_type, (usageCount.get(wn.node_type) || 0) + 1);
    }
  }

  // Sort by usage count and take top 100
  const sorted = Array.from(usageCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([node_type, uses]) => ({ node_type, uses }));

  await processMissingNodes(sorted);
}

async function processMissingNodes(
  missingNodes: Array<{ node_type: string; uses: number }>
): Promise<void> {
  console.log(`[buildCanonical] Found ${missingNodes.length} missing node types`);

  // Get existing display names from node_library_nodes (if any)
  const nodeTypes = missingNodes.map(n => n.node_type);
  const { data: existingNodes } = await supabaseAdmin
    .from('node_library_nodes')
    .select('node_type, display_name, category')
    .in('node_type', nodeTypes);

  const existingMap = new Map<string, { display_name?: string; category?: string }>();
  if (existingNodes) {
    for (const node of existingNodes) {
      existingMap.set(node.node_type, {
        display_name: node.display_name || undefined,
        category: node.category || undefined,
      });
    }
  }

  // Build canonical entries
  const catalog: CanonicalCatalog = {
    version: '1.0.0',
    nodes: [],
  };

  for (const { node_type, uses } of missingNodes) {
    const existing = existingMap.get(node_type);
    
    const entry: CanonicalNodeEntry = {
      node_type,
      display_name: existing?.display_name || inferDisplayName(node_type),
      credential_types: [], // Empty - do not invent
      config_schema: {
        source: 'canonical',
        properties: [], // Empty - do not invent
      },
      package_name: undefined,
      package_version: undefined,
      docs_url: null,
      category: existing?.category || inferCategory(node_type),
    };

    catalog.nodes.push(entry);
    console.log(`[buildCanonical] Added ${node_type} (${uses} uses)`);
  }

  // Write canonical.json
  const catalogPath = path.join(process.cwd(), 'src', 'catalog', 'canonical.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');
  
  console.log(`[buildCanonical] Wrote ${catalog.nodes.length} entries to ${catalogPath}`);
}

// Run if called directly
if (require.main === module) {
  buildCanonicalFromDb()
    .then(() => {
      console.log('[buildCanonical] Done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[buildCanonical] Error:', err);
      process.exit(1);
    });
}

export { buildCanonicalFromDb };

