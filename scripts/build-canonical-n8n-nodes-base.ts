/**
 * Build canonical.json from n8n-nodes-base package
 * Extracts real node descriptions and generates canonical catalog
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { CanonicalCatalog, CanonicalNodeEntry } from '../src/catalog/loader';

const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

/**
 * Compute hash of config_schema for change detection
 */
function computeSchemaHash(schema: Record<string, unknown>): string {
  try {
    const normalized = JSON.stringify(schema, Object.keys(schema).sort());
    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  } catch {
    return '';
  }
}

/**
 * Recursively find all .node.js files in a directory
 */
function findNodeFiles(dir: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return fileList;
  }

  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      findNodeFiles(filePath, fileList);
    } else if (file.endsWith('.node.js')) {
      fileList.push(filePath);
    }
  }

  return fileList;
}

/**
 * Safely instantiate a class
 */
function safeInstantiate(Cls: any): any | null {
  try {
    return new Cls();
  } catch {
    return null;
  }
}

/**
 * Extract descriptions from module exports
 * Returns array of { NodeClass, instance, description } candidates
 */
function extractDescriptionsFromModule(moduleExports: any): Array<{ NodeClass: any; instance: any; description: any }> {
  const candidates: Array<{ NodeClass: any; instance: any; description: any }> = [];
  
  if (!moduleExports || typeof moduleExports !== 'object') {
    return candidates;
  }

  // Consider mod.default and all Object.values(mod)
  const exportsToCheck: any[] = [];
  
  if (moduleExports.default) {
    exportsToCheck.push(moduleExports.default);
  }
  
  // Add all values from module
  for (const value of Object.values(moduleExports)) {
    if (value && value !== moduleExports.default) {
      exportsToCheck.push(value);
    }
  }

  for (const exportValue of exportsToCheck) {
    // Skip if not a function/class
    if (typeof exportValue !== 'function' || !exportValue.prototype) {
      continue;
    }

    // Try to instantiate
    const instance = safeInstantiate(exportValue);
    
    // Get description: prefer instance.description, fallback to export.description
    const description = instance?.description ?? exportValue.description;
    
    // Keep only those with desc?.name as string
    if (description && typeof description.name === 'string') {
      candidates.push({
        NodeClass: exportValue,
        instance: instance,
        description: description,
      });
    }
  }

  // Prefer the candidate with the largest desc.properties.length if multiple candidates exist
  if (candidates.length > 1) {
    candidates.sort((a, b) => {
      const aProps = Array.isArray(a.description?.properties) ? a.description.properties.length : 0;
      const bProps = Array.isArray(b.description?.properties) ? b.description.properties.length : 0;
      return bProps - aProps; // Sort descending
    });
  }

  return candidates;
}

/**
 * Extract credential types from description
 */
function extractCredentialTypes(description: any): string[] {
  if (!description || !description.credentials) {
    return [];
  }
  
  if (Array.isArray(description.credentials)) {
    return description.credentials
      .map((c: any) => c?.name)
      .filter((name: any): name is string => typeof name === 'string');
  }
  
  return [];
}

/**
 * Get version-specific node instance for versioned nodes
 * Handles both class returns (need instantiation) and instance returns (use directly)
 */
function getVersionNodeInstance(baseInstance: any, version: number): any | null {
  try {
    // Prefer: getNodeTypeVersion(version) method
    if (typeof baseInstance.getNodeTypeVersion === 'function') {
      const versionResult = baseInstance.getNodeTypeVersion(version);
      
      // If it's already an object with description, use directly
      if (versionResult && typeof versionResult === 'object' && versionResult.description) {
        return versionResult;
      }
      
      // If it's a class, instantiate it
      if (versionResult && typeof versionResult === 'function') {
        const instance = safeInstantiate(versionResult);
        if (instance && instance.description) {
          return instance;
        }
      }
    }

    // Fallback: nodeVersions or nodeTypeVersions property
    const versionsMap = baseInstance.nodeVersions || baseInstance.nodeTypeVersions;
    if (versionsMap && typeof versionsMap === 'object') {
      const versionValue = versionsMap[version];
      
      // If it's already an object with description, use directly
      if (versionValue && typeof versionValue === 'object' && versionValue.description) {
        return versionValue;
      }
      
      // If it's a class, instantiate it
      if (versionValue && typeof versionValue === 'function') {
        const instance = safeInstantiate(versionValue);
        if (instance && instance.description) {
          return instance;
        }
      }
    }

    return null;
  } catch (error) {
    if (debugEnabled) {
      console.error(`[build-canonical] Failed to get version ${version} instance:`, error instanceof Error ? error.message : String(error));
    }
    return null;
  }
}

