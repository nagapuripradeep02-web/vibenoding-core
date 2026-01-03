/**
 * Canonical Node Catalog Loader
 * Loads canonical node type definitions from JSON file
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CanonicalNodeEntry {
  node_type: string;
  display_name: string;
  credential_types: string[];
  config_schema: {
    source: 'canonical';
    properties: Array<Record<string, unknown>>;
    credentials?: {
      required?: string[];
      list?: Array<{ name: string; displayName?: string }>;
    };
  };
  package_name?: string;
  package_version?: string;
  typeVersion?: number;
  docs_url?: string | null;
  category?: string;
}

export interface CanonicalCatalog {
  version: string;
  nodes: CanonicalNodeEntry[];
}

let cachedCatalog: CanonicalCatalog | null = null;

/**
 * Load canonical catalog from JSON file
 */
export function loadCanonicalCatalog(): CanonicalCatalog {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  // Use environment variable or default to catalog/canonical.json relative to project root
  const catalogPath = process.env.NODE_LIBRARY_CANONICAL_PATH || 
    path.join(process.cwd(), 'src', 'catalog', 'canonical.json');
  
  try {
    const catalogContent = fs.readFileSync(catalogPath, 'utf-8');
    const parsed = JSON.parse(catalogContent) as any;
    
    // Handle both old format (object map) and new format (array)
    if (parsed.nodes) {
      if (Array.isArray(parsed.nodes)) {
        // New format: array
        cachedCatalog = {
          version: parsed.version || '1.0.0',
          nodes: parsed.nodes,
        };
      } else {
        // Old format: object map - convert to array
        cachedCatalog = {
          version: parsed.version || '1.0.0',
          nodes: Object.values(parsed.nodes),
        };
      }
    } else {
      cachedCatalog = { version: '1.0.0', nodes: [] };
    }
    
    return cachedCatalog;
  } catch (err) {
    console.warn(`[catalog] Failed to load canonical catalog from ${catalogPath}:`, err instanceof Error ? err.message : String(err));
    return { version: '1.0.0', nodes: [] };
  }
}

/**
 * Get canonical entry for a node type
 * Returns the first matching entry (prefers typeVersion=0 if available)
 */
export function getCanonicalEntry(nodeType: string): CanonicalNodeEntry | null {
  const catalog = loadCanonicalCatalog();
  
  if (!Array.isArray(catalog.nodes)) {
    // Fallback for old format
    return (catalog.nodes as any)[nodeType] || null;
  }
  
  // Search array for matching node_type
  // Prefer typeVersion=0 (compatibility alias), then highest version
  const matches = catalog.nodes.filter(entry => entry.node_type === nodeType);
  
  if (matches.length === 0) {
    return null;
  }
  
  // Prefer typeVersion=0, otherwise return first match
  const alias = matches.find(e => e.typeVersion === 0);
  return alias || matches[0] || null;
}

/**
 * Clear cache (useful for testing or reloading)
 */
export function clearCanonicalCache(): void {
  cachedCatalog = null;
}

