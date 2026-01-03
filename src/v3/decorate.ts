import type { WorkflowState } from './types';

export type DecoratedNodeState = WorkflowState['nodes'][number] & {
  // frontend matching fields
  nodeKey: string;
  nodeId: string | null;

  // deterministic status fields for UI rendering
  node_id: string | null;
  node_name: string;
  status: 'success' | 'failed' | 'not_run';
  last_error: string | null;
  last_execution_id: string | null;
  last_run_at: string | null;
  updated_at: string;
};

export type ExecutionDebug = {
  latestExecutionId: string | null;
  latestExecutionStatus: string | null;
  runDataKeys: string[];
  matchedNodeNames: string[];
  unmatchedRunDataKeys: string[];
  hasRunData: boolean;
  includeDataReturnedRunData: boolean;
  topErrorNode: string | null;
  topErrorMessage: string | null;
};

export type DecoratedWorkflowState = WorkflowState & {
  nodes: DecoratedNodeState[];
  debug: {
    nodesCount: number;
    firstNodeKey?: string;
    firstNodeId?: string | null;
    execution?: ExecutionDebug;
  };
};

export function decorateStateForUi(baseState: WorkflowState, executionDebug?: ExecutionDebug): DecoratedWorkflowState {
  const nowIso = new Date().toISOString();

  const nodes: DecoratedNodeState[] = (baseState.nodes || []).map((n) => ({
    ...(n as any),

    // frontend matching fields
    nodeKey: n.name,
    nodeId: n.id ?? null,

    // deterministic status fields for UI rendering
    node_id: n.id ?? null,
    node_name: n.name,
    status: n.verified.status,
    last_error: n.verified.error ?? null,
    last_execution_id: n.verified.executionId ?? null,
    last_run_at: n.verified.runAt ?? null,
    updated_at: nowIso,
  }));

  return {
    ...(baseState as any),
    nodes,
    debug: {
      nodesCount: nodes.length,
      firstNodeKey: nodes[0]?.nodeKey,
      firstNodeId: nodes[0]?.nodeId,
      ...(executionDebug ? { execution: executionDebug } : {}),
    },
  };
}


