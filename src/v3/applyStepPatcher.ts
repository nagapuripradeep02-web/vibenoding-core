/**
 * Phase 2B Step 2: Apply-Step Patcher
 * Converts plan steps to n8n workflow patches
 * 
 * Goals:
 * - Generate deterministic patches (temperature=0)
 * - Only whitelisted operations allowed
 * - Compute rollback operations
 */

import type { PlanStep } from './planContract';
import type { NodePatch, ApplyStepPatch } from './applyStepContract';
import { VALID_PATCH_OPS, validatePatchOperations } from './applyStepContract';
import type { N8nWorkflow, N8nNode } from './types';
import { randomUUID } from 'crypto';

/**
 * Mapping from display names to full n8n node type strings
 */
const DISPLAY_NAME_TO_TYPE: Record<string, string> = {
    // Common nodes - case insensitive lookup done separately
    'Set': 'n8n-nodes-base.set',
    'set': 'n8n-nodes-base.set',
    'Code': 'n8n-nodes-base.code',
    'code': 'n8n-nodes-base.code',
    'If': 'n8n-nodes-base.if',
    'if': 'n8n-nodes-base.if',
    'Switch': 'n8n-nodes-base.switch',
    'switch': 'n8n-nodes-base.switch',
    'HTTP Request': 'n8n-nodes-base.httpRequest',
    'httpRequest': 'n8n-nodes-base.httpRequest',
    'Webhook': 'n8n-nodes-base.webhook',
    'webhook': 'n8n-nodes-base.webhook',
    'NoOp': 'n8n-nodes-base.noOp',
    'noOp': 'n8n-nodes-base.noOp',
    'No Operation': 'n8n-nodes-base.noOp',
    'Merge': 'n8n-nodes-base.merge',
    'merge': 'n8n-nodes-base.merge',
    'Split In Batches': 'n8n-nodes-base.splitInBatches',
    'Function': 'n8n-nodes-base.function',
    'function': 'n8n-nodes-base.function',
    'Execute Workflow': 'n8n-nodes-base.executeWorkflow',
    'Wait': 'n8n-nodes-base.wait',
    'Start': 'n8n-nodes-base.start',
};

/**
 * Canonicalize a node type string to full n8n format.
 * Throws if input is not recognized.
 * @param input - Display name like "Set" or full type like "n8n-nodes-base.set"
 * @returns Full n8n type string like "n8n-nodes-base.set"
 */
export function canonicalizeNodeType(input: string): string {
    if (!input) {
        throw new Error('Node type is required');
    }

    // Already a full n8n type (starts with "n8n-" and contains ".")
    if (input.startsWith('n8n-') && input.includes('.')) {
        return input;
    }

    // Look up in display name map
    const mapped = DISPLAY_NAME_TO_TYPE[input];
    if (mapped) {
        return mapped;
    }

    // Try case-insensitive lookup
    const lowerInput = input.toLowerCase();
    for (const [key, value] of Object.entries(DISPLAY_NAME_TO_TYPE)) {
        if (key.toLowerCase() === lowerInput) {
            return value;
        }
    }

    // Unknown type - throw helpful error
    const knownTypes = Object.keys(DISPLAY_NAME_TO_TYPE)
        .filter((k, i, arr) => arr.indexOf(k) === i)
        .slice(0, 5)
        .join(', ');
    throw new Error(
        `Invalid node type "${input}". ` +
        `Use full n8n type like "n8n-nodes-base.set" or known names: ${knownTypes}...`
    );
}

/**
 * Infer the best typeVersion for a node type based on existing workflow nodes.
 * @param workflow - The workflow JSON
 * @param nodeType - Full n8n node type string
 * @returns The typeVersion to use (max from existing nodes, or 1 as fallback)
 */
