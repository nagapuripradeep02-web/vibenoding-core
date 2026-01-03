/**
 * V3.1 Node Library Types
 * Types for canonical n8n node knowledge and error patterns
 */

import type { NodeInspectResponse } from './types';

// ============================================================================
// Node Library Types
// ============================================================================

/**
 * Canonical node type definition from the node library
 */
export interface NodeLibraryNode {
  node_type: string;
  display_name: string;
  category: string;
  description: string;
  docs_url: string | null;
  credential_types: string[] | null;
  config_schema: Record<string, unknown> | null;
  input_hints: Record<string, unknown> | null;
  output_hints: Record<string, unknown> | null;
  troubleshooting: Record<string, unknown> | null;
  search_text?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Error pattern matchers
 */
export interface ErrorPatternMatchers {
  contains?: string[];
  regex?: string;
  httpCode?: number[];
}

/**
 * Common error pattern for a node type
 */
export interface NodeLibraryErrorPattern {
  id: string;
  node_type: string;
  title: string;
  matchers: ErrorPatternMatchers | null;
  explanation: string;
  fix_steps: string;
  tags: string[] | null;
  severity: 'info' | 'warning' | 'error';
  created_at?: string;
}

/**
 * Simplified node definition for search results
 */
export interface NodeLibrarySearchResult {
  node_type: string;
  display_name: string;
  category: string;
  description: string;
}

/**
 * Full node definition with error patterns
 */
export interface NodeLibraryNodeWithPatterns {
  nodeDefinition: NodeLibraryNode | null;
  errorPatterns: NodeLibraryErrorPattern[];
}

// ============================================================================
// Workflow Node Types
// ============================================================================

/**
 * Workflow node linking to node library
 */
export interface WorkflowNode {
  connection_id: string;
  workflow_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  node_type_version?: number | null;
  node_package_version?: string | null;
  is_subnode: boolean;
  params_summary?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

// ============================================================================
// Context Pack Types
// ============================================================================

/**
 * Workflow node state from database
 */
export interface WorkflowNodeStateForContext {
  status: 'success' | 'failed' | 'not_run';
  last_error: string | null;
  last_run_at: string | null;
  last_execution_id: string | null;
  updated_at: string;
}

/**
 * Context pack metadata
 */
export interface NodeContextMeta {
  connectionId: string;
  workflowId: string;
  nodeId: string;
  executionId?: string;
}

/**
 * Library section of context pack
 */
export interface NodeContextLibrary {
  nodeDefinition: NodeLibraryNode; // Never null (stub if missing)
  errorPatterns: NodeLibraryErrorPattern[];
  matchedPattern: NodeLibraryErrorPattern | null;
  resolvedSchemaSource?: 'override' | 'canonical' | 'canonical_nearest_lower' | 'canonical_legacy' | 'none';
  resolvedSchema?: Record<string, unknown> | null;
}

/**
 * Complete context pack for LLM consumption
 * Merges runtime error info with library knowledge
 */
export interface NodeContextPack {
  meta: NodeContextMeta;
  workflowNode: {
    node_id: string;
    node_name: string;
    node_type: string;
    nodeTypeVersion?: number | null;
    is_subnode: boolean;
    is_executable: boolean;
  } | null;
  state: WorkflowNodeStateForContext | null;
  inspect: NodeInspectResponse | null;
  library: NodeContextLibrary;
}

// ============================================================================
// Seed Data Types
// ============================================================================

/**
 * Node definition in seed JSON format
 */
export interface NodeLibrarySeedNode {
  node_type: string;
  display_name: string;
  category: string;
  description: string;
  docs_url?: string;
  credential_types?: string[];
  config_schema?: Record<string, unknown>;
  input_hints?: Record<string, unknown>;
  output_hints?: Record<string, unknown>;
  troubleshooting?: Record<string, unknown>;
  error_patterns?: Array<{
    title: string;
    matchers?: ErrorPatternMatchers;
    explanation: string;
    fix_steps: string;
    tags?: string[];
    severity?: 'info' | 'warning' | 'error';
  }>;
}

/**
 * Complete seed data structure
 */
export interface NodeLibrarySeedData {
  version: string;
  nodes: NodeLibrarySeedNode[];
}