/**
 * Process a single node file
 */
function processNodeFile(filePath: string, packageVersion: string): CanonicalNodeEntry[] {
  try {
    if (debugEnabled) {
      console.log(`[build-canonical] Processing ${filePath}`);
    }

    // Clear require cache to ensure fresh load
    delete require.cache[require.resolve(filePath)];

    // Load module
    const moduleExports = require(filePath);
    
    // Extract descriptions from module (handles all exports and finds best candidate)
    const candidates = extractDescriptionsFromModule(moduleExports);
    
    if (candidates.length === 0) {
      if (debugEnabled) {
        console.log(`[build-canonical] No node class with description found in ${filePath}`);
      }
      return [];
    }

    // Use the best candidate (already sorted by properties.length)
    const bestCandidate = candidates[0];
    const NodeClass = bestCandidate.NodeClass;
    const nodeInstance = bestCandidate.instance || safeInstantiate(NodeClass);
    
    if (!nodeInstance) {
      if (debugEnabled) {
        console.log(`[build-canonical] Failed to instantiate node from ${filePath}`);
      }
      return [];
    }

    // Get description from instance (preferred) or fallback to candidate description
    const baseDescription = nodeInstance.description || bestCandidate.description;

    if (!baseDescription || !baseDescription.name) {
      if (debugEnabled) {
        console.log(`[build-canonical] No description.name found in ${filePath}`);
      }
      return [];
    }

    // Compute full node type: n8n-nodes-base.{description.name}
    const fullNodeType = `n8n-nodes-base.${baseDescription.name}`;

    // Detect if this is a versioned node wrapper
    const isVersioned = (
      Array.isArray(baseDescription.version) ||
      typeof nodeInstance.getNodeTypeVersion === 'function' ||
      nodeInstance.nodeVersions !== undefined ||
      nodeInstance.nodeTypeVersions !== undefined
    );

    if (debugEnabled && isVersioned) {
      console.log(`[build-canonical] Detected versioned node: ${fullNodeType}`);
    }

    const entries: CanonicalNodeEntry[] = [];

    if (isVersioned) {
      // Extract versions from description.version array or detect from nodeVersions
      let versions: number[] = [];
      
      if (Array.isArray(baseDescription.version)) {
        versions = baseDescription.version.filter((v: any) => typeof v === 'number');
      } else if (nodeInstance.nodeVersions || nodeInstance.nodeTypeVersions) {
        const versionsMap = nodeInstance.nodeVersions || nodeInstance.nodeTypeVersions;
        versions = Object.keys(versionsMap)
          .map(k => parseInt(k, 10))
          .filter(v => !isNaN(v))
          .sort((a, b) => a - b);
      }

      if (versions.length === 0) {
        if (debugEnabled) {
          console.log(`[build-canonical] Versioned node ${fullNodeType} but no versions found`);
        }
        return [];
      }

      if (debugEnabled) {
        console.log(`[build-canonical] Found ${versions.length} version(s) for ${fullNodeType}: [${versions.join(', ')}]`);
      }

      let maxVersionSchema: any = null;
      let maxVersion = -1;

      // Extract each version-specific instance
      for (const version of versions) {
        const versionInstance = getVersionNodeInstance(nodeInstance, version);
        
        if (!versionInstance || !versionInstance.description) {
          if (debugEnabled) {
            console.log(`[build-canonical] Failed to get version ${version} instance for ${fullNodeType}`);
          }
          continue;
        }

        const versionDescription = versionInstance.description;
        const properties = versionDescription.properties || [];
        const propertiesCount = Array.isArray(properties) ? properties.length : 0;

        if (debugEnabled) {
          console.log(`[build-canonical] Version ${version} for ${fullNodeType}: ${propertiesCount} properties`);
        }

        // Track max version for compatibility alias
        if (version > maxVersion) {
          maxVersion = version;
          maxVersionSchema = versionDescription;
        }

        const credentialTypes = extractCredentialTypes(versionDescription);
        const displayName = versionDescription.displayName || versionDescription.name || fullNodeType;
        const category = versionDescription.group || versionDescription.category || 'general';

        // Full description object as config_schema
        const configSchema = {
          ...versionDescription,
          source: 'canonical' as const,
        };

        // Ensure typeVersion is a valid number
        if (typeof version !== 'number' || isNaN(version) || !isFinite(version)) {
          if (debugEnabled) {
            console.log(`[build-canonical] Skipping invalid typeVersion ${version} for ${fullNodeType}`);
          }
          continue;
        }

        entries.push({
          node_type: fullNodeType,
          display_name: displayName,
          credential_types: credentialTypes,
          config_schema: configSchema,
          package_name: 'n8n-nodes-base',
          package_version: packageVersion,
          typeVersion: version,
          docs_url: versionDescription.documentationUrl || null,
          category: category,
        });
      }

      // Add compatibility alias entry with typeVersion=0 using max-version schema
      if (maxVersionSchema && maxVersion >= 0) {
        const credentialTypes = extractCredentialTypes(maxVersionSchema);
        const displayName = maxVersionSchema.displayName || maxVersionSchema.name || fullNodeType;
        const category = maxVersionSchema.group || maxVersionSchema.category || 'general';

        const configSchema = {
          ...maxVersionSchema,
          source: 'canonical' as const,
        };

        // Ensure maxVersion is valid before creating alias
        if (maxVersion >= 0 && typeof maxVersion === 'number' && !isNaN(maxVersion) && isFinite(maxVersion)) {
          entries.push({
            node_type: fullNodeType,
            display_name: displayName,
            credential_types: credentialTypes,
            config_schema: configSchema,
            package_name: 'n8n-nodes-base',
            package_version: packageVersion,
            typeVersion: 0, // Compatibility alias
            docs_url: maxVersionSchema.documentationUrl || null,
            category: category,
          });
        }

        if (debugEnabled) {
          console.log(`[build-canonical] Added compatibility alias (typeVersion=0) for ${fullNodeType} using max version ${maxVersion}`);
        }
      }
    } else {
      // Non-versioned node: use base description
      const credentialTypes = extractCredentialTypes(baseDescription);
      const displayName = baseDescription.displayName || baseDescription.name || fullNodeType;
      const category = baseDescription.group || baseDescription.category || 'general';

      // Handle version: can be number or array (for non-versioned nodes)
      const versions: number[] = [];
      if (baseDescription.version !== undefined && baseDescription.version !== null) {
        if (typeof baseDescription.version === 'number') {
          versions.push(baseDescription.version);
        } else if (Array.isArray(baseDescription.version)) {
          versions.push(...baseDescription.version.filter((v: any) => typeof v === 'number'));
        }
      }
      
      // Default to version 0 if no version specified
      if (versions.length === 0) {
        versions.push(0);
      }

      // Create entries for each version
      for (const typeVersion of versions) {
        // Ensure typeVersion is a valid number
        if (typeof typeVersion !== 'number' || isNaN(typeVersion) || !isFinite(typeVersion)) {
          if (debugEnabled) {
            console.log(`[build-canonical] Skipping invalid typeVersion ${typeVersion} for ${fullNodeType}`);
          }
          continue;
        }

        const configSchema = {
          ...baseDescription,
          source: 'canonical' as const,
        };

        entries.push({
          node_type: fullNodeType,
          display_name: displayName,
          credential_types: credentialTypes,
          config_schema: configSchema,
          package_name: 'n8n-nodes-base',
          package_version: packageVersion,
          typeVersion: typeVersion,
          docs_url: baseDescription.documentationUrl || null,
          category: category,
        });
      }
    }

    if (debugEnabled) {
      console.log(`[build-canonical] Extracted ${entries.length} entry/entries for ${fullNodeType}`);
    }

    return entries;
  } catch (error) {
    if (debugEnabled) {
      console.error(`[build-canonical] Failed to process ${filePath}:`, error instanceof Error ? error.message : String(error));
    }
    return [];
  }
}

