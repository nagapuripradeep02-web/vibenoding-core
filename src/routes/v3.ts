/**
 * V3.0 API Routes
 * Execution events, SSE streaming, and sync endpoints
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { getWorkflow, getExecution, getConnectionUserId } from '../v3/n8nClient';
import { buildWorkflowState, mergeExecutionIntoState } from '../v3/workflowState';
import {
  publishWorkflowState,
  subscribeWorkflowState,
  getWorkflowKey,
} from '../v3/pubsub';
import type { ExecutionEventPayload, WorkflowState, N8nWorkflow } from '../v3/types';

const router = Router();

// Cache for workflow updatedAt timestamps (to avoid unnecessary recomputation)
const workflowTimestampCache = new Map<string, string>();

/**
 * Validate X-VIBE-SIGNATURE header
 */
function validateSignature(req: Request): boolean {
  const secret = process.env.VIBE_EXEC_EVENTS_SECRET;
  if (!secret) {
    console.warn('[V3] VIBE_EXEC_EVENTS_SECRET not configured');
    return false;
  }
  
  const signature = req.headers['x-vibe-signature'];
  return signature === secret;
}

/**
 * POST /api/n8n/execution-events
 * Receive execution success/error events from n8n workflows
 */
router.post('/n8n/execution-events', async (req: Request, res: Response) => {
  try {
    // Validate signature
    if (!validateSignature(req)) {
      return res.status(401).json({ error: 'Invalid or missing X-VIBE-SIGNATURE header' });
    }
    
    const payload = req.body as ExecutionEventPayload;
    
    // Validate required fields
    if (!payload.connectionId || !payload.workflowId || !payload.executionId || !payload.status) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'connectionId, workflowId, executionId, and status are required',
      });
    }
    
    console.log(`[V3] Execution event received: ${payload.status} for workflow ${payload.workflowId}`);
    
    // Get user_id from connection
    const userId = await getConnectionUserId(payload.connectionId);
    if (!userId) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    
    // Insert into execution_events table
    const { error: insertError } = await supabaseAdmin
      .from('execution_events')
      .insert({
        user_id: userId,
        connection_id: payload.connectionId,
        workflow_id: payload.workflowId,
        execution_id: payload.executionId,
        status: payload.status,
        meta: payload.meta || {},
      });
    
    if (insertError) {
      console.error('[V3] Failed to insert execution event:', insertError);
      // Continue anyway - we still want to update state
    }
    
    // Fetch execution details from n8n
    const execResult = await getExecution(payload.connectionId, payload.executionId);
    
    // Fetch workflow JSON
    const workflowResult = await getWorkflow(payload.connectionId, payload.workflowId);
    
    if (workflowResult.error) {
      console.error('[V3] Failed to fetch workflow:', workflowResult.error);
      return res.status(502).json({ error: 'Failed to fetch workflow from n8n' });
    }
    
    // Build workflow state
    const state = buildWorkflowState(
      payload.connectionId,
      payload.workflowId,
      workflowResult.data!,
      execResult.data || null
    );
    
    // Upsert workflow_node_state rows
    await upsertNodeStates(userId, payload.connectionId, payload.workflowId, state, payload.executionId);
    
    // Publish to SSE subscribers
    const key = getWorkflowKey(payload.connectionId, payload.workflowId);
    publishWorkflowState(key, state);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[V3] Error processing execution event:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to process execution event', details: message });
  }
});

/**
 * GET /api/stream/workflow-state
 * SSE endpoint for real-time workflow state updates
 */
