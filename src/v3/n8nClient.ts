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

