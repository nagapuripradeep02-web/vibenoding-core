/**
 * V3.1 Node Library Module
 * CRUD, search, and seed operations for n8n node type knowledge
 */

import * as fs from 'fs';
import * as path from 'path';
import { supabaseAdmin } from '../lib/supabase';
import { getNodeCatalog, getWorkflow } from '../v3/n8nClient';
import type { N8nWorkflow } from './types';
import type {
  NodeLibraryNode,
  NodeLibraryErrorPattern,
  NodeLibrarySearchResult,
  NodeLibraryNodeWithPatterns,
  NodeLibrarySeedData,
  NodeLibrarySeedNode,
  WorkflowNode,
  ErrorPatternMatchers,
} from './nodeLibraryTypes';
import { getCanonicalEntry, loadCanonicalCatalog } from '../catalog/loader';
import * as crypto from 'crypto';

// ============================================================================
// Node Definition CRUD
// ============================================================================

/**
 * Upsert a node definition into the library
 */
export async function upsertNodeDefinition(
  node: Omit<NodeLibraryNode, 'created_at' | 'updated_at'>
): Promise<{ error: Error | null }> {
  const searchText = [
    node.display_name,
    node.node_type,
    node.category,
    node.description,
    ...(node.credential_types || []),
  ]
    .filter(Boolean)
    .join(' ');

  const { error } = await supabaseAdmin
    .from('node_library_nodes')
    .upsert(
      {
        node_type: node.node_type,
        display_name: node.display_name,
        category: node.category,
        description: node.description,
        docs_url: node.docs_url || null,
        credential_types: node.credential_types || null,
        config_schema: node.config_schema || null,
        input_hints: node.input_hints || null,
        output_hints: node.output_hints || null,
        troubleshooting: node.troubleshooting || null,
        search_text: searchText,
      },
      { onConflict: 'node_type' }
    );

  if (error) {
    console.error('[nodeLibrary] upsertNodeDefinition failed:', error);
    return { error: new Error(error.message) };
  }

  return { error: null };
}

/**
 * Get a node definition by type
 */
export async function getNodeDefinition(
  nodeType: string
): Promise<{ data: NodeLibraryNode | null; error: Error | null }> {
  const { data, error } = await supabaseAdmin
    .from('node_library_nodes')
    .select('*')
    .eq('node_type', nodeType)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return { data: null, error: null };
    }
    console.error('[nodeLibrary] getNodeDefinition failed:', error);
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as NodeLibraryNode, error: null };
}

/**
 * Search node library using full-text search
 */
export async function searchNodeLibrary(
  query: string,
  limit: number = 10
): Promise<{ data: NodeLibrarySearchResult[]; error: Error | null }> {
  if (!query || query.trim().length === 0) {
    return { data: [], error: null };
  }

  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .map((word) => word + ':*')
    .join(' & ');

  const { data, error } = await supabaseAdmin
    .from('node_library_nodes')
    .select('node_type, display_name, category, description')
    .textSearch('search_text', ftsQuery, { type: 'websearch', config: 'english' })
    .limit(limit);

  if (error) {
    console.warn('[nodeLibrary] FTS failed, falling back to ILIKE:', error);
    const likeQuery = `%${query}%`;
    const { data: fallbackData, error: fallbackError } = await supabaseAdmin
      .from('node_library_nodes')
      .select('node_type, display_name, category, description')
      .or(`display_name.ilike.${likeQuery},node_type.ilike.${likeQuery},description.ilike.${likeQuery}`)
      .limit(limit);

    if (fallbackError) {
      console.error('[nodeLibrary] searchNodeLibrary fallback failed:', fallbackError);
      return { data: [], error: new Error(fallbackError.message) };
    }

    return { data: (fallbackData || []) as NodeLibrarySearchResult[], error: null };
  }

  return { data: (data || []) as NodeLibrarySearchResult[], error: null };
}

// ============================================================================
// Error Pattern CRUD
// ============================================================================

export async function getErrorPatterns(
  nodeType: string
): Promise<{ data: NodeLibraryErrorPattern[]; error: Error | null }> {
  // Get node-specific patterns first, then global patterns (node_type IS NULL)
  const { data, error } = await supabaseAdmin
    .from('node_library_error_patterns')
    .select('*')
    .or(`node_type.eq.${nodeType},node_type.is.null`)
    .order('node_type', { ascending: false }); // Node-specific first, then global

  if (error) {
    console.error('[nodeLibrary] getErrorPatterns failed:', error);
    return { data: [], error: new Error(error.message) };
  }

  return { data: (data || []) as NodeLibraryErrorPattern[], error: null };
}

export async function upsertErrorPattern(
  pattern: Omit<NodeLibraryErrorPattern, 'id' | 'created_at'> & { id?: string }
): Promise<{ error: Error | null }> {
  const { error } = await supabaseAdmin.from('node_library_error_patterns').upsert(
    {
      id: pattern.id || undefined,
      node_type: pattern.node_type,
      title: pattern.title,
      matchers: pattern.matchers || null,
      explanation: pattern.explanation,
      fix_steps: pattern.fix_steps,
      tags: pattern.tags || null,
      severity: pattern.severity || 'info',
    },
    { onConflict: 'id' }
  );

  if (error) {
    console.error('[nodeLibrary] upsertErrorPattern failed:', error);
    return { error: new Error(error.message) };
  }

  return { error: null };
}

export function matchErrorPattern(
  patterns: NodeLibraryErrorPattern[],
  errorMessage: string | null
): NodeLibraryErrorPattern | null {
  if (!errorMessage || patterns.length === 0) {
    return null;
  }

  const lowerError = errorMessage.toLowerCase();

  for (const pattern of patterns) {
    if (!pattern.matchers) continue;

    const matchers = pattern.matchers as ErrorPatternMatchers;

    if (matchers.contains && matchers.contains.length > 0) {
      const matches = matchers.contains.every((term) =>
        lowerError.includes(term.toLowerCase())
      );
      if (matches) return pattern;
    }

    if (matchers.regex) {
      try {
        const regex = new RegExp(matchers.regex, 'i');
        if (regex.test(errorMessage)) return pattern;
      } catch (e) {
        console.warn('[nodeLibrary] Invalid regex in pattern:', pattern.id, e);
      }
    }
  }

  return null;
}

export async function getNodeWithPatterns(
  nodeType: string,
  options?: { errorText?: string; operation?: string }
): Promise<{ data: NodeLibraryNodeWithPatterns & { docsSearchResults?: unknown[] }; error: Error | null }> {
  const [defResult, patternsResult] = await Promise.all([
    getNodeDefinition(nodeType),
    getErrorPatterns(nodeType),
  ]);

  if (defResult.error) {
    return { data: { nodeDefinition: null, errorPatterns: [] }, error: defResult.error };
  }

  if (patternsResult.error) {
    return {
      data: { nodeDefinition: defResult.data, errorPatterns: [] },
      error: patternsResult.error,
    };
  }

  const result: NodeLibraryNodeWithPatterns & { docsSearchResults?: unknown[] } = {
    nodeDefinition: defResult.data,
    errorPatterns: patternsResult.data,
  };

  // Optional: Add MCP docs search if configured and error exists
  if (options?.errorText && process.env.N8N_DOCS_MCP_URL) {
    const docsResult = await n8nDocsSearch(options.errorText, nodeType, options.operation, options.errorText);
    if (!docsResult.error && docsResult.results.length > 0) {
      result.docsSearchResults = docsResult.results;
    }
  }

  return {
    data: result,
    error: null,
  };
}

// ============================================================================
// Workflow Nodes CRUD
// ============================================================================

export async function upsertWorkflowNodes(
  nodes: WorkflowNode[]
): Promise<{ error: Error | null }> {
  if (nodes.length === 0) return { error: null };

  const rows = nodes.map((n) => ({
    connection_id: n.connection_id,
    workflow_id: n.workflow_id,
    node_id: n.node_id,
    node_name: n.node_name,
    node_type: n.node_type,
    // Truncate typeVersion to integer (langchain nodes use decimals like 1.1, but DB column is INTEGER)
    node_type_version: n.node_type_version !== undefined && n.node_type_version !== null 
      ? Math.floor(n.node_type_version) 
      : null,
    node_package_version: n.node_package_version !== undefined ? n.node_package_version : null,
    is_subnode: n.is_subnode || false,
    params_summary: n.params_summary || null,
  }));

  const { error } = await supabaseAdmin
    .from('workflow_nodes')
    .upsert(rows, { onConflict: 'connection_id,workflow_id,node_id' });

  if (error) {
    console.error('[nodeLibrary] upsertWorkflowNodes failed:', error);
    return { error: new Error(error.message) };
  }

  return { error: null };
}