export function inferTypeVersion(workflow: N8nWorkflow, nodeType: string): number {
    const existingNodes = workflow.nodes?.filter(n => n.type === nodeType) || [];
    if (existingNodes.length > 0) {
        const versions = existingNodes
            .map(n => n.typeVersion)
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
        if (versions.length > 0) {
            return Math.max(...versions);
        }
    }
    // Default versions for common node types
    const defaultVersions: Record<string, number> = {
        'n8n-nodes-base.set': 3,
        'n8n-nodes-base.code': 2,
        'n8n-nodes-base.if': 2,
        'n8n-nodes-base.switch': 3,
        'n8n-nodes-base.httpRequest': 4,
        'n8n-nodes-base.webhook': 2,
        'n8n-nodes-base.merge': 3,
    };
    return defaultVersions[nodeType] || 1;
}

/**
 * Extract key-value pairs from various LLM/n8n parameter formats
 * 
 * Supported input formats:
 * 1) { assignments: { assignments: [{id, name, type, value}] } } (Set v2/v3)
 * 2) { values: { string: [{name, value}] } } (Set v1 - array format)
 * 3) { values: { string: {key: "value"} } } (Set v1 - object format)
 * 4) { values: { vn_marker: "test" } } (values.key direct)
 * 5) { vn_marker: "test" } (direct key-value)
 */
