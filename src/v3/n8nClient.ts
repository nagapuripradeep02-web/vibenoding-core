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

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'n8nClient.ts:48',message:'n8nFetch request',data:{url:url.replace(/\/\/.*@/, '//***@'),endpoint},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-N8N-API-KEY': credentials.api_key_encrypted,
        'Accept': 'application/json',
      },
    });

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'n8nClient.ts:60',message:'n8nFetch response',data:{status:response.status,statusText:response.statusText,contentType:response.headers.get('content-type'),endpoint},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

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
 * Explicitly requests includeData=true to get full runData for node-level status parsing
 */
export async function getExecution(
  connectionId: string,
  executionId: string
): Promise<ClientResult<N8nExecution>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  // Request full execution data with runData (required for node-level status)
  const withData = await n8nFetch<N8nExecution>(
    credResult.data!,
    `/api/v1/executions/${executionId}?includeData=true`
  );

  if (withData.error) {
    // Fallback: try without includeData for older n8n versions that don't support it
    console.warn('[n8nClient] includeData=true failed, trying without:', withData.error.message);
    return n8nFetch<N8nExecution>(
      credResult.data!,
      `/api/v1/executions/${executionId}`
    );
  }

  return withData;
}

/**
 * List recent executions for a workflow (fallback polling)
 */
export async function listRecentExecutions(
  connectionId: string,
  workflowId: string,
  limit: number = 5,
  options?: { includeData?: boolean }
): Promise<ClientResult<N8nExecution[]>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  const params = new URLSearchParams();
  params.set('workflowId', workflowId);
  params.set('limit', String(limit));
  // If supported by your n8n version, this keeps the list call light.
  if (options?.includeData === false) {
    params.set('includeData', 'false');
  }

  // n8n API for listing executions filtered by workflow
  const result = await n8nFetch<{ data: N8nExecution[] }>(
    credResult.data!,
    `/api/v1/executions?${params.toString()}`
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

/**
 * Compute root URL from base_url (strip /api/v1 if present)
 */
function computeRootUrl(baseUrl: string): string {
  let root = baseUrl.replace(/\/$/, '');
  // Strip /api/v1 if present
  if (root.endsWith('/api/v1')) {
    root = root.slice(0, -7);
  }
  return root;
}

/**
 * Discover the node catalog endpoint by trying common paths
 * Returns the endpoint path (not full URL) and root URL separately
 */
export async function discoverNodeCatalogEndpoint(
  connectionId: string
): Promise<ClientResult<{ endpoint: string; rootUrl: string }>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  const rootUrl = computeRootUrl(credResult.data!.base_url);
  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

  // Allow override via env var
  const overrideEndpoint = process.env.N8N_NODE_TYPES_ENDPOINT;
  if (overrideEndpoint) {
    if (debugEnabled) {
      console.log(`[n8nClient] Using override endpoint: ${overrideEndpoint}`);
    }
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'n8nClient.ts:173',message:'Using override endpoint',data:{endpoint:overrideEndpoint,rootUrl},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    return { data: { endpoint: overrideEndpoint, rootUrl } };
  }

  // Try endpoints in specified order (stop on first JSON success)
  const endpoints = [
    '/rest/node-types',
    '/rest/credential-types',
    '/rest/types/nodes.json',
    '/types/nodes.json',
    '/rest/types/credentials.json',
    '/types/credentials.json',
  ];

  if (debugEnabled) {
    console.log(`[n8nClient] Starting endpoint discovery, rootUrl: ${rootUrl}`);
  }
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'n8nClient.ts:190',message:'Starting endpoint discovery',data:{rootUrl,baseUrl:credResult.data!.base_url,endpointCount:endpoints.length,endpoints},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion

  for (const endpoint of endpoints) {
    if (debugEnabled) {
      console.log(`[n8nClient] Trying node catalog endpoint: ${endpoint}`);
    }

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'n8nClient.ts:195',message:'Attempting endpoint',data:{endpoint,rootUrl},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    // Build full URL using root (not base_url with /api/v1)
    const url = `${rootUrl}${endpoint}`;
    
    try {
      // Use same auth as workflow sync
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-N8N-API-KEY': credResult.data!.api_key_encrypted,
          'Accept': 'application/json',
        },
      });
      
      const contentType = response.headers.get('content-type') || '';
      const status = response.status;
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'n8nClient.ts:227',message:'Endpoint response',data:{endpoint,status,statusText:response.statusText,contentType,isRedirect:status >= 300 && status < 400,isHtml:contentType.includes('text/html')},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      if (debugEnabled) {
        console.log(`[n8nClient] ${endpoint}: status=${status}, contentType=${contentType}`);
      }
      
      // Treat text/html or redirects as auth failure
      if (contentType.includes('text/html') || (status >= 300 && status < 400)) {
        if (debugEnabled) {
          console.log(`[n8nClient] ${endpoint}: Auth failure (html/redirect), skipping`);
        }
        continue;
      }
      
      if (!response.ok) {
        if (debugEnabled) {
          console.log(`[n8nClient] ${endpoint}: Failed with status ${status}`);
        }
        continue;
      }
      
      // Try to parse as JSON
      let data: unknown;
      try {
        data = await response.json();
      } catch (parseError) {
        if (debugEnabled) {
          console.log(`[n8nClient] ${endpoint}: Failed to parse JSON`);
        }
        continue;
      }
      
      // Check if we have valid data (array or object with data/nodeTypes)
      const isValid = Array.isArray(data) || 
        (data && typeof data === 'object' && (
          Array.isArray((data as any).data) || 
          Array.isArray((data as any).nodeTypes)
        ));
      
      if (!isValid) {
        if (debugEnabled) {
          console.log(`[n8nClient] ${endpoint}: Response is not a valid node catalog format`);
        }
        continue;
      }
      
      // Success!
      if (debugEnabled) {
        const nodeCount = Array.isArray(data) ? data.length : 
          (Array.isArray((data as any).data) ? (data as any).data.length :
          (Array.isArray((data as any).nodeTypes) ? (data as any).nodeTypes.length : 0));
        console.log(`[n8nClient] Found working endpoint: ${endpoint} (${nodeCount} items)`);
      }
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'n8nClient.ts:230',message:'Selected working endpoint',data:{endpoint,rootUrl,contentType},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      return { data: { endpoint, rootUrl } };
    } catch (err) {
      if (debugEnabled) {
        console.log(`[n8nClient] ${endpoint}: Network error:`, err instanceof Error ? err.message : String(err));
      }
      continue;
    }
  }

  return { error: { status: 404, message: 'No working node catalog endpoint found' } };
}