export async function getWorkflowNode(
  connectionId: string,
  workflowId: string,
  nodeId: string
): Promise<{ data: WorkflowNode | null; error: Error | null }> {
  const { data, error } = await supabaseAdmin
    .from('workflow_nodes')
    .select('*')
    .eq('connection_id', connectionId)
    .eq('workflow_id', workflowId)
    .eq('node_id', nodeId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return { data: null, error: null };
    }
    console.error('[nodeLibrary] getWorkflowNode failed:', error);
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as WorkflowNode, error: null };
}

export async function getWorkflowNodeByName(
  connectionId: string,
  workflowId: string,
  nodeName: string
): Promise<{ data: WorkflowNode | null; error: Error | null }> {
  const { data, error } = await supabaseAdmin
    .from('workflow_nodes')
    .select('*')
    .eq('connection_id', connectionId)
    .eq('workflow_id', workflowId)
    .eq('node_name', nodeName)
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return { data: null, error: null };
    }
    console.error('[nodeLibrary] getWorkflowNodeByName failed:', error);
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as WorkflowNode, error: null };
}

// ============================================================================
// Seeding
// ============================================================================

export async function seedNodeLibraryFromJson(
  filePath: string,
  options: { overwrite?: boolean } = {}
): Promise<{ nodesSeeded: number; patternsSeeded: number; error: Error | null }> {
  const { overwrite = false } = options;

  let seedData: NodeLibrarySeedData;
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    const raw = fs.readFileSync(absolutePath, 'utf-8');
    seedData = JSON.parse(raw) as NodeLibrarySeedData;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error reading seed file';
    console.error('[nodeLibrary] Failed to read seed file:', msg);
    return { nodesSeeded: 0, patternsSeeded: 0, error: new Error(msg) };
  }

  if (!seedData.nodes || !Array.isArray(seedData.nodes)) {
    return { nodesSeeded: 0, patternsSeeded: 0, error: new Error('Invalid seed data: missing nodes array') };
  }

  let nodesSeeded = 0;
  let patternsSeeded = 0;

  for (const seedNode of seedData.nodes) {
    if (!overwrite) {
      const existing = await getNodeDefinition(seedNode.node_type);
      if (existing.data) {
        console.log(`[nodeLibrary] Skipping existing node: ${seedNode.node_type}`);
        continue;
      }
    }

    const nodeResult = await upsertNodeDefinition({
      node_type: seedNode.node_type,
      display_name: seedNode.display_name,
      category: seedNode.category,
      description: seedNode.description,
      docs_url: seedNode.docs_url || null,
      credential_types: seedNode.credential_types || null,
      config_schema: seedNode.config_schema || null,
      input_hints: seedNode.input_hints || null,
      output_hints: seedNode.output_hints || null,
      troubleshooting: seedNode.troubleshooting || null,
    });

    if (nodeResult.error) {
      console.error(`[nodeLibrary] Failed to seed node ${seedNode.node_type}:`, nodeResult.error);
      continue;
    }

    nodesSeeded++;

    if (seedNode.error_patterns && seedNode.error_patterns.length > 0) {
      for (const pattern of seedNode.error_patterns) {
        const patternResult = await upsertErrorPattern({
          node_type: seedNode.node_type,
          title: pattern.title,
          matchers: pattern.matchers || null,
          explanation: pattern.explanation,
          fix_steps: pattern.fix_steps,
          tags: pattern.tags || null,
          severity: pattern.severity || 'info',
        });

        if (patternResult.error) {
          console.error(`[nodeLibrary] Failed to seed pattern for ${seedNode.node_type}:`, patternResult.error);
          continue;
        }

        patternsSeeded++;
      }
    }
  }

  console.log(`[nodeLibrary] Seeded ${nodesSeeded} nodes, ${patternsSeeded} error patterns`);
  return { nodesSeeded, patternsSeeded, error: null };
}

// ============================================================================
// Coverage Guard Helpers
// ============================================================================

/**
 * Humanize node type name for display
 * Example: "n8n-nodes-base.respondToWebhook" -> "Respond To Webhook"
 */
function humanizeNodeTypeName(nodeType: string): string {
  const parts = nodeType.split('.');
  const lastSegment = parts[parts.length - 1] || nodeType;
  
  // Convert camelCase to Title Case
  return lastSegment
    .replace(/([A-Z])/g, ' $1') // Add space before capital letters
    .replace(/^./, (str) => str.toUpperCase()) // Capitalize first letter
    .trim();
}

/**
 * Infer node category from node type string
 */
function inferNodeCategory(nodeType: string): string {
  const lower = nodeType.toLowerCase();
  
  if (lower.includes('langchain')) return 'ai';
  if (lower.includes('trigger') || lower.endsWith('trigger')) return 'trigger';
  if (lower.includes('postgres')) return 'database';
  if (lower.includes('stickynote')) return 'ui';
  
  return 'core';
}

/**
 * Check if a node type is executable (not UI-only)
 */
export function isExecutableNodeType(nodeType: string): boolean {
  const lower = nodeType.toLowerCase();
  return !lower.includes('stickynote');
}

/**
 * Ensure all node types exist in node_library_nodes (create stubs for missing ones)
 * This is called during workflow sync to prevent gaps in coverage.
 */