function extractKvPairs(params: Record<string, unknown>): Record<string, string> {
    const kvPairs: Record<string, string> = {};

    // Format 1: assignments.assignments array (Set v2/v3)
    if (params.assignments && typeof params.assignments === 'object') {
        const assignments = params.assignments as Record<string, unknown>;
        if (Array.isArray(assignments.assignments)) {
            for (const a of assignments.assignments) {
                if (a && typeof a === 'object' && 'name' in a && 'value' in a) {
                    const name = (a as { name: string }).name;
                    const value = (a as { value: unknown }).value;
                    if (name && value !== undefined) {
                        kvPairs[name] = String(value);
                    }
                }
            }
            if (Object.keys(kvPairs).length > 0) return kvPairs;
        }
    }

    // Format 2 & 3: values.string (array or object)
    if (params.values && typeof params.values === 'object') {
        const values = params.values as Record<string, unknown>;

        // Format 2: values.string as array [{name, value}]
        if (Array.isArray(values.string)) {
            for (const item of values.string) {
                if (item && typeof item === 'object' && 'name' in item && 'value' in item) {
                    const name = (item as { name: string }).name;
                    const value = (item as { value: unknown }).value;
                    if (name && value !== undefined) {
                        kvPairs[name] = String(value);
                    }
                }
            }
            if (Object.keys(kvPairs).length > 0) return kvPairs;
        }

        // Format 3: values.string as object {key: "value"}
        if (values.string && typeof values.string === 'object' && !Array.isArray(values.string)) {
            for (const [k, v] of Object.entries(values.string as Record<string, unknown>)) {
                if (v !== undefined && v !== null) {
                    kvPairs[k] = String(v);
                }
            }
            if (Object.keys(kvPairs).length > 0) return kvPairs;
        }

        // Format 4: values.{key} direct (e.g., values.vn_marker = "test")
        for (const [k, v] of Object.entries(values)) {
            if (k !== 'string' && k !== 'number' && k !== 'boolean' &&
                (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
                kvPairs[k] = String(v);
            }
        }
        if (Object.keys(kvPairs).length > 0) return kvPairs;
    }

    // Format 5: Direct key-value format: { vn_marker: "test" }
    const excludeKeys = ['keepOnlySet', 'options', 'values', 'assignments', 'mode', 'duplicateItem', 'includeOtherFields'];
    for (const [key, value] of Object.entries(params)) {
        if (!excludeKeys.includes(key) &&
            (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
            kvPairs[key] = String(value);
        }
    }

    return kvPairs;
}

/**
 * Build Set node parameters based on typeVersion
 * - typeVersion < 2: uses values.string array format (v1)
 * - typeVersion >= 2: uses assignments.assignments array format (v2/v3)
 * 
 * n8n Set node versions:
 * - v1: uses { values: { string: [{name, value}] } }
 * - v2: uses { assignments: { assignments: [{id, name, type, value}] } }
 * - v3/v3.4: same as v2 but with additional mode options
 */
function buildSetParams(typeVersion: number, kvPairs: Record<string, string>): Record<string, unknown> {
    const entries = Object.entries(kvPairs);

    // Treat anything < 2 as v1 format
    if (typeVersion < 2) {
        console.log(`[buildSetParams] Building v1 format (typeVersion=${typeVersion}) for ${entries.length} pairs`);
        return {
            keepOnlySet: true,
            values: {
                string: entries.length > 0
                    ? entries.map(([name, value]) => ({ name, value }))
                    : [], // Empty array is valid
            },
            options: {},
        };
    } else {
        // v2, v3, v3.4 all use assignments format
        console.log(`[buildSetParams] Building v2/v3 format (typeVersion=${typeVersion}) for ${entries.length} pairs`);
        return {
            mode: 'manual',
            duplicateItem: false,
            assignments: {
                assignments: entries.length > 0
                    ? entries.map(([name, value], idx) => ({
                        id: `assign_${idx}_${Date.now()}`,
                        name,
                        type: 'string',
                        value,
                    }))
                    : [], // Empty array is valid for no assignments
            },
            includeOtherFields: false,
            options: {},
        };
    }
}

/**
 * Validate and fix nodes to ensure proper n8n types before sending to n8n
 * Mutates nodes in place to canonicalize types and fix missing typeVersions
 */
function validateNodesForN8n(nodes: N8nNode[]): void {
    for (const node of nodes) {
        // Fix node type if it's a display name instead of full type
        if (typeof node.type === 'string' && !node.type.includes('.')) {
            try {
                const canonicalType = canonicalizeNodeType(node.type);
                console.log(`[validateNodesForN8n] Fixed node "${node.name}": "${node.type}" -> "${canonicalType}"`);
                node.type = canonicalType;
            } catch (e) {
                // If canonicalization fails for existing nodes, try to construct a reasonable type
                const lowerType = node.type.toLowerCase().replace(/\s+/g, '');
                node.type = `n8n-nodes-base.${lowerType}`;
                console.warn(`[validateNodesForN8n] Unknown node type "${node.type}" for "${node.name}", using fallback`);
            }
        }

        // Fix missing or invalid typeVersion
        if (typeof node.typeVersion !== 'number' || isNaN(node.typeVersion)) {
            // Use default versions for known types
            const defaultVersions: Record<string, number> = {
                'n8n-nodes-base.set': 3,
                'n8n-nodes-base.code': 2,
                'n8n-nodes-base.if': 2,
                'n8n-nodes-base.webhook': 2,
            };
            node.typeVersion = defaultVersions[node.type] || 1;
            console.log(`[validateNodesForN8n] Fixed node "${node.name}": typeVersion set to ${node.typeVersion}`);
        }

        // Fix Set node parameters if needed
        if (node.type === 'n8n-nodes-base.set') {
            const params = (node.parameters || {}) as Record<string, unknown>;
            const tv = node.typeVersion;

            // Check if parameters need fixing for v2/v3 format
            if (tv >= 2) {
                // v2/v3 needs assignments.assignments format
                if (!params.assignments || typeof params.assignments !== 'object') {
                    // Extract any existing values and convert
                    const kvPairs = extractKvPairs(params);
                    node.parameters = buildSetParams(tv, kvPairs);
                    console.log(`[validateNodesForN8n] Fixed Set v${tv} params for "${node.name}"`);
                }
            } else {
                // v1 needs values.string format
                if (!params.values || typeof params.values !== 'object') {
                    const kvPairs = extractKvPairs(params);
                    node.parameters = buildSetParams(tv, kvPairs);
                    console.log(`[validateNodesForN8n] Fixed Set v${tv} params for "${node.name}"`);
                }
            }
        }

        // Fix position if needed
        if (!Array.isArray(node.position) || node.position.length !== 2) {
            node.position = [0, 0];
            console.warn(`[validateNodesForN8n] Fixed node "${node.name}": position set to [0, 0]`);
        }
    }
}


/**
 * Build LLM prompt for patch generation
 */
export function buildPatchPrompt(step: PlanStep, workflow: N8nWorkflow): string {
    const nodeNames = workflow.nodes?.map(n => n.name) || [];

    return `You are an n8n workflow patcher. Generate ONLY a JSON array of patch operations.

STEP TO APPLY:
- Title: ${step.title}
- Target Nodes: ${step.nodeLocators.join(', ') || 'None specified'}
- Actions: ${step.actions.join('\n  - ')}
- Expected Outcome: ${step.expectedOutcome}

CURRENT WORKFLOW NODES:
${nodeNames.map(n => `- "${n}"`).join('\n')}

ALLOWED OPERATIONS (whitelist):
- update_node_params: Change parameters of existing node
- add_node: Add a new node (REQUIRES full nodeType like "n8n-nodes-base.set")
- add_edge: Add connection between nodes (requires fromNode, toNode)
- set_credential_ref: Set credential reference (requires nodeName, credentialRef with name and type)

IMPORTANT: nodeType MUST be a full n8n type string like "n8n-nodes-base.set" (NOT "Set").

OUTPUT FORMAT (JSON array only, no explanation):
[
  {
    "op": "add_node",
    "nodeType": "n8n-nodes-base.set",
    "nodeName": "VN Marker",
    "position": { "x": 300, "y": 200 },
    "parameters": {}
  },
  {
    "op": "update_node_params",
    "nodeName": "Existing Node Name",
    "parameters": { "key": "value" }
  }
]

RULES:
1. Return ONLY valid JSON array, no markdown, no explanation
2. Only reference nodes that exist in the workflow (listed above)
3. Only use allowed operations
4. For add_node: nodeType MUST be full type like "n8n-nodes-base.set", "n8n-nodes-base.code"
5. For add_node, use reasonable default position { "x": 300, "y": 200 }
6. For set_credential_ref, never include actual secrets - only reference name

Generate the patch operations now:`;
}


/**
 * Parse LLM response into patch operations
 */
export function parsePatchResponse(llmOutput: string, stepId: string): ApplyStepPatch | null {
    try {
        // Try to extract JSON if wrapped in markdown
        let cleanJson = llmOutput.trim();
        if (cleanJson.startsWith('```')) {
            const match = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (match) cleanJson = match[1];
        }

        const parsed = JSON.parse(cleanJson);

        if (!Array.isArray(parsed)) {
            console.error('[parsePatchResponse] Expected array, got:', typeof parsed);
            return null;
        }

        // Validate against whitelist
        const validation = validatePatchOperations(parsed as NodePatch[]);
        if (!validation.valid) {
            console.error('[parsePatchResponse] Validation failed:', validation.errors);
            return null;
        }

        // Build rollback operations (inverse of each operation)
        const rollback = buildRollbackOperations(parsed as NodePatch[]);

        return {
            stepId,
            operations: parsed as NodePatch[],
            rollback,
        };
    } catch (e) {
        console.error('[parsePatchResponse] Parse error:', e);
        return null;
    }
}

/**
 * Build rollback operations (inverse of patch)
 */
function buildRollbackOperations(operations: NodePatch[]): NodePatch[] {
    // For now, return empty array - rollback requires knowing original state
    // In a full implementation, we'd capture original values before patching
    return [];
}

/**
 * Apply patch operations to workflow JSON
 * Returns modified workflow
 */
export function applyPatchToWorkflow(
    workflow: N8nWorkflow,
    patch: ApplyStepPatch
): { workflow: N8nWorkflow; diffSummary: string } {
    const changes: string[] = [];
    const nodes = [...(workflow.nodes || [])];
    const connections = { ...(workflow.connections || {}) };

    // Track name remapping: LLM may reference nodes by type (e.g., "Set")
    // but we generate unique names (e.g., "VN Set"). This map tracks the mapping.
    const nodeNameRemap: Record<string, string> = {};

    /**
     * Resolve a node name using the remap table
     * Falls back to original name if not in remap
     */
    function resolveNodeName(name: string | undefined): string | undefined {
        if (!name) return undefined;
        return nodeNameRemap[name] || name;
    }

    for (const op of patch.operations) {
        switch (op.op) {
            case 'update_node_params': {
                // Resolve node name (LLM may use type name like "Set" instead of actual name)
                const resolvedName = resolveNodeName(op.nodeName);
                const nodeIndex = nodes.findIndex(n => n.name === resolvedName);
                if (nodeIndex === -1) {
                    console.warn(`[applyPatch] Node not found: ${op.nodeName} (resolved: ${resolvedName})`);
                    continue;
                }
                const node = nodes[nodeIndex];

                // Check if this is a Set node and convert params if needed
                let mergedParams = { ...node.parameters, ...op.parameters };
                if (node.type === 'n8n-nodes-base.set' || node.type.toLowerCase().includes('set')) {
                    const kvPairs = extractKvPairs(mergedParams);
                    mergedParams = buildSetParams(node.typeVersion || 3, kvPairs);
                }

                nodes[nodeIndex] = {
                    ...node,
                    parameters: mergedParams,
                };
                changes.push(`Updated params on "${resolvedName}"`);
                break;
            }

            case 'add_node': {
                // Canonicalize node type to full n8n format (throws if invalid)
                const rawType = op.nodeType || 'n8n-nodes-base.noOp';
                console.log(`[applyPatch] add_node: rawType="${rawType}", op.nodeType="${op.nodeType}"`);
                const canonicalType = canonicalizeNodeType(rawType);
                const typeVersion = inferTypeVersion(workflow, canonicalType);
                console.log(`[applyPatch] add_node: canonicalType="${canonicalType}", typeVersion=${typeVersion}`);

                // DEDUP: If op.nodeName starts with "VN " and same name+type already exists,
                // update params instead of creating a duplicate node
                if (op.nodeName && op.nodeName.startsWith('VN ')) {
                    const existingIdx = nodes.findIndex(
                        n => n.name === op.nodeName && n.type === canonicalType
                    );
                    if (existingIdx !== -1) {
                        let mergedParams = { ...nodes[existingIdx].parameters, ...(op.parameters || {}) };
                        if (canonicalType === 'n8n-nodes-base.set') {
                            const kvPairs = extractKvPairs(mergedParams as Record<string, unknown>);
                            mergedParams = buildSetParams(typeVersion, kvPairs);
                        }
                        nodes[existingIdx] = {
                            ...nodes[existingIdx],
                            parameters: mergedParams,
                        };
                        // Register name mapping for edge resolution
                        nodeNameRemap[rawType] = op.nodeName;
                        console.log(`[applyPatch] Dedup: updated existing "${op.nodeName}" instead of adding duplicate`);
                        changes.push(`Updated existing "${op.nodeName}" (dedup)`);
                        break;
                    }
                }

                // Ensure position is [x, y] array format
                let position: [number, number];
                if (Array.isArray(op.position)) {
                    position = [op.position[0] || 0, op.position[1] || 0];
                } else if (op.position && typeof op.position === 'object') {
                    position = [op.position.x || 0, op.position.y || 0];
                } else {
                    // Default position offset from existing nodes
                    const maxX = Math.max(...(nodes.map(n => n.position?.[0] || 0)), 0);
                    position = [maxX + 200, 200];
                }

                // Generate unique name
                const baseName = op.nodeName || `VN ${rawType}`;
                let nodeName = baseName;
                let counter = 1;
                while (nodes.some(n => n.name === nodeName)) {
                    nodeName = `${baseName} ${counter++}`;
                }

                // Prepare parameters - convert for Set nodes
                let params = op.parameters || {};
                if (canonicalType === 'n8n-nodes-base.set') {
                    const kvPairs = extractKvPairs(params as Record<string, unknown>);
                    params = buildSetParams(typeVersion, kvPairs);
                }

                const newNode: N8nNode = {
                    id: randomUUID(),
                    name: nodeName,
                    type: canonicalType,
                    typeVersion: typeVersion,
                    position,
                    parameters: params,
                };

                // Register name mapping: LLM may reference this node by type (e.g., "Set")
                // So we map both the type and any original nodeName to the actual generated name
                nodeNameRemap[rawType] = nodeName;
                if (op.nodeName && op.nodeName !== nodeName) {
                    nodeNameRemap[op.nodeName] = nodeName;
                }

                console.log(`[applyPatch] Adding node: ${nodeName} (${canonicalType} v${typeVersion})`);
                nodes.push(newNode);
                changes.push(`Added node "${nodeName}" (${canonicalType})`);
                break;
            }

            case 'add_edge': {
                if (op.fromNode && op.toNode) {
                    // Resolve node names (LLM may use type names)
                    const fromName = resolveNodeName(op.fromNode)!;
                    const toName = resolveNodeName(op.toNode)!;

                    // Initialize connection array for source node if needed
                    if (!connections[fromName]) {
                        connections[fromName] = { main: [[]] };
                    }
                    if (!connections[fromName].main) {
                        connections[fromName].main = [[]];
                    }
                    if (!connections[fromName].main[0]) {
                        connections[fromName].main[0] = [];
                    }

                    // IDEMPOTENT: Skip if this exact edge already exists
                    const alreadyExists = connections[fromName].main[0].some(
                        (c: { node: string }) => c.node === toName
                    );
                    if (alreadyExists) {
                        console.log(`[applyPatch] Edge "${fromName}" → "${toName}" already exists, skipping`);
                        break;
                    }

                    connections[fromName].main[0].push({
                        node: toName,
                        type: 'main',
                        index: 0,
                    });
                    changes.push(`Connected "${fromName}" → "${toName}"`);
                }
                break;
            }

            case 'set_credential_ref': {
                // Resolve node name using remap table
                const resolvedCredName = resolveNodeName(op.nodeName);
                const nodeIndex = nodes.findIndex(n => n.name === resolvedCredName);
                if (nodeIndex === -1) {
                    console.warn(`[applyPatch] Node not found for credential: ${op.nodeName} (resolved: ${resolvedCredName})`);
                    continue;
                }
                const node = nodes[nodeIndex];
                nodes[nodeIndex] = {
                    ...node,
                    credentials: {
                        ...node.credentials,
                        [op.credentialRef?.type || 'unknown']: {
                            id: 'pending', // Will be resolved by n8n
                            name: op.credentialRef?.name || 'Unknown',
                        },
                    },
                };
                changes.push(`Set credential on "${op.nodeName}"`);
                break;
            }
        }
    }

    const diffSummary = changes.length > 0
        ? changes.join('; ')
        : 'No changes applied';

    // Validate all nodes before sending to n8n
    // This catches type resolution issues early with a clear error
    validateNodesForN8n(nodes);

    // Build workflow with patched nodes/connections
    // NOTE: Do not include 'active' - it's read-only in n8n v1 API
    return {
        workflow: {
            id: workflow.id,
            name: workflow.name,
            nodes,
            connections,
            settings: workflow.settings || {},
            staticData: workflow.staticData || null,
            // active is omitted - n8n rejects it as read-only
        } as N8nWorkflow,
        diffSummary,
    };
}

/**
 * Prepare a workflow for n8n PUT update
 * Only includes fields that n8n accepts for workflow updates.
 * NOTE: 'active' is read-only in n8n v1 API - omit it entirely.
 * Server-managed fields (id, createdAt, updatedAt, versionId, tags) are also omitted.
 */
export function prepareWorkflowForUpdate(workflow: N8nWorkflow): Partial<N8nWorkflow> {
    // SAFETY: We never send 'active' - n8n rejects it as read-only.
    // VN TEST workflows are created inactive and stay that way.
    return {
        name: workflow.name,
        nodes: workflow.nodes || [],
        connections: workflow.connections || {},
        settings: workflow.settings || {},
        staticData: workflow.staticData || null,
        // DO NOT include: active, id, createdAt, updatedAt, versionId, tags
    };
}

/**
 * Compute diff summary without applying patch
 */
export function computeDiffSummary(patch: ApplyStepPatch): string {
    const parts: string[] = [];

    for (const op of patch.operations) {
        switch (op.op) {
            case 'update_node_params':
                parts.push(`Update params on "${op.nodeName}"`);
                break;
            case 'add_node':
                parts.push(`Add node "${op.nodeName || op.nodeType}"`);
                break;
            case 'add_edge':
                parts.push(`Connect "${op.fromNode}" → "${op.toNode}"`);
                break;
            case 'set_credential_ref':
                parts.push(`Set credential on "${op.nodeName}"`);
                break;
        }
    }

    return parts.length > 0 ? parts.join('; ') : 'No operations';
}
