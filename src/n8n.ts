/**
 * n8n API Client
 * Uses N8N_BASE_URL and N8N_API_KEY from environment variables
 */

const N8N_BASE_URL = process.env.N8N_BASE_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;

function getConfig() {
  if (!N8N_BASE_URL) {
    throw new Error('Missing N8N_BASE_URL environment variable');
  }
  if (!N8N_API_KEY) {
    throw new Error('Missing N8N_API_KEY environment variable');
  }
  return {
    baseUrl: N8N_BASE_URL.replace(/\/$/, ''),
    apiKey: N8N_API_KEY,
  };
}

// Custom error class to pass status codes
export class N8nApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'N8nApiError';
    this.statusCode = statusCode;
  }
}

async function n8nFetch(endpoint: string): Promise<unknown> {
  const { baseUrl, apiKey } = getConfig();
  const url = `${baseUrl}${endpoint}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-N8N-API-KEY': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new N8nApiError(`n8n API error (${response.status}): ${errorText}`, response.status);
  }

  return response.json();
}

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  tags: Array<{ id: string; name: string }>;
}

export interface Workflow {
  id: string;
  name: string;
  active: boolean;
  tags: Array<{ id: string; name: string }>;
  nodes: unknown[];
  connections: unknown;
  settings: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * List all workflows from n8n
 * @returns Array of workflow summaries with id, name, active, tags
 */
export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const data = await n8nFetch('/api/v1/workflows') as { data?: unknown[] };
  const workflows = data.data || [];
  
  return workflows.map((wf: unknown) => {
    const w = wf as Record<string, unknown>;
    return {
      id: String(w.id || ''),
      name: String(w.name || ''),
      active: Boolean(w.active),
      tags: Array.isArray(w.tags) ? w.tags : [],
    };
  });
}

/**
 * Get a single workflow by ID
 * @param workflowId The workflow ID
 * @returns Full workflow JSON
 */
export async function getWorkflow(workflowId: string): Promise<Workflow> {
  if (!workflowId) {
    throw new Error('workflowId is required');
  }
  
  const data = await n8nFetch(`/api/v1/workflows/${workflowId}`);
  return data as Workflow;
}