/**
 * Get node catalog from n8n API
 * Returns array of node type definitions
 */
export async function getNodeCatalog(
  connectionId: string
): Promise<ClientResult<{ nodes: unknown[]; credentialTypes?: unknown[]; endpoint: string }>> {
  const endpointResult = await discoverNodeCatalogEndpoint(connectionId);
  if (endpointResult.error) return { error: endpointResult.error };

  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  const { endpoint, rootUrl } = endpointResult.data!;
  const url = `${rootUrl}${endpoint}`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-N8N-API-KEY': credResult.data!.api_key_encrypted,
        'Accept': 'application/json',
      },
    });
    
    if (!response.ok) {
      return {
        error: {
          status: response.status,
          message: `n8n API error: ${response.status}`,
          details: await response.text().catch(() => 'Unknown error'),
        },
      };
    }
    
    const data = await response.json() as { data?: unknown[]; nodeTypes?: unknown[] } | unknown[];
    
    // Extract node types array
    let nodes: unknown[] = [];
    if (Array.isArray(data)) {
      nodes = data;
    } else if (data && typeof data === 'object') {
      nodes = (data as any).data || (data as any).nodeTypes || [];
    }
    
    // If this was credential-types endpoint, try to get node-types too
    let credentialTypes: unknown[] | undefined = undefined;
    if (endpoint.includes('credential-types')) {
      // Try to fetch node-types separately
      const nodeTypesUrl = `${rootUrl}/rest/node-types`;
      try {
        const nodeTypesResponse = await fetch(nodeTypesUrl, {
          method: 'GET',
          headers: {
            'X-N8N-API-KEY': credResult.data!.api_key_encrypted,
            'Accept': 'application/json',
          },
        });
        if (nodeTypesResponse.ok) {
          const nodeTypesData = await nodeTypesResponse.json() as { data?: unknown[] } | unknown[];
          credentialTypes = Array.isArray(nodeTypesData) ? nodeTypesData : (nodeTypesData as any).data || [];
        }
      } catch {
        // Ignore errors fetching node-types
      }
    }
    
    return { data: { nodes, credentialTypes, endpoint } };
  } catch (err) {
    return {
      error: {
        status: 0,
        message: err instanceof Error ? err.message : 'Network error',
        details: String(err),
      },
    };
  }
}

