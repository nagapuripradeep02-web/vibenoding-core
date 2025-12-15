/**
 * V3.0 n8n API Client
 * Reusable functions to call n8n API using connection credentials
 */

import { supabaseAdmin } from '../lib/supabase';
import type { N8nWorkflow, N8nExecution } from './types';

interface ConnectionCredentials {
  base_url: string;
  api_key_encrypted: string;
}

interface ClientResult<T> {
  data?: T;
  error?: { status: number; message: string; details?: string };
}

/**
 * Get connection credentials from Supabase
 */
async function getConnectionCredentials(connectionId: string): Promise<ClientResult<ConnectionCredentials>> {
  const { data, error } = await supabaseAdmin
    .from('n8n_connections')
    .select('base_url, api_key_encrypted')
    .eq('id', connectionId)
    .single();

  if (error || !data) {
    return { error: { status: 404, message: 'Connection not found' } };
  }

  if (!data.base_url || !data.api_key_encrypted) {
    return { error: { status: 400, message: 'Connection missing base_url or api_key' } };
  }

  return { data: { base_url: data.base_url, api_key_encrypted: data.api_key_encrypted } };
}

/**
 * Make authenticated request to n8n API
 */
async function n8nFetch<T>(
  credentials: ConnectionCredentials,
  endpoint: string
): Promise<ClientResult<T>> {
  const url = `${credentials.base_url.replace(/\/$/, '')}${endpoint}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-N8N-API-KEY': credentials.api_key_encrypted,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        error: {
          status: response.status,
          message: `n8n API error: ${response.status}`,
          details: errorText,
        },
      };
    }

    const data = await response.json() as T;
    return { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return { error: { status: 500, message: 'Failed to connect to n8n', details: message } };
  }
}

/**
 * Get workflow by ID
 */
export async function getWorkflow(
  connectionId: string,
  workflowId: string
): Promise<ClientResult<N8nWorkflow>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  return n8nFetch<N8nWorkflow>(credResult.data!, `/api/v1/workflows/${workflowId}`);
}

/**
 * Get execution by ID
 */
export async function getExecution(
  connectionId: string,
  executionId: string
): Promise<ClientResult<N8nExecution>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  // n8n API endpoint for execution details
  // Try /api/v1/executions/:id first (newer n8n versions)
  const result = await n8nFetch<N8nExecution>(
    credResult.data!,
    `/api/v1/executions/${executionId}`
  );

  return result;
}

/**
 * List recent executions for a workflow (fallback polling)
 */
export async function listRecentExecutions(
  connectionId: string,
  workflowId: string,
  limit: number = 5
): Promise<ClientResult<N8nExecution[]>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  // n8n API for listing executions filtered by workflow
  const result = await n8nFetch<{ data: N8nExecution[] }>(
    credResult.data!,
    `/api/v1/executions?workflowId=${workflowId}&limit=${limit}`
  );

  if (result.error) return { error: result.error };

  return { data: result.data?.data || [] };
}

/**
 * Get user_id associated with a connection
 */
export async function getConnectionUserId(connectionId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('n8n_connections')
    .select('user_id')
    .eq('id', connectionId)
    .single();

  if (error || !data) return null;
  return data.user_id;
}

