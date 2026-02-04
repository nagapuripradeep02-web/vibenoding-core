/**
 * Assistant Context Builder - Phase 2 Ask Mode
 * Builds a comprehensive context pack for LLM to answer workflow questions
 */

import type { N8nWorkflow, N8nNode } from './types';

export interface LatestExecutionError {
  executionId: string;
  failedNode: string;
  errorMessage: string;
  timestamp: string;
}

export interface ContextPack {
  workflow: {
    id: string;
    name: string;
    active: boolean;
    nodeCount: number;
    connectionCount: number;
  };
  // Explicit arrays for LLM context (anti-hallucination)
  nodes: Array<{
    name: string;
    type: string;
    typeVersion?: number;
    disabled?: boolean;
    position: [number, number];
    hasCredentials: boolean;
  }>;
  missingCredentials: string[]; // Explicit list
  evaluationIssues: string[]; // Explicit list
  latestExecutionError: LatestExecutionError | null;
  evaluation: {
    missingCredentials: string[];
    brokenConnections: number;
    disabledNodes: number;
    issues: string[];
  };
  schemas: Record<string, {
    type: string;
    version: number;
    description?: string;
    propertiesCount: number;
    truncated: boolean;
  }>;
  metadata: {
    totalNodes: number;
    uniqueNodeTypes: number;
    triggersCount: number;
    schemasTruncated: number;
  };
}

/**
 * Build context pack from workflow JSON
 */
export async function buildContextPack(
  workflow: N8nWorkflow,
  options: {
    maxNodes?: number;
    maxSchemaSize?: number;
    connectionId?: string;
    latestExecution?: LatestExecutionError | null;
  } = {}
): Promise<ContextPack> {
  const maxNodes = options.maxNodes || 300;
  const maxSchemaSize = options.maxSchemaSize || 5000; // chars per schema

  // Limit nodes if workflow is too large
  const limitedNodes = workflow.nodes.slice(0, maxNodes);
  const nodeTruncated = workflow.nodes.length > maxNodes;

  // Basic workflow metadata
  const workflowMeta = {
    id: workflow.id || '',
    name: workflow.name || 'Untitled',
    active: workflow.active || false,
    nodeCount: limitedNodes.length,
    connectionCount: Object.keys(workflow.connections || {}).length,
  };

  // Node summaries (safe, no secrets)
  const nodesSummary = limitedNodes.map((node: N8nNode) => ({
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion,
    disabled: node.disabled || false,
    position: node.position,
    hasCredentials: !!(node.credentials && Object.keys(node.credentials).length > 0),
  }));

  // Simple evaluation - check for missing credentials and disabled nodes
  const missingCredentials: string[] = [];
  const issues: string[] = [];
  
  limitedNodes.forEach((node: N8nNode) => {
    // Check if node requires credentials but doesn't have them
    if (node.type.includes('credentials') && (!node.credentials || Object.keys(node.credentials).length === 0)) {
      missingCredentials.push(`${node.name} (${node.type})`);
    }
    
    // Check for disabled nodes
    if (node.disabled) {
      issues.push(`Node "${node.name}" is disabled`);
    }
  });

  const evaluation = {
    missingCredentials,
    brokenConnections: 0, // TODO: Implement connection validation
    disabledNodes: limitedNodes.filter((n: N8nNode) => n.disabled === true).length,
    issues,
  };

  // Collect unique node types (no schema resolution for now - Phase 2 minimal)
  const uniqueTypes = new Set<string>();
  limitedNodes.forEach((node: N8nNode) => {
    uniqueTypes.add(`${node.type}@${node.typeVersion || 1}`);
  });

  const schemas: Record<string, {
    type: string;
    version: number;
    description?: string;
    propertiesCount: number;
    truncated: boolean;
  }> = {};

  const schemasTruncated = 0;
  
  // For Phase 2, we'll just collect type information without full schemas
  for (const typeKey of uniqueTypes) {
    const [nodeType, versionStr] = typeKey.split('@');
    const version = parseInt(versionStr, 10) || 1;
    
    schemas[typeKey] = {
      type: nodeType,
      version,
      description: `${nodeType} node (v${version})`,
      propertiesCount: 0,
      truncated: false,
    };
  }

  // Count trigger nodes
  const triggersCount = limitedNodes.filter((n: N8nNode) => 
    n.type.toLowerCase().includes('trigger') || n.type.includes('webhook')
  ).length;

  return {
    workflow: workflowMeta,
    nodes: nodesSummary,
    // Explicit arrays at top level for anti-hallucination
    missingCredentials: evaluation.missingCredentials,
    evaluationIssues: evaluation.issues,
    latestExecutionError: options.latestExecution || null,
    evaluation,
    schemas,
    metadata: {
      totalNodes: workflow.nodes.length,
      uniqueNodeTypes: uniqueTypes.size,
      triggersCount,
      schemasTruncated,
    },
  };
}