router.get('/stream/workflow-state', async (req: Request, res: Response) => {
  const { connectionId, workflowId } = req.query;
  
  if (!connectionId || !workflowId || typeof connectionId !== 'string' || typeof workflowId !== 'string') {
    return res.status(400).json({
      error: 'Missing required query parameters',
      details: 'connectionId and workflowId are required',
    });
  }
  
  console.log(`[V3] SSE connection opened for workflow ${workflowId}`);
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  
  // Send initial state
  try {
    const workflowResult = await getWorkflow(connectionId, workflowId);
    
    if (workflowResult.data) {
      const state = buildWorkflowState(connectionId, workflowId, workflowResult.data);
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Failed to fetch workflow' })}\n\n`);
    }
  } catch (err) {
    console.error('[V3] Error fetching initial state:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to fetch initial state' })}\n\n`);
  }
  
  // Subscribe to updates
  const key = getWorkflowKey(connectionId, workflowId);
  const onState = (state: WorkflowState) => {
    try {
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    } catch (err) {
      console.error('[V3] Error writing to SSE stream:', err);
    }
  };
  
  const unsubscribe = subscribeWorkflowState(key, onState);
  
  // Heartbeat to keep connection alive (every 15 seconds)
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);
  
  // Cleanup on disconnect
  req.on('close', () => {
    console.log(`[V3] SSE connection closed for workflow ${workflowId}`);
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/**
 * POST /api/n8n/sync
 * Manually sync workflow state (without execution data)
 */
router.post('/n8n/sync', async (req: Request, res: Response) => {
  try {
    const { connectionId, workflowId } = req.body;
    
    if (!connectionId || !workflowId) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'connectionId and workflowId are required',
      });
    }
    
    // Get user_id from header or from connection
    let userId = req.headers['x-user-id'] as string | undefined;
    if (!userId) {
      // Try to get from connection
      userId = await getConnectionUserId(connectionId) || undefined;
    }
    
    console.log(`[V3] Sync requested for workflow ${workflowId}`);
    
    // Fetch workflow JSON
    const workflowResult = await getWorkflow(connectionId, workflowId);
    
    if (workflowResult.error) {
      return res.status(workflowResult.error.status).json({
        error: workflowResult.error.message,
        details: workflowResult.error.details,
      });
    }
    
    const workflow = workflowResult.data as N8nWorkflow;
    
    // Check if workflow has changed (compare updatedAt)
    const cacheKey = getWorkflowKey(connectionId, workflowId);
    const cachedTimestamp = workflowTimestampCache.get(cacheKey);
    const currentTimestamp = workflow.updatedAt || '';
    
    if (cachedTimestamp === currentTimestamp && cachedTimestamp) {
      // Workflow unchanged, return cached indication
      console.log(`[V3] Workflow unchanged, skipping recomputation`);
      return res.json({ ok: true, unchanged: true });
    }
    
    // Update cache
    workflowTimestampCache.set(cacheKey, currentTimestamp);
    
    // Build state without execution data
    const state = buildWorkflowState(connectionId, workflowId, workflow);
    
    // Upsert node states (only if we have a userId)
    if (userId) {
      await upsertNodeStates(userId, connectionId, workflowId, state, null);
    }
    
    // Publish to SSE subscribers
    publishWorkflowState(cacheKey, state);
    
    res.json({ ok: true, state });
  } catch (error) {
    console.error('[V3] Error syncing workflow:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to sync workflow', details: message });
  }
});

/**
 * GET /api/n8n/workflow-state
 * Get current workflow state (one-time fetch, not streaming)
 */
router.get('/n8n/workflow-state', async (req: Request, res: Response) => {
  try {
    const { connectionId, workflowId } = req.query;
    
    if (!connectionId || !workflowId || typeof connectionId !== 'string' || typeof workflowId !== 'string') {
      return res.status(400).json({
        error: 'Missing required query parameters',
        details: 'connectionId and workflowId are required',
      });
    }
    
    // Fetch workflow JSON
    const workflowResult = await getWorkflow(connectionId, workflowId);
    
    if (workflowResult.error) {
      return res.status(workflowResult.error.status).json({
        error: workflowResult.error.message,
        details: workflowResult.error.details,
      });
    }
    
    // Build state
    const state = buildWorkflowState(connectionId, workflowId, workflowResult.data!);
    
    res.json(state);
  } catch (error) {
    console.error('[V3] Error getting workflow state:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to get workflow state', details: message });
  }
});

/**
 * Upsert workflow_node_state rows in database
 */
async function upsertNodeStates(
  userId: string,
  connectionId: string,
  workflowId: string,
  state: WorkflowState,
  executionId: string | null
): Promise<void> {
  const rows = state.nodes.map(node => ({
    user_id: userId,
    connection_id: connectionId,
    workflow_id: workflowId,
    node_id: node.id,
    node_name: node.name,
    node_type: node.type,
    configured_credentials: node.configured.credentials,
    configured_placeholders: node.configured.placeholders,
    configured_required_fields: node.configured.requiredFields,
    verified: node.verified.status === 'success',
    failed: node.verified.status === 'failed',
    last_execution_id: executionId || node.verified.executionId || null,
    last_error: node.verified.error || null,
    updated_at: new Date().toISOString(),
  }));
  
  // Upsert each node state
  for (const row of rows) {
    const { error } = await supabaseAdmin
      .from('workflow_node_state')
      .upsert(row, {
        onConflict: 'connection_id,workflow_id,node_id',
      });
    
    if (error) {
      console.error(`[V3] Failed to upsert node state for ${row.node_name}:`, error);
    }
  }
}

export default router;

