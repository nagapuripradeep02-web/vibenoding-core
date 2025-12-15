/**
 * V3.0 Workflow State Engine - Shared Types
 */

// n8n Workflow types (from n8n API)
export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: N8nNode[];
  connections: N8nConnections;
  settings?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  tags?: Array<{ id: string; name: string }>;
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  position: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  disabled?: boolean;
}

export interface N8nConnections {
  [nodeName: string]: {
    [outputType: string]: Array<Array<{ node: string; type: string; index: number }>>;
  };
}

// n8n Execution types
export interface N8nExecution {
  id: string;
  finished: boolean;
  mode: string;
  startedAt: string;
  stoppedAt?: string;
  workflowId: string;
  status: 'success' | 'error' | 'running' | 'waiting';
  data?: {
    resultData?: {
      runData?: Record<string, N8nNodeExecutionData[]>;
      error?: { message: string; stack?: string };
    };
  };
}

export interface N8nNodeExecutionData {
  startTime: number;
  executionTime: number;
  source: unknown[];
  executionStatus?: 'success' | 'error';
  error?: { message: string };
  data?: {
    main?: Array<Array<{ json: Record<string, unknown> }>>;
  };
}

// Workflow State Engine types
export interface NodeConfigured {
  credentials: boolean;
  placeholders: boolean;
  requiredFields: boolean;
}

export interface NodeVerified {
  status: 'success' | 'failed' | 'not_run';
  executionId?: string;
  error?: string;
}

export interface NodeMissing {
  credentials: string[];
  placeholders: string[];
  requiredFields: string[];
}

export interface NodeState {
  id: string;
  name: string;
  type: string;
  upstream: string[];
  configured: NodeConfigured;
  verified: NodeVerified;
  progress: number; // 0, 70, or 100
  missing: NodeMissing;
}

export interface WorkflowStateSummary {
  configuredNodesPct: number;
  verifiedNodesPct: number;
  credentialsReadyPct: number;
  placeholdersReadyPct: number;
  requiredFieldsReadyPct: number;
}

export interface WorkflowState {
  connectionId: string;
  workflowId: string;
  workflowUpdatedAt: string;
  nodes: NodeState[];
  summary: WorkflowStateSummary;
}

// Execution event from n8n (incoming webhook payload)
export interface ExecutionEventPayload {
  connectionId: string;
  workflowId: string;
  executionId: string;
  status: 'success' | 'error';
  ts?: string;
  meta?: Record<string, unknown>;
}

// Database row types
export interface ExecutionEventRow {
  id: string;
  user_id: string;
  connection_id: string;
  workflow_id: string;
  execution_id: string;
  status: 'success' | 'error';
  meta: Record<string, unknown>;
  created_at: string;
}

export interface WorkflowNodeStateRow {
  id: string;
  user_id: string;
  connection_id: string;
  workflow_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  configured_credentials: boolean;
  configured_placeholders: boolean;
  configured_required_fields: boolean;
  verified: boolean;
  failed: boolean;
  last_execution_id: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface NodeNoteRow {
  id: string;
  user_id: string;
  connection_id: string;
  workflow_id: string;
  node_id: string;
  user_note: string;
  updated_at: string;
}

// Credential hint for Complete tab pre-analysis
export interface CredentialHint {
  id: string;
  name: string;
  type: string;
  hasCredentials: boolean;
}

// Validation result
export interface ValidationResult {
  isValid: boolean;
  missing: string[];
}