export async function ensureNodeLibraryNodesExist(
  nodeTypes: string[]
): Promise<{ inserted: number; skipped: number; error: Error | null }> {
  if (!nodeTypes || nodeTypes.length === 0) {
    return { inserted: 0, skipped: 0, error: null };
  }

  // Deduplicate
  const uniqueTypes = [...new Set(nodeTypes.filter(Boolean))];
  if (uniqueTypes.length === 0) {
    return { inserted: 0, skipped: 0, error: null };
  }

  try {
    // Query existing node types
    const { data: existing, error: queryError } = await supabaseAdmin
      .from('node_library_nodes')
      .select('node_type')
      .in('node_type', uniqueTypes);

    if (queryError) {
      console.error('[nodeLibrary] Failed to query existing node types:', queryError);
      return { inserted: 0, skipped: 0, error: new Error(queryError.message) };
    }

    const existingSet = new Set((existing || []).map((row: any) => row.node_type));
    const missingTypes = uniqueTypes.filter((type) => !existingSet.has(type));

    if (missingTypes.length === 0) {
      const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
      if (debugEnabled) {
        console.log(`[nodeLibrary] Auto-stubs: inserted=0, skipped=${uniqueTypes.length}`);
      }
      return { inserted: 0, skipped: uniqueTypes.length, error: null };
    }

    // Create stub rows for missing types (with minimal config_schema)
    const stubRows = missingTypes.map((nodeType) => {
      const displayName = humanizeNodeTypeName(nodeType);
      const category = inferNodeCategory(nodeType);
      const searchText = `${displayName} ${nodeType} ${category}`;

      // Minimal config_schema for stubs
      const minimalSchema = {
        source: 'stub' as const,
        node_type: nodeType,
        display_name: displayName,
        docs_url: null,
        credential_types: null,
        fetched_at: new Date().toISOString(),
      };

      return {
        node_type: nodeType,
        display_name: displayName,
        category,
        description: '',
        docs_url: null,
        credential_types: null,
        config_schema: minimalSchema,
        input_hints: null,
        output_hints: null,
        troubleshooting: null,
        search_text: searchText,
      };
    });

    // Upsert (idempotent - won't overwrite existing rows)
    const { error: upsertError } = await supabaseAdmin
      .from('node_library_nodes')
      .upsert(stubRows, { onConflict: 'node_type' });

    if (upsertError) {
      console.error('[nodeLibrary] Failed to insert stub nodes:', upsertError);
      return { inserted: 0, skipped: existingSet.size, error: new Error(upsertError.message) };
    }

    const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
    if (debugEnabled) {
      console.log(`[nodeLibrary] Auto-stubs: inserted=${missingTypes.length}, skipped=${existingSet.size}`);
    }

    return { inserted: missingTypes.length, skipped: existingSet.size, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[nodeLibrary] ensureNodeLibraryNodesExist failed:', msg);
    return { inserted: 0, skipped: 0, error: new Error(msg) };
  }
}

// ============================================================================
// Node Catalog Sync from n8n
// ============================================================================

/**
 * Compute hash of config_schema for change detection
 */
export function computeSchemaHash(schema: Record<string, unknown> | null): string | null {
  if (!schema) return null;
  try {
    const normalized = JSON.stringify(schema, Object.keys(schema).sort());
    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  } catch {
    return null;
  }
}

/**
 * Get node definition with hybrid catalog (canonical + override)
 */
async function getHybridNodeDefinition(
  connectionId: string,
  nodeType: string
): Promise<{ 
  config_schema: Record<string, unknown> | null; 
  credential_types: string[] | null;
  source: string;
  package_name?: string;
  package_version?: string;
}> {
  // First check override (instance-specific)
  const { data: override } = await supabaseAdmin
    .from('node_library_node_overrides')
    .select('config_schema, credential_types, source, fetched_at')
    .eq('connection_id', connectionId)
    .eq('node_type', nodeType)
    .single();
  
  if (override?.config_schema) {
    return {
      config_schema: override.config_schema as Record<string, unknown>,
      credential_types: override.credential_types || null,
      source: override.source || 'n8n_instance',
    };
  }
  
  // Fall back to canonical
  const canonical = getCanonicalEntry(nodeType);
  if (canonical?.config_schema) {
    return {
      config_schema: canonical.config_schema as Record<string, unknown>,
      credential_types: canonical.credential_types || null,
      source: 'canonical',
      package_name: canonical.package_name,
      package_version: canonical.package_version,
    };
  }
  
  return {
    config_schema: null,
    credential_types: null,
    source: 'none',
  };
}

/**
 * Resolve schema for a node with typeVersion-aware resolution
 * 
 * Full resolution order (when connectionId provided):
 * 1) Override exact match in node_library_node_overrides_v2 (connection_id,node_type,typeVersion,packageVersion)
 * 2) Canonical exact match in node_library_canonical_schemas (node_type,typeVersion,packageVersion)
 * 3) Canonical nearest lower type_version (same node_type + packageVersion, type_version <= requested, pick max)
 * 4) Legacy fallback from node_library_nodes
 * 5) None
 * 
 * Canonical-only mode (when connectionId is null):
 * 1) Canonical exact match in node_library_canonical_schemas (node_type,typeVersion,packageVersion)
 * 2) Canonical nearest lower type_version (same node_type + packageVersion, type_version <= requested, pick max)
 *    - If packageVersion is empty, prefer packageVersion='' first, then allow any packageVersion
 * 3) None
 */
export async function resolveSchemaForNode(params: {
  connectionId: string | null;
  nodeType: string;
  typeVersion?: number | null;
  packageVersion?: string | null;
}): Promise<{
  source: 'override' | 'canonical' | 'canonical_nearest_lower' | 'canonical_legacy' | 'none';
  node_type: string;
  type_version: number | null;
  package_version: string | null;
  config_schema: Record<string, unknown> | null;
  credential_types: string[] | null;
}> {
  const { connectionId, nodeType, typeVersion, packageVersion } = params;
  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
  const typeVersionInt = typeVersion !== null && typeVersion !== undefined ? Number(typeVersion) : null;
  const packageVersionStr = packageVersion !== null && packageVersion !== undefined ? String(packageVersion) : '';
  const canonicalOnly = connectionId === null || connectionId === undefined;

  if (debugEnabled) {
    console.log(`[resolveSchema] Resolving schema for ${nodeType} (typeVersion: ${typeVersionInt}, packageVersion: ${packageVersionStr}, canonicalOnly: ${canonicalOnly})`);
  }

  // 1) Try override exact match in node_library_node_overrides_v2 (only if connectionId provided)
  if (!canonicalOnly && typeVersionInt !== null) {
    const { data: overrideExact } = await supabaseAdmin
      .from('node_library_node_overrides_v2')
      .select('config_schema, credential_types, source, type_version, package_version')
      .eq('connection_id', connectionId)
      .eq('node_type', nodeType)
      .eq('type_version', typeVersionInt)
      .eq('package_version', packageVersionStr)
      .single();

    if (overrideExact?.config_schema) {
      if (debugEnabled) {
        console.log(`[resolveSchema] Found override exact for ${nodeType} v${typeVersionInt} pkg${packageVersionStr}`);
      }
      return {
        source: 'override',
        node_type: nodeType,
        type_version: typeVersionInt,
        package_version: overrideExact.package_version || '',
        config_schema: overrideExact.config_schema as Record<string, unknown>,
        credential_types: overrideExact.credential_types || null,
      };
    }
  }

  // Helper to check if schema is usable (not a placeholder)
  function isUsableSchema(schema: any): boolean {
    if (!schema || typeof schema !== 'object') return false;
    const schemaStr = JSON.stringify(schema);
    const schemaBytes = Buffer.byteLength(schemaStr, 'utf8');
    const properties = schema.properties || (Array.isArray(schema) ? schema : null);
    const propertiesCount = Array.isArray(properties) ? properties.length : 0;
    
    // Skip placeholder/empty schemas: properties.length === 0 AND (schema_bytes < 200 OR has only {source,properties})
    return !(
      propertiesCount === 0 &&
      schemaBytes < 200 &&
      schema.source === 'canonical' &&
      Object.keys(schema).length <= 2
    );
  }

  // 2) Try canonical exact match in node_library_canonical_schemas
  if (typeVersionInt !== null) {
    // If packageVersion is empty, try without package_version constraint first
    let canonicalExact = null;
    
    if (packageVersionStr === '') {
      // Empty packageVersion means "not provided" - try to find best match ignoring package_version
      const { data: candidates } = await supabaseAdmin
        .from('node_library_canonical_schemas')
        .select('config_schema, credential_types, type_version, package_version')
        .eq('node_type', nodeType)
        .eq('type_version', typeVersionInt)
        .order('package_version', { ascending: false, nullsFirst: false })
        .limit(10);

      if (candidates && Array.isArray(candidates)) {
        for (const candidate of candidates) {
          if (candidate.config_schema && isUsableSchema(candidate.config_schema)) {
            canonicalExact = candidate;
            break;
          }
        }
      }
    } else {
      // Try exact match with package_version
      const { data: exact } = await supabaseAdmin
        .from('node_library_canonical_schemas')
        .select('config_schema, credential_types, type_version, package_version')
        .eq('node_type', nodeType)
        .eq('type_version', typeVersionInt)
        .eq('package_version', packageVersionStr)
        .single();

      if (exact?.config_schema && isUsableSchema(exact.config_schema)) {
        canonicalExact = exact;
      }
    }

    if (canonicalExact?.config_schema) {
      const schema = canonicalExact.config_schema as Record<string, unknown>;
      if (debugEnabled) {
        console.log(`[resolveSchema] Found canonical exact for ${nodeType} v${canonicalExact.type_version} pkg${canonicalExact.package_version || ''}`);
      }
      return {
        source: 'canonical',
        node_type: nodeType,
        type_version: canonicalExact.type_version || typeVersionInt,
        package_version: canonicalExact.package_version || '',
        config_schema: schema,
        credential_types: canonicalExact.credential_types || null,
      };
    }
  }

  // 3) For requested typeVersion > 0: Try best available REAL canonical (type_version > 0) BEFORE tv=0 alias
  // For requested typeVersion == 0: Try tv=0 alias first, then fallback to best REAL version
  if (typeVersionInt !== null) {
    if (typeVersionInt > 0) {
      // Requested typeVersion > 0: prioritize REAL versions over tv=0 alias
      
      // 3a) Try best available REAL canonical (type_version > 0)
      let bestRealVersion = null;
      
      // Build query: same node_type, type_version > 0 (REAL versions only)
      let realQuery = supabaseAdmin
        .from('node_library_canonical_schemas')
        .select('config_schema, credential_types, type_version, package_version')
        .eq('node_type', nodeType)
        .gt('type_version', 0);

      // If packageVersion provided and non-empty, filter by it; else ignore package_version
      if (packageVersionStr !== '') {
        realQuery = realQuery.eq('package_version', packageVersionStr);
      }

      // Order by type_version DESC, then package_version DESC
      const { data: realCandidates } = await realQuery
        .order('type_version', { ascending: false })
        .order('package_version', { ascending: false, nullsFirst: false })
        .limit(20);

      if (realCandidates && Array.isArray(realCandidates)) {
        for (const candidate of realCandidates) {
          if (candidate.config_schema && isUsableSchema(candidate.config_schema)) {
            bestRealVersion = candidate;
            break;
          }
        }
      }

      // If no match with packageVersion constraint and packageVersion was provided, try without it
      if (!bestRealVersion && packageVersionStr !== '') {
        const { data: fallbackRealCandidates } = await supabaseAdmin
          .from('node_library_canonical_schemas')
          .select('config_schema, credential_types, type_version, package_version')
          .eq('node_type', nodeType)
          .gt('type_version', 0)
          .order('type_version', { ascending: false })
          .order('package_version', { ascending: false, nullsFirst: false })
          .limit(20);

        if (fallbackRealCandidates && Array.isArray(fallbackRealCandidates)) {
          for (const candidate of fallbackRealCandidates) {
            if (candidate.config_schema && isUsableSchema(candidate.config_schema)) {
              bestRealVersion = candidate;
              break;
            }
          }
        }
      }

      if (bestRealVersion?.config_schema) {
        const schema = bestRealVersion.config_schema as Record<string, unknown>;
        if (debugEnabled) {
          console.log(`[resolveSchema] Found canonical best REAL version for ${nodeType} v${bestRealVersion.type_version} pkg${bestRealVersion.package_version || ''} (requested v${typeVersionInt} pkg${packageVersionStr})`);
        }
        return {
          source: 'canonical',
          node_type: nodeType,
          type_version: bestRealVersion.type_version || null,
          package_version: bestRealVersion.package_version || '',
          config_schema: schema,
          credential_types: bestRealVersion.credential_types || null,
        };
      }

      // 3b) Only if no real version found, try tv=0 alias
      const { data: aliasRow } = await supabaseAdmin
        .from('node_library_canonical_schemas')
        .select('config_schema, credential_types, type_version, package_version')
        .eq('node_type', nodeType)
        .eq('type_version', 0)
        .eq('package_version', packageVersionStr)
        .single();

      if (aliasRow?.config_schema && isUsableSchema(aliasRow.config_schema)) {
        const schema = aliasRow.config_schema as Record<string, unknown>;
        if (debugEnabled) {
          console.log(`[resolveSchema] Found canonical tv=0 alias for ${nodeType} pkg${packageVersionStr} (no real version found)`);
        }
        return {
          source: 'canonical',
          node_type: nodeType,
          type_version: 0,
          package_version: aliasRow.package_version || '',
          config_schema: schema,
          credential_types: aliasRow.credential_types || null,
        };
      }

      // If packageVersion is empty, try alias without package_version constraint
      if (packageVersionStr === '') {
        const { data: aliasCandidates } = await supabaseAdmin
          .from('node_library_canonical_schemas')
          .select('config_schema, credential_types, type_version, package_version')
          .eq('node_type', nodeType)
          .eq('type_version', 0)
          .order('package_version', { ascending: false, nullsFirst: false })
          .limit(10);

        if (aliasCandidates && Array.isArray(aliasCandidates)) {
          for (const candidate of aliasCandidates) {
            if (candidate.config_schema && isUsableSchema(candidate.config_schema)) {
              const schema = candidate.config_schema as Record<string, unknown>;
              if (debugEnabled) {
                console.log(`[resolveSchema] Found canonical tv=0 alias for ${nodeType} pkg${candidate.package_version || ''} (no real version found)`);
              }
              return {
                source: 'canonical',
                node_type: nodeType,
                type_version: 0,
                package_version: candidate.package_version || '',
                config_schema: schema,
                credential_types: candidate.credential_types || null,
              };
            }
          }
        }
      }
    } else {
      // Requested typeVersion == 0: try tv=0 alias first, then fallback to best REAL version
      
      // 3a) Try tv=0 alias first
      const { data: aliasRow } = await supabaseAdmin
        .from('node_library_canonical_schemas')
        .select('config_schema, credential_types, type_version, package_version')
        .eq('node_type', nodeType)
        .eq('type_version', 0)
        .eq('package_version', packageVersionStr)
        .single();

      if (aliasRow?.config_schema && isUsableSchema(aliasRow.config_schema)) {
        const schema = aliasRow.config_schema as Record<string, unknown>;
        if (debugEnabled) {
          console.log(`[resolveSchema] Found canonical tv=0 alias for ${nodeType} pkg${packageVersionStr}`);
        }
        return {
          source: 'canonical',
          node_type: nodeType,
          type_version: 0,
          package_version: aliasRow.package_version || '',
          config_schema: schema,
          credential_types: aliasRow.credential_types || null,
        };
      }

      // If packageVersion is empty, try alias without package_version constraint
      if (packageVersionStr === '') {
        const { data: aliasCandidates } = await supabaseAdmin
          .from('node_library_canonical_schemas')
          .select('config_schema, credential_types, type_version, package_version')
          .eq('node_type', nodeType)
          .eq('type_version', 0)
          .order('package_version', { ascending: false, nullsFirst: false })
          .limit(10);

        if (aliasCandidates && Array.isArray(aliasCandidates)) {
          for (const candidate of aliasCandidates) {
            if (candidate.config_schema && isUsableSchema(candidate.config_schema)) {
              const schema = candidate.config_schema as Record<string, unknown>;
              if (debugEnabled) {
                console.log(`[resolveSchema] Found canonical tv=0 alias for ${nodeType} pkg${candidate.package_version || ''}`);
              }
              return {
                source: 'canonical',
                node_type: nodeType,
                type_version: 0,
                package_version: candidate.package_version || '',
                config_schema: schema,
                credential_types: candidate.credential_types || null,
              };
            }
          }
        }
      }

      // 3b) Fallback to best available REAL version (type_version > 0)
      let bestRealVersion = null;
      
      let realQuery = supabaseAdmin
        .from('node_library_canonical_schemas')
        .select('config_schema, credential_types, type_version, package_version')
        .eq('node_type', nodeType)
        .gt('type_version', 0);

      if (packageVersionStr !== '') {
        realQuery = realQuery.eq('package_version', packageVersionStr);
      }

      const { data: realCandidates } = await realQuery
        .order('type_version', { ascending: false })
        .order('package_version', { ascending: false, nullsFirst: false })
        .limit(20);

      if (realCandidates && Array.isArray(realCandidates)) {
        for (const candidate of realCandidates) {
          if (candidate.config_schema && isUsableSchema(candidate.config_schema)) {
            bestRealVersion = candidate;
            break;
          }
        }
      }

      // If no match with packageVersion constraint and packageVersion was provided, try without it
      if (!bestRealVersion && packageVersionStr !== '') {
        const { data: fallbackRealCandidates } = await supabaseAdmin
          .from('node_library_canonical_schemas')
          .select('config_schema, credential_types, type_version, package_version')
          .eq('node_type', nodeType)
          .gt('type_version', 0)
          .order('type_version', { ascending: false })
          .order('package_version', { ascending: false, nullsFirst: false })
          .limit(20);

        if (fallbackRealCandidates && Array.isArray(fallbackRealCandidates)) {
          for (const candidate of fallbackRealCandidates) {
            if (candidate.config_schema && isUsableSchema(candidate.config_schema)) {
              bestRealVersion = candidate;
              break;
            }
          }
        }
      }

      if (bestRealVersion?.config_schema) {
        const schema = bestRealVersion.config_schema as Record<string, unknown>;
        if (debugEnabled) {
          console.log(`[resolveSchema] Found canonical best REAL version for ${nodeType} v${bestRealVersion.type_version} pkg${bestRealVersion.package_version || ''} (fallback from tv=0)`);
        }
        return {
          source: 'canonical',
          node_type: nodeType,
          type_version: bestRealVersion.type_version || null,
          package_version: bestRealVersion.package_version || '',
          config_schema: schema,
          credential_types: bestRealVersion.credential_types || null,
        };
      }
    }
  }

  // 4) Fallback to legacy node_library_nodes table (only if connectionId provided, not in canonical-only mode)
  if (!canonicalOnly) {
    const { data: legacyNode } = await supabaseAdmin
      .from('node_library_nodes')
      .select('config_schema, credential_types')
      .eq('node_type', nodeType)
      .not('config_schema', 'is', null)
      .single();

    if (legacyNode?.config_schema) {
      if (debugEnabled) {
        console.log(`[resolveSchema] Found legacy schema for ${nodeType} (fallback from node_library_nodes)`);
      }
      return {
        source: 'canonical_legacy',
        node_type: nodeType,
        type_version: typeVersionInt,
        package_version: packageVersionStr,
        config_schema: legacyNode.config_schema as Record<string, unknown>,
        credential_types: legacyNode.credential_types || null,
      };
    }
  }

  // 5) None found
  if (debugEnabled) {
    console.log(`[resolveSchema] No schema found for ${nodeType} (typeVersion: ${typeVersionInt}, packageVersion: ${packageVersionStr})`);
  }
  return {
    source: 'none',
    node_type: nodeType,
    type_version: typeVersionInt,
    package_version: packageVersionStr,
    config_schema: null,
    credential_types: null,
  };
}

/**
 * Sync node type catalog from n8n instance (Hybrid Catalog)
 * Uses canonical catalog as fallback, stores instance-specific data in overrides table
 */
export async function syncNodeTypeCatalog(
  connectionId: string,
  options?: { refresh?: boolean }
): Promise<{ 
  synced: number; 
  errors: number; 
  error: Error | null;
  canonicalFilledCount?: number;
  overrideFilledCount?: number;
  stillNullCount?: number;
  endpoint?: string;
  endpointError?: { status: number; message: string };
}> {
  const refresh = options?.refresh || false;
  const refreshSchema = process.env.NODE_LIBRARY_REFRESH_SCHEMA === '1';
  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'nodeLibrary.ts:562',message:'syncNodeTypeCatalog called',data:{connectionId,refresh,refreshSchema},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion

  try {
    const catalogResult = await getNodeCatalog(connectionId);
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'nodeLibrary.ts:575',message:'getNodeCatalog result',data:{hasError:!!catalogResult.error,errorMessage:catalogResult.error?.message||null,hasData:!!catalogResult.data,nodeCount:catalogResult.data?.nodes?.length||0,endpoint:catalogResult.data?.endpoint},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    // Track stats
    let canonicalFilledCount = 0;
    let overrideFilledCount = 0;
    let stillNullCount = 0;
    
    const endpointError = catalogResult.error ? {
      status: catalogResult.error.status,
      message: catalogResult.error.message,
    } : undefined;
    
    if (catalogResult.error || !catalogResult.data || !catalogResult.data.nodes || catalogResult.data.nodes.length === 0) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'nodeLibrary.ts:578',message:'getNodeCatalog failed, using canonical fallback',data:{error:catalogResult.error?.message||'No data returned',errorStatus:catalogResult.error?.status},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
      // Log detailed error for debugging
      const errorMsg = catalogResult.error?.message || 'Failed to fetch node catalog';
      const errorStatus = catalogResult.error?.status;
      if (debugEnabled) {
        console.warn(`[node-library] Cannot fetch node catalog from n8n instance: ${errorMsg} (status: ${errorStatus})`);
        console.warn(`[node-library] Will use canonical catalog for nodes with NULL config_schema`);
      }
      
      // Fill from canonical for nodes that need it
      const { data: nullSchemaNodes } = await supabaseAdmin
        .from('node_library_nodes')
        .select('node_type')
        .is('config_schema', null);
      
      if (nullSchemaNodes && nullSchemaNodes.length > 0) {
        for (const row of nullSchemaNodes) {
          const canonical = getCanonicalEntry(row.node_type);
          if (canonical?.config_schema) {
            const schemaHash = computeSchemaHash(canonical.config_schema);
            const { error: fillError } = await supabaseAdmin
              .from('node_library_nodes')
              .update({
                config_schema: canonical.config_schema,
                credential_types: canonical.credential_types || null,
                source: 'canonical',
                package_name: canonical.package_name || null,
                package_version: canonical.package_version || null,
                schema_hash: schemaHash,
                fetched_at: new Date().toISOString(),
              })
              .eq('node_type', row.node_type);
            
            if (!fillError) {
              canonicalFilledCount++;
            }
          }
        }
      }
      
      return { 
        synced: canonicalFilledCount, 
        errors: 0, 
        error: null,
        canonicalFilledCount,
        overrideFilledCount: 0,
        stillNullCount: (nullSchemaNodes?.length || 0) - canonicalFilledCount,
        endpoint: undefined,
        endpointError,
      };
    }

    const nodes = catalogResult.data.nodes as any[];
    const credentialTypesMap = new Map<string, any>();
    
    // Build credential types map if available
    if (catalogResult.data.credentialTypes && Array.isArray(catalogResult.data.credentialTypes)) {
      for (const cred of catalogResult.data.credentialTypes as any[]) {
        const credName = cred.name || cred.type;
        if (credName) {
          credentialTypesMap.set(credName, cred);
        }
      }
    }
    let synced = 0;
    let errors = 0;

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'nodeLibrary.ts:576',message:'Catalog fetched',data:{nodeCount:nodes.length,sampleNode:nodes[0] ? {name:nodes[0].name,type:nodes[0].type,hasProperties:!!nodes[0].properties,propertiesCount:Array.isArray(nodes[0].properties)?nodes[0].properties.length:0,hasCredentials:!!nodes[0].credentials} : null},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion

    // Get existing nodes to check for curated fields
    const nodeTypes = nodes.map((n) => n.name || n.type).filter(Boolean);
    if (nodeTypes.length === 0) {
      return { synced: 0, errors: 0, error: null };
    }

    const { data: existingNodes } = await supabaseAdmin
      .from('node_library_nodes')
      .select('node_type, display_name, description, docs_url, credential_types, config_schema')
      .in('node_type', nodeTypes);

    const existingMap = new Map<string, any>();
    if (existingNodes) {
      for (const existing of existingNodes) {
        existingMap.set(existing.node_type, existing);
      }
    }

    for (const node of nodes) {
      try {
        const nodeType = node.name || node.type;
        if (!nodeType) {
          errors++;
          continue;
        }

        const existing = existingMap.get(nodeType);
        const displayName = node.displayName || humanizeNodeTypeName(nodeType);
        const category = node.category || inferNodeCategory(nodeType);
        const description = node.description || '';
        const docsUrl = node.documentationUrl || node.docsUrl || null;

        // Extract credential types and structure
        let credentialTypes: string[] | null = null;
        let credentialsStructure: { required?: string[]; list?: Array<{ name: string; displayName?: string }> } | undefined = undefined;

        if (node.credentials) {
          if (Array.isArray(node.credentials)) {
            credentialTypes = node.credentials.map((c: any) => c.name || c.type).filter(Boolean);
            credentialsStructure = {
              list: node.credentials.map((c: any) => ({
                name: c.name || c.type,
                displayName: c.displayName || c.name || c.displayName,
              })),
            };
            // Extract required credentials if present
            if (node.requiredCredentials && Array.isArray(node.requiredCredentials)) {
              credentialsStructure.required = node.requiredCredentials.map((c: any) => c.name || c.type || c).filter(Boolean);
            }
          } else if (typeof node.credentials === 'object') {
            // Handle credentials as object with required/list structure
            const credObj = node.credentials as any;
            if (credObj.required && Array.isArray(credObj.required)) {
              credentialsStructure = { required: credObj.required };
              credentialTypes = credObj.required;
            }
            if (credObj.list && Array.isArray(credObj.list)) {
              if (!credentialsStructure) credentialsStructure = {};
              credentialsStructure.list = credObj.list.map((c: any) => ({
                name: c.name || c.type,
                displayName: c.displayName || c.name,
              }));
              if (!credentialTypes) {
                credentialTypes = credObj.list.map((c: any) => c.name || c.type).filter(Boolean);
              }
            }
          }
        }

        // Extract properties array (full schema)
        const properties = node.properties && Array.isArray(node.properties) ? node.properties : null;
        const hasRealSchema = properties && properties.length > 0;
        const hasCredentials = credentialTypes && credentialTypes.length > 0;

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'nodeLibrary.ts:651',message:'Building config_schema',data:{nodeType,hasProperties:!!properties,propertiesCount:properties?.length||0,hasCredentials:!!hasCredentials,credentialTypesCount:credentialTypes?.length||0,nodeKeys:Object.keys(node).slice(0,15)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion

        // Build REAL config_schema (not stub if properties exist or credentials exist)
        const configSchema: Record<string, unknown> = {
          source: 'n8n_catalog',
          node_type: nodeType,
          displayName: displayName,
          fetched_at: new Date().toISOString(),
        };

        // Add typeVersion(s) if present
        if (node.version !== undefined) {
          configSchema.typeVersion = node.version;
        }
        if (node.typeVersions && Array.isArray(node.typeVersions)) {
          configSchema.typeVersions = node.typeVersions;
        }

        // Add credentials structure
        if (credentialsStructure) {
          configSchema.credentials = credentialsStructure;
        }

        // Add full properties array if available
        if (properties) {
          configSchema.properties = properties;
        }

        // Add codex/categories if present
        if (node.codex) {
          configSchema.codex = node.codex;
        }
        if (node.categories && Array.isArray(node.categories)) {
          configSchema.categories = node.categories;
        }

        // Add docs_url to schema
        if (docsUrl) {
          configSchema.docs_url = docsUrl;
        }

        // Only mark as stub if no properties AND no credentials
        const isStub = !hasRealSchema && !hasCredentials;

        // Idempotent upsert: preserve curated fields unless refresh=true or NODE_LIBRARY_REFRESH=1
        const refreshEnv = process.env.NODE_LIBRARY_REFRESH === '1';
        const forceRefresh = process.env.NODE_LIBRARY_FORCE_REFRESH === '1';
        
        // Check existing schema state
        const existingSource = existing?.config_schema ? (existing.config_schema as any)?.source : null;
        const existingHasProperties = Array.isArray((existing?.config_schema as any)?.properties) && (existing.config_schema as any).properties.length > 0;
        const existingHasCredentials = !!(existing?.config_schema as any)?.credentials;
        const existingIsStub = !existing?.config_schema || 
          existing.config_schema === null ||
          existingSource === 'stub' ||
          existingSource === 'error' ||
          (!existingHasProperties && !existingHasCredentials);
        
        // Only refresh schema if we have real data (not stub) AND (force refresh OR existing is stub/NULL)
        const shouldRefreshSchema = !isStub && (forceRefresh || refreshSchema || refresh || !existing?.config_schema || existingIsStub);

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'nodeLibrary.ts:710',message:'Upsert decision',data:{nodeType,existingSource,existingIsStub,shouldRefreshSchema,hasRealSchema,isStub,forceRefresh,refreshSchema,refresh},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion

        // If we have real schema data, store in overrides table (instance-specific)
        if (!isStub && shouldRefreshSchema) {
          const schemaHash = computeSchemaHash(configSchema);
          const overrideData = {
            connection_id: connectionId,
            node_type: nodeType,
            config_schema: configSchema,
            credential_types: credentialTypes,
            source: 'n8n_instance',
            fetched_at: new Date().toISOString(),
          };
          
          const { error: overrideError } = await supabaseAdmin
            .from('node_library_node_overrides')
            .upsert(overrideData, { onConflict: 'connection_id,node_type' });
          
          if (!overrideError) {
            overrideFilledCount++;
          } else if (debugEnabled) {
            console.error(`[node-library] Failed to upsert override for ${nodeType}:`, overrideError);
          }
        }
        
        // Update node_library_nodes: fill from canonical if NULL, or use override if available
        const hybridDef = await getHybridNodeDefinition(connectionId, nodeType);
        const schemaHash = hybridDef.config_schema ? computeSchemaHash(hybridDef.config_schema) : null;
        
        const updateData: any = {
          node_type: nodeType,
          // Fill NULL fields unless force refresh (preserve curated values)
          display_name: forceRefresh || refresh || !existing?.display_name ? displayName : existing.display_name,
          category: forceRefresh || refresh || !existing?.category ? category : existing.category,
          description: forceRefresh || refresh || !existing?.description ? description : existing.description,
          docs_url: forceRefresh || refresh || !existing?.docs_url ? docsUrl : existing.docs_url,
          credential_types: forceRefresh || refresh || !existing?.credential_types ? (hybridDef.credential_types || credentialTypes) : existing.credential_types,
          // Use hybrid definition (override > canonical > NULL)
          config_schema: hybridDef.config_schema || (existing?.config_schema || null),
          source: hybridDef.config_schema ? hybridDef.source : (existing?.source || null),
          package_name: hybridDef.package_name || existing?.package_name || null,
          package_version: hybridDef.package_version || existing?.package_version || null,
          schema_hash: schemaHash || existing?.schema_hash || null,
          fetched_at: hybridDef.config_schema ? new Date().toISOString() : (existing?.fetched_at || null),
          search_text: `${displayName} ${nodeType} ${category} ${description}`.trim(),
        };
        
        // DO NOT write stub config_schema - leave NULL if no real data
        if (!hybridDef.config_schema && !existing?.config_schema) {
          updateData.config_schema = null;
          stillNullCount++;
          if (debugEnabled) {
            console.log(`[node-library] Leaving config_schema NULL for ${nodeType} (no override, no canonical)`);
          }
        } else if (!existing?.config_schema && hybridDef.source === 'canonical') {
          canonicalFilledCount++;
        }

        // If config_schema is still NULL after catalog sync, try MCP docs fallback
        if (!updateData.config_schema && process.env.N8N_DOCS_MCP_URL) {
          const hydrated = await hydrateNodeSchemaFromDocs(nodeType);
          if (hydrated) {
            updateData.config_schema = hydrated.config_schema;
            updateData.source = 'mcp_docs';
            updateData.schema_hash = computeSchemaHash(hydrated.config_schema);
            updateData.fetched_at = new Date().toISOString();
            if (hydrated.docs_url && !updateData.docs_url) {
              updateData.docs_url = hydrated.docs_url;
            }
            if (hydrated.credential_types && !updateData.credential_types) {
              updateData.credential_types = hydrated.credential_types;
            }
          }
        }

        const { error: upsertError } = await supabaseAdmin
          .from('node_library_nodes')
          .upsert(updateData, { onConflict: 'node_type' });

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'nodeLibrary.ts:740',message:'Upsert result',data:{nodeType,upsertError:upsertError?.message||null,configSchemaSource:updateData.config_schema?.source||null,hasProperties:!!(updateData.config_schema as any)?.properties,propertiesCount:Array.isArray((updateData.config_schema as any)?.properties)?(updateData.config_schema as any).properties.length:0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion

        if (upsertError) {
          if (debugEnabled) {
            console.error(`[nodeLibrary] Failed to sync node ${nodeType}:`, upsertError);
          }
          errors++;
        } else {
          synced++;
        }
      } catch (e) {
        if (debugEnabled) {
          console.error(`[nodeLibrary] Error processing node:`, e);
        }
        errors++;
      }
    }

    if (debugEnabled) {
      console.log(`[nodeLibrary] Sync catalog complete: synced=${synced}, errors=${errors}, canonicalFilled=${canonicalFilledCount}, overrideFilled=${overrideFilledCount}, stillNull=${stillNullCount}`);
    }

    return { 
      synced, 
      errors, 
      error: null,
      canonicalFilledCount,
      overrideFilledCount,
      stillNullCount,
      endpoint: catalogResult.data?.endpoint,
      endpointError,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[nodeLibrary] syncNodeTypeCatalog failed:', msg);
    return { synced: 0, errors: 0, error: new Error(msg) };
  }
}

/**
 * Repair existing stub/NULL config_schema rows by fetching real schemas from n8n
 */
export async function repairNodeLibrarySchemas(
  connectionId: string
): Promise<{ repaired: number; errors: number; error: Error | null }> {
  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

  try {
    // Find rows with NULL or stub config_schema
    const { data: stubRows, error: queryError } = await supabaseAdmin
      .from('node_library_nodes')
      .select('node_type, config_schema')
      .or('config_schema.is.null,config_schema->>source.eq.stub');

    if (queryError) {
      return { repaired: 0, errors: 0, error: new Error(`Failed to query stub rows: ${queryError.message}`) };
    }

    if (!stubRows || stubRows.length === 0) {
      if (debugEnabled) {
        console.log('[nodeLibrary] No stub rows found to repair');
      }
      return { repaired: 0, errors: 0, error: null };
    }

    if (debugEnabled) {
      console.log(`[nodeLibrary] Found ${stubRows.length} stub/NULL rows to repair`);
    }

    // Call syncNodeTypeCatalog to fetch real schemas
    const syncResult = await syncNodeTypeCatalog(connectionId, { refresh: false });

    if (syncResult.error) {
      return { repaired: 0, errors: stubRows.length, error: syncResult.error };
    }

    // Verify repaired rows
    const { data: repairedRows, error: verifyError } = await supabaseAdmin
      .from('node_library_nodes')
      .select('node_type, config_schema')
      .in('node_type', stubRows.map(r => r.node_type));

    if (verifyError) {
      return { repaired: 0, errors: stubRows.length, error: new Error(`Failed to verify repairs: ${verifyError.message}`) };
    }

    let repaired = 0;
    let errors = 0;

    if (repairedRows) {
      for (const row of repairedRows) {
        const schema = row.config_schema as any;
        const hasRealSchema = schema && 
          (schema.source === 'n8n_node_catalog' || schema.source === 'n8n_instance') && 
          (Array.isArray(schema.properties) && schema.properties.length > 0 || schema.credentials);

        if (hasRealSchema) {
          repaired++;
        } else {
          errors++;
          if (debugEnabled) {
            console.warn(`[nodeLibrary] Row ${row.node_type} still has stub/NULL schema after repair`);
          }
        }
      }
    }

    if (debugEnabled) {
      console.log(`[nodeLibrary] Repair complete: repaired=${repaired}, errors=${errors}`);
    }

    return { repaired, errors, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[nodeLibrary] repairNodeLibrarySchemas failed:', msg);
    return { repaired: 0, errors: 0, error: new Error(msg) };
  }
}

// ============================================================================
// Parameter Summarization
// ============================================================================

/**
 * Summarize node parameters for storage in workflow_nodes.params_summary
 */
export function summarizeNodeParams(
  nodeType: string,
  nodeParameters: Record<string, unknown>,
  nodeTypeSchema?: Record<string, unknown>
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    keyFields: {} as Record<string, unknown>,
    uses_expressions: false,
    credential_missing: false,
  };

  // Redact secrets
  const secretKeyRe = /token|apiKey|password|secret|authorization|api_key|access_token|refresh_token/i;

  // Extract key fields based on node type patterns
  const lowerType = nodeType.toLowerCase();

  // Common key fields to extract (expanded list)
  const keyFieldPatterns: Record<string, string[]> = {
    httprequest: ['url', 'method', 'authentication', 'headers', 'body'],
    googlesheets: ['operation', 'sheetId', 'documentId', 'sheetName', 'range', 'spreadsheetId'],
    googledrive: ['operation', 'fileId', 'folderId', 'fileName'],
    googleslides: ['operation', 'presentationId', 'slideId'],
    postgres: ['operation', 'table', 'query', 'schema'],
    mysql: ['operation', 'table', 'query', 'schema'],
    mongodb: ['operation', 'collection', 'database'],
    calendar: ['calendarId', 'operation', 'start', 'end'],
    slack: ['chatId', 'channel', 'operation', 'text'],
    chat: ['chatId', 'channel', 'operation'],
    telegram: ['chatId', 'operation', 'text'],
    discord: ['channelId', 'operation', 'message'],
    airtable: ['operation', 'baseId', 'tableId', 'table'],
    notion: ['operation', 'databaseId', 'pageId'],
  };

  // Universal key fields (always extract if present)
  const universalKeyFields = [
    'url', 'method', 'operation', 'resource', 'table', 'list', 'collection',
    'chatId', 'channelId', 'calendarId', 'spreadsheetId', 'sheetId', 'documentId',
    'fileId', 'folderId', 'presentationId', 'slideId', 'baseId', 'tableId', 'pageId',
    'sheetName', 'range', 'query', 'schema', 'database',
  ];

  let patterns: string[] = [];
  for (const [pattern, fields] of Object.entries(keyFieldPatterns)) {
    if (lowerType.includes(pattern)) {
      patterns = fields;
      break;
    }
  }
  
  // Merge with universal fields
  patterns = [...new Set([...patterns, ...universalKeyFields])];

  // Extract resource and operation
  if (nodeParameters.resource) {
    summary.resource = String(nodeParameters.resource);
  }
  if (nodeParameters.operation) {
    summary.operation = String(nodeParameters.operation);
  }

  // Extract key fields (redacted and sanitized)
  for (const [key, value] of Object.entries(nodeParameters)) {
    if (secretKeyRe.test(key)) {
      continue; // Skip secrets
    }

    // Check if this is a key field (pattern match or universal field)
    const isKeyField = patterns.some(p => 
      key.toLowerCase() === p.toLowerCase() || 
      key.toLowerCase().includes(p.toLowerCase())
    );

    if (isKeyField || key.toLowerCase().includes('id') || key.toLowerCase().includes('url') || key.toLowerCase().includes('method')) {
      const strValue = String(value);
      // Check for expressions
      if (strValue.includes('{{') || strValue.includes('$json')) {
        summary.uses_expressions = true;
      }
      // Store value (but truncate very long strings)
      let safeValue = value;
      if (typeof value === 'string' && value.length > 200) {
        safeValue = value.substring(0, 200) + '...';
      }
      (summary.keyFields as Record<string, unknown>)[key] = safeValue;
    }
  }

  // Check for expressions in all values
  for (const value of Object.values(nodeParameters)) {
    const strValue = String(value);
    if (strValue.includes('{{') || strValue.includes('$json')) {
      summary.uses_expressions = true;
      break;
    }
  }

  // Check credential_missing (requires credentials but none configured)
  if (nodeTypeSchema?.credentials && Array.isArray(nodeTypeSchema.credentials) && nodeTypeSchema.credentials.length > 0) {
    // Node requires credentials
    if (!nodeParameters.credentials || Object.keys(nodeParameters.credentials as Record<string, unknown> || {}).length === 0) {
      summary.credential_missing = true;
    }
  }

  return summary;
}

// ============================================================================
// Generic Error Patterns
// ============================================================================

/**
 * Ensure generic error patterns exist in the database
 */
export async function ensureGenericErrorPatterns(): Promise<{ error: Error | null }> {
  try {
    // Check if pattern already exists
    const { data: existing } = await supabaseAdmin
      .from('node_library_error_patterns')
      .select('id')
      .eq('title', 'Missing credentials')
      .is('node_type', null)
      .single();

    if (existing) {
      return { error: null }; // Already exists
    }

    // Insert global "Missing credentials" pattern
    const { error } = await supabaseAdmin.from('node_library_error_patterns').insert({
      node_type: null, // Global pattern
      title: 'Missing credentials',
      matchers: {
        contains: [
          'does not have any credentials',
          'credentials set',
          'Select Credential',
          'no credentials configured',
          'credential is required',
        ],
      },
      explanation: 'This node requires credentials but none are configured.',
      fix_steps:
        "1. Click the node\n2. Click 'Credential' dropdown\n3. Select existing credential or create new one\n4. Re-run the workflow",
      severity: 'error',
      tags: ['credentials', 'configuration'],
    });

    if (error) {
      console.error('[nodeLibrary] ensureGenericErrorPatterns failed:', error);
      return { error: new Error(error.message) };
    }

    return { error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[nodeLibrary] ensureGenericErrorPatterns failed:', msg);
    return { error: new Error(msg) };
  }
}

// ============================================================================
// Optional MCP Docs Integration
// ============================================================================

/**
 * Search n8n documentation via MCP server (optional)
 */
export async function n8nDocsSearch(
  query: string,
  nodeType?: string,
  operation?: string,
  errorText?: string
): Promise<{ results: unknown[]; extractedInfo?: { displayName?: string; credentialTypes?: string[]; resources?: string[]; operations?: string[] }; error: Error | null }> {
  const mcpUrl = process.env.N8N_DOCS_MCP_URL;
  if (!mcpUrl) {
    return { results: [], error: null }; // Not configured, return empty
  }

  try {
    const payload: Record<string, unknown> = {
      query,
    };

    if (nodeType) payload.node_type = nodeType;
    if (operation) payload.operation = operation;
    if (errorText) payload.error_text = errorText;

    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { results: [], error: new Error(`MCP server returned ${response.status}`) };
    }

    const data = (await response.json()) as { results?: unknown[]; data?: unknown[] };
    const results = Array.isArray(data.results) ? data.results : (Array.isArray(data.data) ? data.data : []);

    return { results, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[nodeLibrary] n8nDocsSearch failed:', msg);
    return { results: [], error: new Error(msg) };
  }
}

/**
 * Hydrate node schema from MCP docs (fallback when catalog doesn't provide schema)
 */
export async function hydrateNodeSchemaFromDocs(
  nodeType: string
): Promise<{ config_schema: Record<string, unknown>; docs_url?: string; credential_types?: string[] } | null> {
  const mcpUrl = process.env.N8N_DOCS_MCP_URL;
  if (!mcpUrl) {
    return null; // Not configured
  }

  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

  try {
    const docsResult = await n8nDocsSearch(nodeType, nodeType);
    if (docsResult.error || !docsResult.extractedInfo) {
      if (debugEnabled) {
        console.log(`[nodeLibrary] MCP docs fallback for ${nodeType}: no extracted info`);
      }
      return null;
    }

    const info = docsResult.extractedInfo;
    const minimalSchema: Record<string, unknown> = {
      source: 'mcp_docs',
      node_type: nodeType,
      display_name: info.displayName || humanizeNodeTypeName(nodeType),
      docs_url: null, // Could be extracted from results if available
      credential_types: info.credentialTypes || null,
      fetched_at: new Date().toISOString(),
    };

    if (info.resources && info.resources.length > 0) {
      minimalSchema.resources = info.resources;
    }
    if (info.operations && info.operations.length > 0) {
      minimalSchema.operations = info.operations;
    }

    if (debugEnabled) {
      console.log(`[nodeLibrary] MCP docs hydrated schema for ${nodeType}`);
    }

    return {
      config_schema: minimalSchema,
      credential_types: info.credentialTypes || undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (debugEnabled) {
      console.error(`[nodeLibrary] hydrateNodeSchemaFromDocs failed for ${nodeType}:`, msg);
    }
    return null;
  }
}

// ============================================================================
// Backfill Helpers
// ============================================================================

/**
 * Backfill node_library_nodes.config_schema for rows where it's NULL
 */
export async function backfillNodeLibrarySchemas(
  connectionId?: string
): Promise<{ filled: number; errors: number; error: Error | null }> {
  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

  try {
    // Query nodes with NULL config_schema
    let query = supabaseAdmin.from('node_library_nodes').select('node_type').is('config_schema', null);

    const { data: nodesWithNullSchema, error: queryError } = await query;

    if (queryError) {
      console.error('[nodeLibrary] backfillNodeLibrarySchemas query failed:', queryError);
      return { filled: 0, errors: 0, error: new Error(queryError.message) };
    }

    if (!nodesWithNullSchema || nodesWithNullSchema.length === 0) {
      if (debugEnabled) {
        console.log('[nodeLibrary] No nodes with NULL config_schema to backfill');
      }
      return { filled: 0, errors: 0, error: null };
    }

    let filled = 0;
    let errors = 0;

    // Try to sync catalog first (if connectionId provided)
    if (connectionId) {
      const syncResult = await syncNodeTypeCatalog(connectionId, { refresh: false });
      if (syncResult.error) {
        if (debugEnabled) {
          console.warn('[nodeLibrary] Catalog sync failed during backfill:', syncResult.error.message);
        }
      }
    }

    // For remaining NULL schemas, try MCP docs fallback
    const nodeTypes = nodesWithNullSchema.map((n: any) => n.node_type).filter(Boolean);
    for (const nodeType of nodeTypes) {
      try {
        // Check if schema was filled by catalog sync
        const { data: current } = await supabaseAdmin
          .from('node_library_nodes')
          .select('config_schema')
          .eq('node_type', nodeType)
          .single();

        if (current?.config_schema) {
          filled++;
          continue; // Already filled
        }

        // Try MCP docs fallback
        const hydrated = await hydrateNodeSchemaFromDocs(nodeType);
        if (hydrated) {
          const { error: updateError } = await supabaseAdmin
            .from('node_library_nodes')
            .update({
              config_schema: hydrated.config_schema,
              ...(hydrated.docs_url ? { docs_url: hydrated.docs_url } : {}),
              ...(hydrated.credential_types ? { credential_types: hydrated.credential_types } : {}),
            })
            .eq('node_type', nodeType)
            .is('config_schema', null); // Only update if still NULL

          if (updateError) {
            if (debugEnabled) {
              console.error(`[nodeLibrary] Failed to backfill schema for ${nodeType}:`, updateError);
            }
            errors++;
          } else {
            filled++;
          }
        } else {
          // Create minimal stub schema
          const minimalSchema = {
            source: 'stub' as const,
            node_type: nodeType,
            display_name: humanizeNodeTypeName(nodeType),
            docs_url: null,
            credential_types: null,
            fetched_at: new Date().toISOString(),
          };

          const { error: updateError } = await supabaseAdmin
            .from('node_library_nodes')
            .update({ config_schema: minimalSchema })
            .eq('node_type', nodeType)
            .is('config_schema', null);

          if (updateError) {
            errors++;
          } else {
            filled++;
          }
        }
      } catch (e) {
        if (debugEnabled) {
          console.error(`[nodeLibrary] Error backfilling schema for ${nodeType}:`, e);
        }
        errors++;
      }
    }

    if (debugEnabled) {
      console.log(`[nodeLibrary] Backfill schemas complete: filled=${filled}, errors=${errors}`);
    }

    return { filled, errors, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[nodeLibrary] backfillNodeLibrarySchemas failed:', msg);
    return { filled: 0, errors: 0, error: new Error(msg) };
  }
}

/**
 * Backfill workflow_nodes.params_summary for rows where it's NULL
 */
export async function backfillWorkflowNodeSummaries(
  connectionId: string
): Promise<{ filled: number; errors: number; error: Error | null }> {
  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

  try {
    // Query workflow_nodes with NULL params_summary
    const { data: nodesWithNullSummary, error: queryError } = await supabaseAdmin
      .from('workflow_nodes')
      .select('connection_id, workflow_id, node_id, node_type')
      .eq('connection_id', connectionId)
      .is('params_summary', null);

    if (queryError) {
      console.error('[nodeLibrary] backfillWorkflowNodeSummaries query failed:', queryError);
      return { filled: 0, errors: 0, error: new Error(queryError.message) };
    }

    if (!nodesWithNullSummary || nodesWithNullSummary.length === 0) {
      if (debugEnabled) {
        console.log('[nodeLibrary] No workflow nodes with NULL params_summary to backfill');
      }
      return { filled: 0, errors: 0, error: null };
    }

    let filled = 0;
    let errors = 0;

    // Group by workflow_id to batch fetch workflows
    const workflowMap = new Map<string, typeof nodesWithNullSummary>();
    for (const node of nodesWithNullSummary) {
      const wfId = node.workflow_id;
      if (!workflowMap.has(wfId)) {
        workflowMap.set(wfId, []);
      }
      workflowMap.get(wfId)!.push(node);
    }

    // Import getWorkflow
    const { getWorkflow } = await import('../v3/n8nClient');

    for (const [workflowId, nodes] of workflowMap.entries()) {
      try {
        // Fetch workflow JSON
        const wfResult = await getWorkflow(connectionId, workflowId);
        if (wfResult.error || !wfResult.data) {
          if (debugEnabled) {
            console.warn(`[nodeLibrary] Failed to fetch workflow ${workflowId} for backfill`);
          }
          errors += nodes.length;
          continue;
        }

        const workflow = wfResult.data;
        const nodeMap = new Map((workflow.nodes || []).map((n) => [n.id || n.name, n]));

        // Fetch node schemas for better summarization
        const nodeTypes = [...new Set(nodes.map((n) => n.node_type).filter(Boolean))];
        const schemaMap = new Map<string, Record<string, unknown>>();
        for (const nodeType of nodeTypes) {
          const defResult = await getNodeDefinition(nodeType);
          if (defResult.data?.config_schema) {
            schemaMap.set(nodeType, defResult.data.config_schema as Record<string, unknown>);
          }
        }

        // Compute params_summary for each node
        for (const node of nodes) {
          try {
            const workflowNode = nodeMap.get(node.node_id);
            if (!workflowNode) {
              if (debugEnabled) {
                console.warn(`[nodeLibrary] Node ${node.node_id} not found in workflow ${workflowId}`);
              }
              errors++;
              continue;
            }

            const nodeSchema = schemaMap.get(node.node_type);
            const paramsSummary = summarizeNodeParams(
              node.node_type,
              workflowNode.parameters || {},
              nodeSchema
            );

            const { error: updateError } = await supabaseAdmin
              .from('workflow_nodes')
              .update({ params_summary: paramsSummary })
              .eq('connection_id', connectionId)
              .eq('workflow_id', workflowId)
              .eq('node_id', node.node_id)
              .is('params_summary', null); // Only update if still NULL

            if (updateError) {
              if (debugEnabled) {
                console.error(`[nodeLibrary] Failed to backfill summary for ${node.node_id}:`, updateError);
              }
              errors++;
            } else {
              filled++;
            }
          } catch (e) {
            if (debugEnabled) {
              console.error(`[nodeLibrary] Error backfilling summary for node ${node.node_id}:`, e);
            }
            errors++;
          }
        }
      } catch (e) {
        if (debugEnabled) {
          console.error(`[nodeLibrary] Error processing workflow ${workflowId}:`, e);
        }
        errors += nodes.length;
      }
    }

    if (debugEnabled) {
      console.log(`[nodeLibrary] Backfill summaries complete: filled=${filled}, errors=${errors}`);
    }

    return { filled, errors, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[nodeLibrary] backfillWorkflowNodeSummaries failed:', msg);
    return { filled: 0, errors: 0, error: new Error(msg) };
  }
}