/**
 * Sanitize context pack for LLM consumption (remove any potential secrets)
 */
export function sanitizeContextPack(contextPack: ContextPack): ContextPack {
  // Context pack already excludes credentials/secrets by design
  // This is a safety layer for future-proofing
  
  return {
    ...contextPack,
    nodes: contextPack.nodes.map(node => ({
      ...node,
      // Ensure no credential details leak
      hasCredentials: node.hasCredentials,
    })),
  };
}

/**
 * Build system prompt for Ask mode (strict, anti-hallucination)
 */
export function buildSystemPrompt(contextPack: ContextPack, strict: boolean = false): string {
  const strictGuidelines = strict ? `

**CRITICAL ANTI-HALLUCINATION RULES:**
1. ONLY reference nodes that exist in the nodes[] array
2. NEVER claim missing credentials unless they are in missingCredentials[]
3. NEVER invent issues not present in evaluationIssues[] or latestExecutionError
4. citations[] MUST reference actual node names from the workflow
5. If you don't have information, say "I don't have information about X" - do NOT guess` : '';

  return `You are a helpful n8n workflow assistant. You help users understand and debug their n8n workflows.

**Current Workflow Context:**
- Name: ${contextPack.workflow.name}
- Status: ${contextPack.workflow.active ? 'Active' : 'Inactive'}
- Total Nodes: ${contextPack.nodes.length}
- Missing Credentials: ${contextPack.missingCredentials.length}
- Evaluation Issues: ${contextPack.evaluationIssues.length}
- Latest Execution Error: ${contextPack.latestExecutionError ? 'YES' : 'NO'}

**AVAILABLE NODES (only reference these):**
${contextPack.nodes.map(n => `- "${n.name}" (${n.type})`).join('\n')}

**MISSING CREDENTIALS (only these):**
${contextPack.missingCredentials.length > 0 ? contextPack.missingCredentials.join('\n') : 'NONE'}

**EVALUATION ISSUES (only these):**
${contextPack.evaluationIssues.length > 0 ? contextPack.evaluationIssues.join('\n') : 'NONE'}

**YOUR RESPONSE FORMAT (strict JSON):**
{
  "answer": "Clear, concise answer to the user's question",
  "topFixFirst": "Most important fix to apply (or null if no issues)",
  "issues": ["List of detected issues with specific node names"],
  "citations": ["List of node names referenced in your answer"]
}

**Guidelines:**
1. Keep answer under 3 paragraphs
2. Reference specific nodes by exact name from the nodes[] array
3. If issues exist, populate issues[] and citations[] arrays
4. citations[] should list every node name you mention in answer or issues
5. topFixFirst should be actionable and specific${strictGuidelines}`;
}

/**
 * Build user context string from context pack
 */
export function buildUserContext(contextPack: ContextPack): string {
  const lines: string[] = [];

  lines.push(`Workflow: "${contextPack.workflow.name}"`);
  lines.push(`Status: ${contextPack.workflow.active ? 'Active' : 'Inactive'}`);
  lines.push('');

  lines.push('**Nodes:**');
  contextPack.nodes.forEach(node => {
    const status = node.disabled ? '[DISABLED]' : '';
    const creds = node.hasCredentials ? '[HAS_CREDS]' : '[NO_CREDS]';
    lines.push(`- "${node.name}" (${node.type}) ${status} ${creds}`);
  });
  lines.push('');

  if (contextPack.evaluation.missingCredentials.length > 0) {
    lines.push('**Missing Credentials:**');
    contextPack.evaluation.missingCredentials.forEach(cred => {
      lines.push(`- ${cred}`);
    });
    lines.push('');
  }

  if (contextPack.evaluation.issues.length > 0) {
    lines.push('**Evaluation Issues:**');
    contextPack.evaluation.issues.slice(0, 10).forEach(issue => {
      lines.push(`- ${issue}`);
    });
    if (contextPack.evaluation.issues.length > 10) {
      lines.push(`... and ${contextPack.evaluation.issues.length - 10} more issues`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
