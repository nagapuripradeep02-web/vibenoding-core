/**
 * V3.0 Workflow State Builder
 * Computes per-node configuration status and verification state
 */

import type {
  N8nWorkflow,
  N8nExecution,
  N8nNode,
  N8nNodeExecutionData,
  NodeState,
  WorkflowState,
  WorkflowStateSummary,
} from './types';
import { computeUpstreamDependencies } from './graph';
import { validateNode } from './validators';

type ParsedNodeExecution = {
  status: 'success' | 'failed';
  error?: string;
};

function getExecutionResultData(execution: unknown): {
  runData: Record<string, unknown>;
  topError: any | null;
  includeDataReturnedRunData: boolean;
} {
  const exec: any = execution as any;
  // Try multiple paths for resultData (different n8n API shapes)
  const rd = exec?.data?.resultData ?? exec?.resultData ?? exec?.data?.data?.resultData ?? null;
  const runData = (rd?.runData ?? {}) as Record<string, unknown>;
  const topError = (rd?.error ?? null) as any;
  
  // Check if includeData=true was effective (has runData or error structure)
  const includeDataReturnedRunData = !!rd && (Object.keys(runData).length > 0 || !!topError);
  
  return {
    runData,
    topError,
    includeDataReturnedRunData,
  };
}

function pickErrorMessage(err: any): string | undefined {
  if (!err) return undefined;
  
  // Try multiple paths for error message
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  if (Array.isArray(err.messages) && typeof err.messages[0] === 'string') return err.messages[0];
  if (typeof err.name === 'string') return err.name;
  if (typeof err.toString === 'function') {
    try {
      const str = err.toString();
      if (str !== '[object Object]') return str;
    } catch {}
  }
  
  return undefined;
}

function pickErrorNodeName(err: any): string | undefined {
  if (!err) return undefined;
  return (
    (typeof err?.node?.name === 'string' ? err.node.name : undefined) ??
    (typeof err?.node === 'string' ? err.node : undefined) ??
    (typeof err?.context?.node?.name === 'string' ? err.context.node.name : undefined)
  );
}

function parseSubNodeNameFromMessage(message?: string): string | undefined {
  if (!message) return undefined;
  const m1 = message.match(/sub-node\s+'([^']+)'/i);
  if (m1?.[1]) return m1[1];
  const m2 = message.match(/sub-node\s+\"([^\"]+)\"/i);
  if (m2?.[1]) return m2[1];
  return undefined;
}

/**
 * Extract error from node execution run data (robust, checks multiple paths)
 */
function extractNodeError(run: N8nNodeExecutionData): string | undefined {
  // Check multiple error paths
  if (run.error) {
    return pickErrorMessage(run.error);
  }
  // Check data.error (if it exists in the type)
  const dataAny = run.data as any;
  if (dataAny?.error) {
    return pickErrorMessage(dataAny.error);
  }
  // Check nested error in main array
  if (dataAny?.main?.[0]?.[0]?.error) {
    return pickErrorMessage(dataAny.main[0][0].error);
  }
  if (run.executionStatus === 'error') {
    return 'Node execution failed';
  }
  return undefined;
}

/**
 * Parse execution data to get per-node status
 * @param execution - Execution data from n8n
 * @param workflowNodes - Optional workflow nodes for validation (warns on unmatched runData keys)
 */
function parseNodeExecutionResults(
  execution: N8nExecution | null | undefined,
  workflowNodes?: N8nNode[]
): Map<string, ParsedNodeExecution> {
  const results = new Map<string, ParsedNodeExecution>();

  const { runData, topError } = getExecutionResultData(execution);
  const runDataObj = runData || {};
  const topErrorMessage = pickErrorMessage(topError);
  const topErrorNodeName = pickErrorNodeName(topError);
  const topErrorSubNodeName = parseSubNodeNameFromMessage(topErrorMessage);

  // Build workflow node name set for validation
  const workflowNodeNames = workflowNodes ? new Set(workflowNodes.map((n) => n.name)) : null;

  // From runData entries (keys are node names, not IDs)
  for (const [nodeName, nodeExecutions] of Object.entries(runDataObj)) {
    if (!Array.isArray(nodeExecutions) || nodeExecutions.length === 0) continue;

    // Warn if runData key doesn't match any workflow node name
    if (workflowNodeNames && !workflowNodeNames.has(nodeName)) {
      console.warn('[workflowState] runData key does not match workflow node name:', {
        runDataKey: nodeName,
        workflowNodeNames: Array.from(workflowNodeNames),
      });
    }

    const lastExecution = nodeExecutions[nodeExecutions.length - 1] as N8nNodeExecutionData;
    const errorMsg = extractNodeError(lastExecution);

    if (errorMsg) {
      results.set(nodeName, { status: 'failed', error: errorMsg });
    } else {
      results.set(nodeName, { status: 'success' });
    }
  }

  // From workflow-level error (covers nodes missing from runData)
  if (topErrorNodeName) {
    const cur = results.get(topErrorNodeName);
    if (!cur || cur.status !== 'failed') {
      results.set(topErrorNodeName, { status: 'failed', error: topErrorMessage || 'Execution failed' });
    }
  }

  // Sub-node special case (AI Agent): mark both parent and sub-node
  if (topErrorSubNodeName) {
    const errMsg = topErrorMessage || 'Execution failed';
    if (topErrorNodeName) results.set(topErrorNodeName, { status: 'failed', error: errMsg });
    results.set(topErrorSubNodeName, { status: 'failed', error: errMsg });
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
  const allConfigured = configured.credentials && configured.placeholders && configured.requiredFields;

  if (!allConfigured) return 0;
  if (verified.status === 'success') return 100;
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
  const nodeExecutionResults = parseNodeExecutionResults(execution, nodes);
  const executionRunAt = execution ? (execution.stoppedAt || execution.startedAt) : undefined;

  const nodeStates: NodeState[] = nodes.map((node) => {
    const validation = validateNode(node);
    const execResult = nodeExecutionResults.get(node.name);

    const configured = {
      credentials: validation.credentials.isValid,
      placeholders: validation.placeholders.isValid,
      requiredFields: validation.requiredFields.isValid,
    };

    let verified: { status: 'success' | 'failed' | 'not_run'; executionId?: string; runAt?: string; error?: string };

    if (execResult) {
      verified = {
        status: execResult.status,
        executionId: execution?.id,
        runAt: executionRunAt,
        error: execResult.error,
      };
    } else {
      verified = { status: 'not_run' };
    }

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

  const summary = calculateSummary(nodeStates);

  return {
    connectionId,
    workflowId,
    workflowUpdatedAt: workflow.updatedAt || new Date().toISOString(),
    nodes: nodeStates,
    summary,
  };
}

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

    const allConfigured = node.configured.credentials && node.configured.placeholders && node.configured.requiredFields;
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
export function mergeExecutionIntoState(currentState: WorkflowState, execution: N8nExecution): WorkflowState {
  // Rebuild workflow nodes from current state for validation
  const workflowNodes: N8nNode[] = currentState.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    position: [0, 0], // Not needed for parsing
  }));
  const nodeExecutionResults = parseNodeExecutionResults(execution, workflowNodes);
  const executionRunAt = execution ? (execution.stoppedAt || execution.startedAt) : undefined;

  const updatedNodes = currentState.nodes.map((node) => {
    const execResult = nodeExecutionResults.get(node.name);

    if (!execResult) return node;

    const verified = {
      status: execResult.status,
      executionId: execution.id,
      runAt: executionRunAt,
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