/**
 * Main build function
 */
async function buildCanonical(): Promise<void> {
  const debug = process.env.NODE_LIBRARY_DEBUG === '1';
  
  if (debug) {
    console.log('[build-canonical] Starting canonical schema builder...');
  }

  // Check if n8n-nodes-base exists
  const packagePath = path.join(process.cwd(), 'node_modules', 'n8n-nodes-base');
  if (!fs.existsSync(packagePath)) {
    console.error('[build-canonical] ERROR: n8n-nodes-base package not found. Run: npm install n8n-nodes-base');
    process.exit(1);
  }

  // Read package.json to get version
  const packageJsonPath = path.join(packagePath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.error('[build-canonical] ERROR: n8n-nodes-base/package.json not found');
    process.exit(1);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const packageVersion = packageJson.version || '0.0.0';

  if (debug) {
    console.log(`[build-canonical] Found n8n-nodes-base version ${packageVersion}`);
  }

  // Find all .node.js files
  const nodesDir = path.join(packagePath, 'dist', 'nodes');
  if (!fs.existsSync(nodesDir)) {
    console.error(`[build-canonical] ERROR: ${nodesDir} not found`);
    process.exit(1);
  }

  const nodeFiles = findNodeFiles(nodesDir);
  if (nodeFiles.length === 0) {
    console.error('[build-canonical] ERROR: No .node.js files found');
    process.exit(1);
  }

  if (debug) {
    console.log(`[build-canonical] Found ${nodeFiles.length} node files`);
  }

  // Process each file - collect all entries in array
  const allEntries: CanonicalNodeEntry[] = [];

  let processedCount = 0;
  let skippedCount = 0;

  for (const filePath of nodeFiles) {
    const entries = processNodeFile(filePath, packageVersion);
    
    if (entries.length === 0) {
      skippedCount++;
      continue;
    }

    // Add all entries to array (no key conflicts since we're using array format)
    allEntries.push(...entries);
    processedCount += entries.length;
  }

  if (processedCount === 0) {
    console.error('[build-canonical] ERROR: No nodes processed successfully');
    process.exit(1);
  }

  if (debug) {
    console.log(`[build-canonical] Processed ${processedCount} entries from ${nodeFiles.length - skippedCount} files, skipped ${skippedCount} files`);
  }

  // Build catalog with array format
  const catalog = {
    version: packageVersion,
    nodes: allEntries,
  };

  // Determine output path (match loader.ts default: src/catalog/canonical.json)
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  const outputPath = fs.existsSync(artifactsDir)
    ? path.join(artifactsDir, 'canonical.json')
    : path.join(process.cwd(), 'src', 'catalog', 'canonical.json');
  
  // Ensure directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write canonical.json
  fs.writeFileSync(outputPath, JSON.stringify(catalog, null, 2), 'utf-8');

  console.log(`[build-canonical] Successfully wrote ${allEntries.length} entries to ${outputPath}`);

  // Regression check: ensure core nodes like httpRequest are present
  const httpRequestEntries = allEntries.filter(e => 
    e.node_type === 'n8n-nodes-base.httpRequest' || 
    String(e.node_type || '').includes('httpRequest')
  );

  if (httpRequestEntries.length === 0) {
    console.error('[build-canonical] ERROR: httpRequest node not found in canonical.json');
    console.error('[build-canonical] This indicates a bug in node extraction. Check:');
    console.error('[build-canonical] 1. Is n8n-nodes-base installed?');
    console.error('[build-canonical] 2. Does HttpRequest.node.js exist in dist/nodes/?');
    console.error('[build-canonical] 3. Can HttpRequest be instantiated?');
    process.exit(1);
  }

  // Verify httpRequest has real properties
  const httpRequestWithProps = httpRequestEntries.find(e => {
    const props = e.config_schema?.properties || [];
    const propsCount = Array.isArray(props) ? props.length : 0;
    const schemaStr = JSON.stringify(e.config_schema || {});
    const schemaBytes = Buffer.byteLength(schemaStr, 'utf8');
    return propsCount > 10 && schemaBytes > 2000;
  });

  if (!httpRequestWithProps) {
    console.error('[build-canonical] ERROR: httpRequest found but missing real properties');
    console.error('[build-canonical] Found entries:', httpRequestEntries.map(e => ({
      typeVersion: e.typeVersion,
      propsCount: Array.isArray(e.config_schema?.properties) ? e.config_schema.properties.length : 0,
      schemaBytes: JSON.stringify(e.config_schema || {}).length,
    })));
    process.exit(1);
  }

  if (debug) {
    console.log(`[build-canonical] Regression check passed: httpRequest found with ${Array.isArray(httpRequestWithProps.config_schema?.properties) ? httpRequestWithProps.config_schema.properties.length : 0} properties`);
  }
}

// Run if called directly
if (require.main === module) {
  buildCanonical()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('[build-canonical] Fatal error:', err);
      process.exit(1);
    });
}

export { buildCanonical };

