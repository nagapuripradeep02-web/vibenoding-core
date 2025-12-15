/**
 * V3.0 Workflow State Builder
 * Computes per-node configuration status and verification state
 */

import type {
  N8nWorkflow,
  N8nExecution,
  N8nNodeExecutionData,
  NodeState,
  WorkflowState,
  WorkflowStateSummary,
} from './types';
import { computeUpstreamDependencies } from './graph';
import { validateNode } from './validators';

/**
 * Parse execution data to get per-node status
 */
function parseNodeExecutionResults(
  execution: N8nExecution | null | undefined
): Map<string, { status: 'success' | 'failed'; error?: string }> {
  const results = new Map<string, { status: 'success' | 'failed'; error?: string }>();
  
  if (!execution?.data?.resultData?.runData) {
    return results;
  }
  
  const runData = execution.data.resultData.runData;
  
  for (const [nodeName, nodeExecutions] of Object.entries(runData)) {
    if (!Array.isArray(nodeExecutions) || nodeExecutions.length === 0) continue;
    
    // Check the last execution of this node
    const lastExecution = nodeExecutions[nodeExecutions.length - 1] as N8nNodeExecutionData;
    
    if (lastExecution.error) {
      results.set(nodeName, {
        status: 'failed',
        error: lastExecution.error.message || 'Unknown error',
      });
    } else if (lastExecution.executionStatus === 'error') {
      results.set(nodeName, {
        status: 'failed',
        error: 'Node execution failed',
      });
    } else {
      results.set(nodeName, { status: 'success' });
    }
  }
  
  return results;
}

/**
 * Calculate node progress percentage
 * - 0% if any configured check is false
 * - 70% if all 3 configured checks true but not verified
 * - 100% if verified with success
 */
function calculateProgress(
  configured: { credentials: boolean; placeholders: boolean; requiredFields: boolean },
  verified: { status: 'success' | 'failed' | 'not_run' }
): number {
  // Check if all configured checks pass
  const allConfigured = configured.credentials && configured.placeholders && configured.requiredFields;
  
  if (!allConfigured) {
    return 0;
  }
  
  if (verified.status === 'success') {
    return 100;
  }
  
  // Configured but not verified (or failed)
  return 70;
}

/**
 * Build complete workflow state
 */
export function buildWorkflowState(
  connectionId: string,
  workflowId: string,
  workflow: N8nWorkflow,
  execution?: N8nExecution | null
): WorkflowState {
  const nodes = workflow.nodes || [];
  const upstreamMap = computeUpstreamDependencies(workflow);
  const nodeExecutionResults = parseNodeExecutionResults(execution);
  
  // Build per-node state
  const nodeStates: NodeState[] = nodes.map(node => {
    // Get validation results
    const validation = validateNode(node);
    
    // Get execution result for this node (by name)
    const execResult = nodeExecutionResults.get(node.name);
    
    // Determine configured status (true = OK, no issues)
    const configured = {
      credentials: validation.credentials.isValid,
      placeholders: validation.placeholders.isValid,
      requiredFields: validation.requiredFields.isValid,
    };
    
    // Determine verified status
    let verified: { status: 'success' | 'failed' | 'not_run'; executionId?: string; error?: string };
    
    if (execResult) {
      verified = {
        status: execResult.status,
        executionId: execution?.id,
        error: execResult.error,
      };
    } else {
      verified = { status: 'not_run' };
    }
    
    // Calculate progress
    const progress = calculateProgress(configured, verified);
    
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      upstream: upstreamMap.get(node.id) || [],
      configured,
      verified,
      progress,
      missing: {
        credentials: validation.credentials.missing,
        placeholders: validation.placeholders.missing,
        requiredFields: validation.requiredFields.missing,
      },
    };
  });
  
  // Calculate summary statistics
  const summary = calculateSummary(nodeStates);
  
  return {
    connectionId,
    workflowId,
    workflowUpdatedAt: workflow.updatedAt || new Date().toISOString(),
    nodes: nodeStates,
    summary,
  };
}

/**
 * Calculate summary statistics
 */
function calculateSummary(nodeStates: NodeState[]): WorkflowStateSummary {
  const total = nodeStates.length;
  
  if (total === 0) {
    return {
      configuredNodesPct: 100,
      verifiedNodesPct: 100,
      credentialsReadyPct: 100,
      placeholdersReadyPct: 100,
      requiredFieldsReadyPct: 100,
    };
  }
  
  let configuredCount = 0;
  let verifiedCount = 0;
  let credentialsReadyCount = 0;
  let placeholdersReadyCount = 0;
  let requiredFieldsReadyCount = 0;
  
  for (const node of nodeStates) {
    if (node.configured.credentials) credentialsReadyCount++;
    if (node.configured.placeholders) placeholdersReadyCount++;
    if (node.configured.requiredFields) requiredFieldsReadyCount++;
    
    const allConfigured = node.configured.credentials &&
                          node.configured.placeholders &&
                          node.configured.requiredFields;
    if (allConfigured) configuredCount++;
    
    if (node.verified.status === 'success') verifiedCount++;
  }
  
  return {
    configuredNodesPct: Math.round((configuredCount / total) * 100),
    verifiedNodesPct: Math.round((verifiedCount / total) * 100),
    credentialsReadyPct: Math.round((credentialsReadyCount / total) * 100),
    placeholdersReadyPct: Math.round((placeholdersReadyCount / total) * 100),
    requiredFieldsReadyPct: Math.round((requiredFieldsReadyCount / total) * 100),
  };
}

/**
 * Merge execution results into existing state (for incremental updates)
 */
export function mergeExecutionIntoState(
  currentState: WorkflowState,
  execution: N8nExecution
): WorkflowState {
  const nodeExecutionResults = parseNodeExecutionResults(execution);
  
  const updatedNodes = currentState.nodes.map(node => {
    const execResult = nodeExecutionResults.get(node.name);
    
    if (!execResult) {
      return node; // No change
    }
    
    const verified = {
      status: execResult.status,
      executionId: execution.id,
      error: execResult.error,
    };
    
    const progress = calculateProgress(node.configured, verified);
    
    return {
      ...node,
      verified,
      progress,
    };
  });
  
  return {
    ...currentState,
    nodes: updatedNodes,
    summary: calculateSummary(updatedNodes),
  };
}

