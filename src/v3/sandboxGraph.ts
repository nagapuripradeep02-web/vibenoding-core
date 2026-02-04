/**
 * V3.3 Sandbox Graph Utilities
 * 
 * Pure functions for workflow graph analysis and transformation
 * Used by the sandbox engine to create test workflow clones
 */

import crypto from 'crypto';
import type { N8nWorkflow, N8nNode, N8nConnections } from './types';

// Known trigger node types in n8n
const TRIGGER_NODE_TYPES = new Set([
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.cronTrigger',
  'n8n-nodes-base.intervalTrigger',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.emailTrigger',
  'n8n-nodes-base.emailReadImap',
  'n8n-nodes-base.telegramTrigger',
  'n8n-nodes-base.slackTrigger',
  'n8n-nodes-base.httpRequest', // When used as trigger
  'n8n-nodes-base.start', // Legacy start node
  '@n8n/n8n-nodes-langchain.chatTrigger',
  // Add more as needed
]);

// Patterns that indicate a trigger node by type name
const TRIGGER_TYPE_PATTERNS = [
  /trigger$/i,
  /^n8n-nodes-base\..*Trigger$/,
  /webhook/i,
];

/**
 * Check if a node is a trigger type
 */
export function isTriggerNode(node: N8nNode): boolean {
  if (TRIGGER_NODE_TYPES.has(node.type)) {
    return true;
  }
  
  // Check patterns
  for (const pattern of TRIGGER_TYPE_PATTERNS) {
    if (pattern.test(node.type)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Build a map from node name to node
 */
function buildNodeNameMap(nodes: N8nNode[]): Map<string, N8nNode> {
  const map = new Map<string, N8nNode>();
  for (const node of nodes) {
    map.set(node.name, node);
  }
  return map;
}

/**
 * Compute incoming edges for each node
 * Returns Map<targetNodeName, sourceNodeName[]>
 */
export function computeIncomingEdges(workflow: N8nWorkflow): Map<string, string[]> {
  const connections = workflow.connections || {};
  const incomingMap = new Map<string, string[]>();
  
  // Initialize all nodes with empty arrays
  for (const node of workflow.nodes || []) {
    incomingMap.set(node.name, []);
  }
  
  // Parse connections: source -> target
  for (const [sourceNodeName, outputTypes] of Object.entries(connections)) {
    if (!outputTypes || typeof outputTypes !== 'object') continue;
    
    for (const connectionArrays of Object.values(outputTypes)) {
      if (!Array.isArray(connectionArrays)) continue;
      
      for (const connectionArray of connectionArrays) {
        if (!Array.isArray(connectionArray)) continue;
        
        for (const conn of connectionArray) {
          if (!conn || typeof conn.node !== 'string') continue;
          
          const targetNodeName = conn.node;
          const incoming = incomingMap.get(targetNodeName) || [];
          if (!incoming.includes(sourceNodeName)) {
            incoming.push(sourceNodeName);
            incomingMap.set(targetNodeName, incoming);
          }
        }
      }
    }
  }
  
  return incomingMap;
}

/**
 * Find entry nodes for the workflow
 * Entry nodes are:
 * 1. Nodes that are direct downstream of trigger nodes (first non-trigger nodes)
 * 2. OR nodes with no incoming connections (if not triggers themselves)
 */
export function findEntryNodes(workflow: N8nWorkflow): N8nNode[] {
  const nodes = workflow.nodes || [];
  const connections = workflow.connections || {};
  const nodeNameMap = buildNodeNameMap(nodes);
  const incomingEdges = computeIncomingEdges(workflow);
  
  const entryNodes: N8nNode[] = [];
  const entryNodeNames = new Set<string>();
  
  // Strategy 1: Find nodes directly downstream of triggers
  for (const [sourceNodeName, outputTypes] of Object.entries(connections)) {
    const sourceNode = nodeNameMap.get(sourceNodeName);
    if (!sourceNode || !isTriggerNode(sourceNode)) continue;
    
    // This is a trigger - find its direct downstream nodes
    for (const connectionArrays of Object.values(outputTypes || {})) {
      if (!Array.isArray(connectionArrays)) continue;
      
      for (const connectionArray of connectionArrays) {
        if (!Array.isArray(connectionArray)) continue;
        
        for (const conn of connectionArray) {
          if (!conn || typeof conn.node !== 'string') continue;
          
          const targetNode = nodeNameMap.get(conn.node);
          if (targetNode && !isTriggerNode(targetNode) && !entryNodeNames.has(targetNode.name)) {
            entryNodes.push(targetNode);
            entryNodeNames.add(targetNode.name);
          }
        }
      }
    }
  }
  
  // Strategy 2: Find non-trigger nodes with no incoming connections
  for (const node of nodes) {
    if (isTriggerNode(node)) continue;
    if (entryNodeNames.has(node.name)) continue;
    
    const incoming = incomingEdges.get(node.name) || [];
    if (incoming.length === 0) {
      entryNodes.push(node);
      entryNodeNames.add(node.name);
    }
  }
  
  return entryNodes;
}

/**
 * Generate a random unguessable webhook path
 */
export function generateWebhookPath(connectionId: string, workflowUuid: string): string {
  const randomPart = crypto.randomUUID();
  // Use shorter IDs for cleaner URLs
  const connShort = connectionId.slice(0, 8);
  const wfShort = workflowUuid.slice(0, 8);
  return `vn-test/${connShort}/${wfShort}/${randomPart}`;
}

/**
 * Generate a random auth secret for webhook authentication
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create the VN Test Webhook trigger node
 * Phase 1: Use authentication: "none" to avoid credential issues
 * Compatible with n8n Cloud and self-hosted
 */
export function createWebhookTriggerNode(
  webhookPath: string,
  authSecret: string,
  position: [number, number] = [-200, 300]
): N8nNode {
  return {
    id: crypto.randomUUID(),
    name: 'VN Test Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 1.1, // Use 1.1 for broad compatibility
    position,
    disabled: false, // CRITICAL: Explicitly ensure webhook is NEVER disabled
    parameters: {
      httpMethod: 'POST',
      path: webhookPath,
      responseMode: 'lastNode',
      authentication: 'none', // Phase 1: simplified auth
      options: {}
    }
  };
}

/**
 * Create connections from webhook node to entry nodes
 */
function createWebhookConnections(
  webhookNodeName: string,
  entryNodes: N8nNode[]
): N8nConnections {
  if (entryNodes.length === 0) return {};
  
  const connections: Array<{ node: string; type: string; index: number }> = [];
  for (const entryNode of entryNodes) {
    connections.push({
      node: entryNode.name,
      type: 'main',
      index: 0
    });
  }
  
  return {
    [webhookNodeName]: {
      main: [connections]
    }
  };
}

/**
 * Clone a workflow for testing
 * - Adds [VN TEST] prefix to name
 * - Adds webhook trigger node
 * - Disables existing trigger nodes (but NOT the new webhook)
 * - Connects webhook to entry nodes
 */
export function cloneWorkflowForTest(
  prodWorkflow: N8nWorkflow,
  webhookPath: string,
  authSecret: string
): { workflow: N8nWorkflow; webhookNodeName: string } {
  // Find entry nodes BEFORE modifying the workflow
  const entryNodes = findEntryNodes(prodWorkflow);
  
  // Calculate webhook position (left of leftmost entry node)
  let webhookPosition: [number, number] = [-200, 300];
  if (entryNodes.length > 0) {
    const minX = Math.min(...entryNodes.map(n => n.position[0]));
    const avgY = entryNodes.reduce((sum, n) => sum + n.position[1], 0) / entryNodes.length;
    webhookPosition = [minX - 250, avgY];
  }
  
  // Create webhook trigger node FIRST
  const webhookNode = createWebhookTriggerNode(webhookPath, authSecret, webhookPosition);
  const webhookNodeName = webhookNode.name; // "VN Test Webhook"
  
  // CRITICAL: Collect original node names BEFORE adding webhook
  // This ensures we only disable ORIGINAL triggers, never the new webhook
  const originalNodeNames = new Set(prodWorkflow.nodes.map(n => n.name));
  
  // Clone and modify nodes - disable ONLY original triggers
  const clonedNodes: N8nNode[] = prodWorkflow.nodes.map(node => {
    // Deep clone to avoid mutations
    const cloned = JSON.parse(JSON.stringify(node));
    
    // Disable ONLY original trigger nodes from production workflow
    if (isTriggerNode(node) && originalNodeNames.has(node.name)) {
      cloned.disabled = true;
      console.log(`[sandboxGraph] Disabled original trigger: ${node.name} (type: ${node.type})`);
    }
    
    return cloned;
  });
  
  // Add webhook node AFTER processing original nodes
  // Triple-check it's enabled - explicitly set to false (don't delete, n8n needs it)
  webhookNode.disabled = false;
  clonedNodes.push(webhookNode);
  
  // ASSERTION: Verify the webhook node is NOT disabled
  const finalWebhookNode = clonedNodes.find(n => n.name === webhookNodeName);
  if (!finalWebhookNode) {
    throw new Error('[sandboxGraph] CRITICAL: VN Test Webhook node not found after insertion!');
  }
  if (finalWebhookNode.disabled === true) {
    throw new Error('[sandboxGraph] CRITICAL: VN Test Webhook node is disabled! This should never happen.');
  }
  
  // Log webhook node details for debugging
  console.log('[sandboxGraph] VN Test Webhook node configuration:', JSON.stringify({
    name: finalWebhookNode.name,
    type: finalWebhookNode.type,
    typeVersion: finalWebhookNode.typeVersion,
    disabled: finalWebhookNode.disabled,
    'parameters.path': finalWebhookNode.parameters?.path,
    'parameters.httpMethod': finalWebhookNode.parameters?.httpMethod,
    'parameters.responseMode': finalWebhookNode.parameters?.responseMode,
  }, null, 2));
  
  // Clone connections and add webhook connections
  const webhookConnections = createWebhookConnections(webhookNodeName, entryNodes);
  const clonedConnections: N8nConnections = {
    ...prodWorkflow.connections,
    ...webhookConnections
  };
  
  // Build cloned workflow - ONLY include allowed fields for n8n CREATE endpoint
  const clonedWorkflow: Partial<N8nWorkflow> = {
    name: `[VN TEST] ${prodWorkflow.name}`,
    nodes: clonedNodes,
    connections: clonedConnections,
    settings: prodWorkflow.settings || {},
    staticData: prodWorkflow.staticData || undefined,
  };
  
  // Explicitly DO NOT include: id, active, createdAt, updatedAt, versionId, tags, shared, etc.
  // n8n CREATE endpoint only accepts: name, nodes, connections, settings, staticData
  // NOTE: 'active' is read-only and must NOT be included in CREATE requests
  
  console.log(`[sandboxGraph] Cloned workflow has ${clonedNodes.length} nodes, webhook path: ${webhookPath}`);
  
  return {
    workflow: clonedWorkflow as N8nWorkflow,
    webhookNodeName
  };
}

/**
 * Extract the webhook URL from an n8n base URL and webhook path
 */
export function buildWebhookUrl(n8nBaseUrl: string, webhookPath: string): string {
  const cleanBase = n8nBaseUrl.replace(/\/+$/, '');
  return `${cleanBase}/webhook/${webhookPath}`;
}
