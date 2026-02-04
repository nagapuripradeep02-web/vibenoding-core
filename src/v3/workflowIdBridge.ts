/**
 * Workflow ID Bridge
 * 
 * Resolves Supabase workflow UUIDs to n8n workflow IDs for API calls.
 * 
 * Database Schema (from Supabase):
 * - workflows: { id (UUID), n8n_workflow_id (TEXT), project_id (UUID), ... }
 * - projects: { id (UUID), user_id (UUID), name, ... }
 * - workflow_node_state: { connection_id, workflow_id (TEXT - n8n ID), ... }
 */

import { supabaseAdmin } from '../lib/supabase';

// UUID v4 pattern (standard format)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolveWorkflowIdErrorCode = 
  | 'INVALID_INPUT' 
  | 'WORKFLOW_NOT_FOUND' 
  | 'MISSING_N8N_ID' 
  | 'USER_MISMATCH'
  | 'DB_ERROR';

export type ResolveWorkflowIdResult = 
  | { ok: true; n8nWorkflowId: string; supabaseWorkflowId: string | null; sourceTable: string; error?: never; code?: never }
  | { ok: false; error: string; code: ResolveWorkflowIdErrorCode; n8nWorkflowId?: never; supabaseWorkflowId?: never; sourceTable?: never };

export interface ResolveWorkflowIdParams {
  workflowId: string;
  connectionId: string;
  userId?: string; // Optional for user ownership validation
}

/**
 * Check if a string looks like a UUID v4
 */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Resolve a workflow ID to its n8n equivalent.
 * 
 * Strategy:
 * - If workflowId is NOT a UUID: assume it's already an n8n ID and return it
 * - If workflowId is a UUID: look up in Supabase tables to find n8n_workflow_id
 * 
 * Lookup order:
 * 1. workflows table (main source)
 * 
 * Security:
 * - If userId is provided, validates workflow ownership via projects.user_id
 */
export async function resolveN8nWorkflowId(
  params: ResolveWorkflowIdParams
): Promise<ResolveWorkflowIdResult> {
  const { workflowId, connectionId, userId } = params;
  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

  // Input validation
  if (!workflowId || typeof workflowId !== 'string') {
    return { ok: false, error: 'workflowId is required', code: 'INVALID_INPUT' };
  }

  if (!connectionId || typeof connectionId !== 'string') {
    return { ok: false, error: 'connectionId is required', code: 'INVALID_INPUT' };
  }

  // If NOT a UUID, assume it's already an n8n workflow ID
  if (!isUuid(workflowId)) {
    if (debugEnabled) {
      console.log('[workflowIdBridge] Non-UUID workflowId, treating as n8n ID:', workflowId);
    }
    return {
      ok: true,
      n8nWorkflowId: workflowId,
      supabaseWorkflowId: null,
      sourceTable: 'passthrough',
    };
  }

  // It's a UUID - look up in Supabase
  if (debugEnabled) {
    console.log('[workflowIdBridge] Resolving UUID:', workflowId.slice(0, 8) + '...');
  }

  try {
    // Query workflows table with optional user validation via projects join
    const { data: workflow, error } = await supabaseAdmin
      .from('workflows')
      .select(`
        id,
        n8n_workflow_id,
        project_id,
        projects (
          id,
          user_id
        )
      `)
      .eq('id', workflowId)
      .maybeSingle();

    if (error) {
      // Log the actual error server-side (safe - no secrets in this query)
      console.error('[workflowIdBridge] Supabase error:', error.message, error.code);
      return {
        ok: false,
        error: 'Database error while looking up workflow',
        code: 'DB_ERROR',
      };
    }

    if (!workflow) {
      if (debugEnabled) {
        console.log('[workflowIdBridge] Workflow not found:', workflowId.slice(0, 8) + '...');
      }
      return {
        ok: false,
        error: `Workflow not found: ${workflowId}`,
        code: 'WORKFLOW_NOT_FOUND',
      };
    }

    // Check if n8n_workflow_id exists
    if (!workflow.n8n_workflow_id) {
      if (debugEnabled) {
        console.log('[workflowIdBridge] Workflow missing n8n_workflow_id:', workflowId.slice(0, 8) + '...');
      }
      return {
        ok: false,
        error: 'Workflow does not have an n8n_workflow_id - it may be an uploaded workflow without n8n link',
        code: 'MISSING_N8N_ID',
      };
    }

    // Optional: Validate user ownership if userId is provided
    if (userId && workflow.projects) {
      const project = workflow.projects as unknown as { id: string; user_id: string | null };
      if (project.user_id && project.user_id !== userId) {
        if (debugEnabled) {
          console.log('[workflowIdBridge] User mismatch for workflow');
        }
        return {
          ok: false,
          error: 'Workflow does not belong to this user',
          code: 'USER_MISMATCH',
        };
      }
    }

    if (debugEnabled) {
      console.log('[workflowIdBridge] Resolved:', {
        supabaseId: workflowId.slice(0, 8) + '...',
        n8nId: workflow.n8n_workflow_id,
      });
    }

    return {
      ok: true,
      n8nWorkflowId: workflow.n8n_workflow_id,
      supabaseWorkflowId: workflowId,
      sourceTable: 'workflows',
    };

  } catch (e) {
    console.error('[workflowIdBridge] Unexpected error:', e instanceof Error ? e.message : e);
    return {
      ok: false,
      error: 'Failed to resolve workflow ID',
      code: 'DB_ERROR',
    };
  }
}

/**
 * Convenience function that throws on error (for simpler control flow)
 */
export async function resolveN8nWorkflowIdOrThrow(
  params: ResolveWorkflowIdParams
): Promise<{ n8nWorkflowId: string; supabaseWorkflowId: string | null; sourceTable: string }> {
  const result = await resolveN8nWorkflowId(params);
  if (result.ok === false) {
    const err = new Error(result.error) as Error & { code: string };
    err.code = result.code;
    throw err;
  }
  return {
    n8nWorkflowId: result.n8nWorkflowId,
    supabaseWorkflowId: result.supabaseWorkflowId,
    sourceTable: result.sourceTable,
  };
}

/**
 * Check if the Supabase client is properly configured.
 * Call this at startup to fail fast if env is missing.
 */
export function validateSupabaseConfig(): void {
  if (!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL environment variable is required');
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
  }
}