/**
 * Make authenticated mutating request to n8n API (POST/PUT/PATCH)
 */
async function n8nMutate<T>(
  credentials: ConnectionCredentials,
  endpoint: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<ClientResult<T>> {
  const url = `${credentials.base_url.replace(/\/$/, '')}${endpoint}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'X-N8N-API-KEY': credentials.api_key_encrypted,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      const truncatedBody = errorText.length > 2000 ? errorText.slice(0, 2000) + '...(truncated)' : errorText;
      
      // Log full error for debugging
      console.error(`[n8nClient] ${method} ${endpoint} failed:`, {
        status: response.status,
        statusText: response.statusText,
        body: truncatedBody
      });
      
      return {
        error: {
          status: response.status,
          message: `n8n API error: ${response.status} ${response.statusText}`,
          details: truncatedBody,
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
 * Create a new workflow in n8n
 */
export async function createWorkflow(
  connectionId: string,
  workflow: Partial<N8nWorkflow>
): Promise<ClientResult<N8nWorkflow>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  return n8nMutate<N8nWorkflow>(
    credResult.data!,
    '/api/v1/workflows',
    'POST',
    workflow
  );
}

/**
 * Delete a workflow in n8n
 */
export async function deleteWorkflow(
  connectionId: string,
  workflowId: string
): Promise<ClientResult<void>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  return n8nMutate<void>(
    credResult.data!,
    `/api/v1/workflows/${workflowId}`,
    'DELETE'
  );
}

/**
 * Result of workflow activation including verification
 */
export interface ActivationResult {
  workflow: N8nWorkflow;
  endpointUsed: string;
  verified: boolean;
}

/**
 * Helper: Wait for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper: Verify workflow activation status by fetching it
 */
async function verifyActivation(
  connectionId: string,
  workflowId: string,
  expectedActive: boolean
): Promise<boolean> {
  const getResult = await getWorkflow(connectionId, workflowId);
  if (getResult.error) {
    console.error('[n8nClient] Verification failed - could not fetch workflow:', getResult.error);
    return false;
  }
  const actualActive = getResult.data?.active === true;
  return actualActive === expectedActive;
}

/**
 * Activate or deactivate a workflow in n8n
 * Multi-strategy approach:
 * 1. Try POST /workflows/:id/activate (or /deactivate) endpoints
 * 2. If POST succeeds but verification fails, try PUT with full workflow object
 * 3. If POST returns 404/405, also try PUT fallback
 */
export async function setWorkflowActive(
  connectionId: string,
  workflowId: string,
  active: boolean
): Promise<ClientResult<ActivationResult>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
  const action = active ? 'activate' : 'deactivate';
  
  // STRATEGY 1: Try POST activate/deactivate endpoints
  const postEndpoints = [
    `/api/v1/workflows/${workflowId}/${action}`,
    `/rest/workflows/${workflowId}/${action}`,
  ];
  
  for (const endpoint of postEndpoints) {
    console.log(`[n8nClient] Attempting ${action} via POST ${endpoint}`);
    
    const result = await n8nMutate<N8nWorkflow>(
      credResult.data!,
      endpoint,
      'POST',
      {} // Empty body for activate/deactivate endpoints
    );
    
    // If this endpoint worked, verify the change
    if (!result.error) {
      console.log(`[n8nClient] POST ${endpoint} returned success`);
      
      // Wait for n8n to register the change
      await delay(800);
      
      // Verify the workflow is actually active/inactive
      const verified = await verifyActivation(connectionId, workflowId, active);
      
      if (verified) {
        console.log(`[n8nClient] Activation verified successfully via POST ${endpoint}`);
        return {
          data: {
            workflow: result.data!,
            endpointUsed: endpoint,
            verified: true,
          },
        };
      }
      
      // POST succeeded but verification failed - continue to PUT fallback
      console.warn(`[n8nClient] POST ${endpoint} succeeded but workflow not actually ${action}d - trying PUT fallback`);
      break; // Exit POST loop, try PUT
    }
    
    // If 404 or 405, this endpoint doesn't exist - try next one
    if (result.error.status === 404 || result.error.status === 405) {
      console.log(`[n8nClient] Endpoint ${endpoint} not supported (${result.error.status}), trying next...`);
      continue;
    }
    
    // For any other error, log but continue to try other strategies
    console.warn(`[n8nClient] POST ${endpoint} failed:`, {
      status: result.error.status,
      message: result.error.message,
    });
  }
  
  // STRATEGY 2: PUT with full workflow object (active field set)
  console.log(`[n8nClient] Trying PUT fallback with full workflow object`);
  
  // First, fetch the current workflow
  const getResult = await getWorkflow(connectionId, workflowId);
  if (getResult.error) {
    console.error('[n8nClient] Failed to fetch workflow for PUT fallback:', getResult.error);
    return { error: getResult.error };
  }
  
  const workflow = getResult.data!;
  
  // Check if already in desired state
  if (workflow.active === active) {
    console.log(`[n8nClient] Workflow already ${active ? 'active' : 'inactive'}`);
    return {
      data: {
        workflow,
        endpointUsed: 'already_in_state',
        verified: true,
      },
    };
  }
  
  // Build complete payload with active status changed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updatePayload: Record<string, any> = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    active: active, // The key change
  };
  
  // Include optional fields only if defined (don't send undefined)
  if (workflow.settings !== undefined) updatePayload.settings = workflow.settings;
  if (workflow.staticData !== undefined) updatePayload.staticData = workflow.staticData;
  // Note: Don't include id, createdAt, updatedAt, versionId, shared (read-only)
  
  const putEndpoints = [
    `/api/v1/workflows/${workflowId}`,
    `/rest/workflows/${workflowId}`,
  ];
  
  for (const endpoint of putEndpoints) {
    console.log(`[n8nClient] Attempting ${action} via PUT ${endpoint}`);
    
    const putResult = await n8nMutate<N8nWorkflow>(
      credResult.data!,
      endpoint,
      'PUT',
      updatePayload
    );
    
    if (!putResult.error) {
      console.log(`[n8nClient] PUT ${endpoint} returned success`);
      
      // Wait and verify
      await delay(800);
      const verified = await verifyActivation(connectionId, workflowId, active);
      
      if (verified) {
        console.log(`[n8nClient] Activation verified successfully via PUT ${endpoint}`);
      } else {
        console.warn(`[n8nClient] PUT succeeded but verification failed`);
      }
      
      return {
        data: {
          workflow: putResult.data!,
          endpointUsed: endpoint,
          verified,
        },
      };
    }
    
    // If 404 or 405, try next endpoint
    if (putResult.error.status === 404 || putResult.error.status === 405) {
      console.log(`[n8nClient] PUT ${endpoint} not supported (${putResult.error.status}), trying next...`);
      continue;
    }
    
    // For other errors, log and continue
    console.error(`[n8nClient] PUT ${endpoint} failed:`, {
      status: putResult.error.status,
      message: putResult.error.message,
      details: putResult.error.details?.slice(0, 500),
    });
  }
  
  // All strategies failed
  return {
    error: {
      status: 500,
      message: `All activation strategies failed for workflow ${workflowId}`,
      details: `Tried POST ${postEndpoints.join(', ')} and PUT ${putEndpoints.join(', ')}`,
    },
  };
}

/**
 * Get connection base URL (without /api/v1)
 */
export async function getConnectionBaseUrl(connectionId: string): Promise<ClientResult<string>> {
  const credResult = await getConnectionCredentials(connectionId);
  if (credResult.error) return { error: credResult.error };

  const baseUrl = credResult.data!.base_url.replace(/\/$/, '');
  // Strip /api/v1 if present
  const cleanUrl = baseUrl.endsWith('/api/v1') 
    ? baseUrl.slice(0, -7) 
    : baseUrl;

  return { data: cleanUrl };
}

/**
 * Invoke an n8n webhook URL and measure latency
 */
export interface WebhookInvocationResult {
  status: number;
  data: unknown;
  latencyMs: number;
  error?: string;
}

export async function invokeWebhook(
  baseUrl: string,
  webhookPath: string,
  payload: unknown,
  headers?: Record<string, string>
): Promise<WebhookInvocationResult> {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/webhook/${webhookPath}`;

  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    const latencyMs = Date.now() - startTime;
    
    let data: unknown;
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        data = await response.text();
      }
    } else {
      data = await response.text();
    }

    return {
      status: response.status,
      data,
      latencyMs,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      status: 0,
      data: null,
      latencyMs,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}
