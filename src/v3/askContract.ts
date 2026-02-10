/**
 * Phase 2A: AskContract Types
 * Defines the structured response format for /api/v3/assist/ask
 * 
 * Goals:
 * - Deterministic, reproducible outputs
 * - Strong issue ranking with clear priorities
 * - Citations with provenance for debugging
 * - Budget/timing transparency
 */

// Issue severity levels (ranked from most to least critical)
export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

// Issue codes for categorization and stable sorting
export type IssueCode =
  | 'MISSING_CREDENTIAL'
  | 'NODE_AUTH_ERROR'
  | 'NODE_CONFIG_ERROR'
  | 'MISSING_REQUIRED_FIELD'
  | 'UPSTREAM_DATA_MISSING'
  | 'CONNECTION_BROKEN'
  | 'NODE_DISABLED'
  | 'EXECUTION_ERROR'
  | 'SCHEMA_VALIDATION_ERROR'
  | 'UNKNOWN';

/**
 * Structured issue format with evidence and actions
 */
export interface AskIssue {
  issue_code: IssueCode;
  severity: IssueSeverity;
  node_locator: string;         // node.name or node.id for UI linking
  summary: string;              // Human-readable summary
  evidence: string[];           // References to facts (execution logs, schema, workflow)
  suggested_actions: string[];  // Actionable fix suggestions
}

/**
 * Citation kinds for provenance tracking
 */
export type CitationKind = 'execution' | 'schema' | 'workflow' | 'doctor';

/**
 * Citation with source reference
 */
export interface AskCitation {
  kind: CitationKind;
  ref: string;                  // e.g., "exec:123#nodeA", "schema:HttpRequest@4"
  node_locator?: string;        // Optional node reference
}

/**
 * Budget limits for Ask mode
 */
export interface AskBudgets {
  max_tokens: number;
  max_tool_calls: number;
  max_seconds: number;
  temperature: number;
}

/**
 * Timing breakdown for debugging
 */
export interface AskTimings {
  total: number;
  fetch_workflow: number;
  resolve_schemas: number;
  analyze: number;
  llm: number;
}

/**
 * Debug information for transparency
 */
export interface AskDebug {
  analyzed_source: 'prod' | 'test';
  workflow_uuid: string;
  n8n_workflow_id?: string;
  workflow_updated_at_from_n8n?: string;
  resolver_stats?: unknown;
  budgets: AskBudgets;
  timings_ms: AskTimings;
}

/**
 * TopFixFirst: the highest priority issue to fix
 */
export interface TopFixFirst {
  issue_code: IssueCode;
  severity: IssueSeverity;
  node_locator: string;
  why_now: string;              // Explanation of why this is the top priority
  suggested_action: string;     // Single most important action to take
}

/**
 * Full AskContract response
 */
export interface AskContractResponse {
  ok: boolean;
  answer: string;
  topFixFirst: TopFixFirst | null;
  issues: AskIssue[];
  citations: AskCitation[];
  debug: AskDebug;
}

/**
 * Error response when ok=false
 */
export interface AskErrorResponse {
  ok: false;
  error: string;
  details?: string;
  debug?: Partial<AskDebug>;
}

/**
 * Default budget constants for Ask mode
 */
export const ASK_BUDGETS: AskBudgets = {
  max_tokens: 2000,
  max_tool_calls: 1,    // Ask mode uses single LLM call
  max_seconds: 30,
  temperature: 0,       // Deterministic
};

/**
 * Create empty timings object
 */
export function createEmptyTimings(): AskTimings {
  return {
    total: 0,
    fetch_workflow: 0,
    resolve_schemas: 0,
    analyze: 0,
    llm: 0,
  };
}

/**
 * Create empty debug object with defaults
 */
export function createEmptyDebug(workflowUuid: string): AskDebug {
  return {
    analyzed_source: 'prod',
    workflow_uuid: workflowUuid,
    budgets: { ...ASK_BUDGETS },
    timings_ms: createEmptyTimings(),
  };
}
