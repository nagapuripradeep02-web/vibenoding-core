/**
 * V3.0 API Routes
 * Execution events, SSE streaming, and sync endpoints
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import {
  getWorkflow,
  getExecution,
  listRecentExecutions,
  getConnectionUserId,
  createWorkflow,
  deleteWorkflow,
  updateWorkflow,
  setWorkflowActive,
  getConnectionBaseUrl,
  invokeWebhook,
} from '../v3/n8nClient';
import {
  cloneWorkflowForTest,
  generateWebhookPath,
  generateWebhookSecret,
  buildWebhookUrl,
} from '../v3/sandboxGraph';
import {
  buildContextPack,
  sanitizeContextPack,
  buildSystemPrompt,
  buildUserContext,
} from '../v3/assistContext';
import type { LatestExecutionError, ContextPack } from '../v3/assistContext';
import {
  validateAssistResponse,
  buildDeterministicResponse,
  parseAssistResponse,
} from '../v3/assistValidation';
import type { AssistResponse } from '../v3/assistValidation';
import {
  ASK_BUDGETS,
  createEmptyTimings,
  createEmptyDebug,
} from '../v3/askContract';
import type {
  AskIssue,
  AskCitation,
  AskDebug,
  AskContractResponse,
  TopFixFirst,
  AskTimings,
} from '../v3/askContract';
import {
  rankIssues,
  buildTopFixFirst,
  convertLegacyIssue,
} from '../v3/askRanker';
import {
  PLAN_BUDGETS,
  createEmptyPlanTimings,
  createEmptyPlanDebug,
  sortPlanForDeterminism,
} from '../v3/planContract';
import type {
  Plan,
  PlanDebug,
  PlanContractResponse,
} from '../v3/planContract';
import {
  buildPlanSystemPrompt,
  buildPlanUserContext,
  parsePlanResponse,
  extractStableOrderSignature,
} from '../v3/planContext';
import {
  APPLY_STEP_BUDGETS,
  createEmptyApplyStepDebug,
  createEmptyApplyStepTimings,
  validatePatchOperations,
} from '../v3/applyStepContract';
import type { ApplyStepResponse, ApplyStepDebug } from '../v3/applyStepContract';
import {
  buildPatchPrompt,
  parsePatchResponse,
  applyPatchToWorkflow,
  computeDiffSummary,
  prepareWorkflowForUpdate,
} from '../v3/applyStepPatcher';
import { callLLM, estimateTokens, truncateToTokens } from '../llm/router';
import { buildWorkflowState, mergeExecutionIntoState } from '../v3/workflowState';
import {
  publishWorkflowState,
  subscribeWorkflowState,
  getWorkflowKey,
} from '../v3/pubsub';
import { decorateStateForUi } from '../v3/decorate';
import { ensurePolling, onSubscriberConnected, onSubscriberDisconnected, pollOnce } from '../v3/executionPoller';
import { sanitizeForResponse } from '../v3/sanitize';
import { resolveN8nWorkflowId } from '../v3/workflowIdBridge';
import {
  searchNodeLibrary,
  getNodeWithPatterns,
  matchErrorPattern,
  seedNodeLibraryFromJson,
  upsertWorkflowNodes,
  getWorkflowNode,
  getWorkflowNodeByName,
  ensureNodeLibraryNodesExist,
  isExecutableNodeType,
  syncNodeTypeCatalog,
  summarizeNodeParams,
  ensureGenericErrorPatterns,
  getNodeDefinition,
  backfillNodeLibrarySchemas,
  backfillWorkflowNodeSummaries,
  repairNodeLibrarySchemas,
  computeSchemaHash,
} from '../v3/nodeLibrary';
import type { ExecutionEventPayload, WorkflowState, N8nWorkflow } from '../v3/types';
import type { NodeContextPack, WorkflowNode, NodeLibraryNode } from '../v3/nodeLibraryTypes';

const router = Router();
console.log('[v3Routes] loaded from', __filename);

// Cache for workflow updatedAt timestamps (to avoid unnecessary recomputation)
const workflowTimestampCache = new Map<string, string>();

// Throttle for repair calls (once per connection per 5 minutes)
const repairThrottle = new Map<string, number>();
const REPAIR_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Execution health analysis result
 */
interface ExecutionHealthAnalysis {
  isHealthy: boolean;
  pickedExecutionId: string | null;
  pickedExecutionStatus: string | null;
  latestAny: { id: string; status: string; finishedAt: string } | null;
  latestError: { id: string; status: string; finishedAt: string } | null;
  latestSuccess: { id: string; status: string; finishedAt: string } | null;
  recentExecutions: Array<{ id: string; status: string; finishedAt: string; startedAt: string }>;
}

/**
 * Analyze workflow execution health from recent executions
 * Determines if workflow is currently healthy or has a recent error to address
 */
async function analyzeExecutionHealth(
  connectionId: string,
  n8nWorkflowId: string
): Promise<ExecutionHealthAnalysis> {
  const analysis: ExecutionHealthAnalysis = {
    isHealthy: false,
    pickedExecutionId: null,
    pickedExecutionStatus: null,
    latestAny: null,
    latestError: null,
    latestSuccess: null,
    recentExecutions: [],
  };

  try {
    console.log(`[analyzeExecutionHealth] Fetching 20 recent executions for workflow ${n8nWorkflowId}`);

    const executionsResult = await listRecentExecutions(connectionId, n8nWorkflowId, 20, {
      includeData: false, // Don't need full data for health check
    });

    if (executionsResult.error || !executionsResult.data || executionsResult.data.length === 0) {
      console.log(`[analyzeExecutionHealth] No executions found or error fetching`);
      return analysis;
    }

    const executions = executionsResult.data;

    // Filter out running/waiting executions - only consider finished executions
    const finishedExecutions = executions.filter(exec => {
      const status = exec.status || '';
      return status !== 'running' && status !== 'waiting';
    });

    // Store recent finished executions for debug output
    analysis.recentExecutions = finishedExecutions.slice(0, 5).map(exec => ({
      id: exec.id || '',
      status: exec.status || 'unknown',
      finishedAt: exec.stoppedAt || exec.startedAt || '',
      startedAt: exec.startedAt || '',
    }));

    if (finishedExecutions.length === 0) {
      console.log(`[analyzeExecutionHealth] No finished executions found`);
      return analysis;
    }

    // Sort chronologically: newest first (prefer stoppedAt, fallback to startedAt)
    const sorted = [...finishedExecutions].sort((a, b) => {
      const aTime = new Date(a.stoppedAt || a.startedAt || 0).getTime();
      const bTime = new Date(b.stoppedAt || b.startedAt || 0).getTime();
      return bTime - aTime;
    });

    // Find latest of each type
    if (sorted.length > 0) {
      analysis.latestAny = {
        id: sorted[0].id || '',
        status: sorted[0].status || '',
        finishedAt: sorted[0].stoppedAt || sorted[0].startedAt || '',
      };
    }

    const errorExecution = sorted.find(exec => exec.status === 'error');
    if (errorExecution) {
      analysis.latestError = {
        id: errorExecution.id || '',
        status: errorExecution.status || '',
        finishedAt: errorExecution.stoppedAt || errorExecution.startedAt || '',
      };
    }

    const successExecution = sorted.find(exec => exec.status === 'success');
    if (successExecution) {
      analysis.latestSuccess = {
        id: successExecution.id || '',
        status: successExecution.status || '',
        finishedAt: successExecution.stoppedAt || successExecution.startedAt || '',
      };
    }

    // Determine health: latest is success AND (no error OR latest success is newer than latest error)
    // This implements the reliability rule: if the latest execution succeeded, and there's no newer error,
    // then the workflow is currently healthy and we don't need error analysis.
    if (analysis.latestAny && analysis.latestAny.status === 'success') {
      const latestSuccessTime = new Date(analysis.latestAny.finishedAt).getTime();
      let isHealthy = true;

      if (analysis.latestError) {
        // Check if there's a newer error after the latest success
        const latestErrorTime = new Date(analysis.latestError.finishedAt).getTime();
        if (latestErrorTime > latestSuccessTime) {
          // Error is newer than success, so the workflow had a recent failure → not healthy
          isHealthy = false;
        }
      }
      // If no error exists or error is older than success → workflow is healthy

      if (isHealthy) {
        analysis.isHealthy = true;
        analysis.pickedExecutionId = analysis.latestAny.id;
        analysis.pickedExecutionStatus = 'success';
        console.log(`[analyzeExecutionHealth] Workflow is HEALTHY. Latest success: ${analysis.latestAny.id}`);
      }
    }

    // If not healthy, pick the latest error
    if (!analysis.isHealthy && analysis.latestError) {
      analysis.pickedExecutionId = analysis.latestError.id;
      analysis.pickedExecutionStatus = 'error';
      console.log(`[analyzeExecutionHealth] Workflow has recent ERROR. Latest error: ${analysis.latestError.id}`);
    }

    // If still not picked, use latest any
    if (!analysis.pickedExecutionId && analysis.latestAny) {
      analysis.pickedExecutionId = analysis.latestAny.id;
      analysis.pickedExecutionStatus = analysis.latestAny.status;
      console.log(`[analyzeExecutionHealth] Picked latest execution: ${analysis.latestAny.id} (${analysis.latestAny.status})`);
    }
  } catch (error) {
    console.warn('[analyzeExecutionHealth] Error during analysis:', error);
    // Return partial analysis
  }

  return analysis;
}

/**
 * Sync workflow nodes to database/cache if workflow has changed
 * Returns cache info for debugging
 */
async function syncWorkflowIfChanged(
  userId: string,
  connectionId: string,
  n8nWorkflowId: string,
  workflow: N8nWorkflow
): Promise<{
  synced: boolean;
  workflowUpdatedAt: string;
  cacheUpdatedAt: string | null;
  unchanged: boolean;
}> {
  const cacheKey = getWorkflowKey(connectionId, n8nWorkflowId);
  const cachedTimestamp = workflowTimestampCache.get(cacheKey);
  const currentTimestamp = workflow.updatedAt || '';
  const unchanged = !!(cachedTimestamp && cachedTimestamp === currentTimestamp);

  if (!unchanged) {
    console.log(`[syncWorkflowIfChanged] Workflow changed, syncing nodes to DB`);

    // Update cache
    workflowTimestampCache.set(cacheKey, currentTimestamp);

    // Sync nodes to database
    const executionForState = await tryGetLatestExecution(connectionId, n8nWorkflowId);
    const baseState = buildWorkflowState(connectionId, n8nWorkflowId, workflow, executionForState);

    // Update node config states
    await upsertNodeConfigStates(userId, connectionId, n8nWorkflowId, baseState);

    // Ensure node library coverage
    if (process.env.NODE_LIBRARY_AUTO_STUBS !== '0') {
      try {
        const uniqueNodeTypes = [...new Set((workflow.nodes || []).map((n) => n.type).filter(Boolean))];
        if (uniqueNodeTypes.length > 0) {
          await ensureNodeLibraryNodesExist(uniqueNodeTypes);
        }
      } catch (e) {
        console.warn('[syncWorkflowIfChanged] Node library coverage error (non-fatal):', e);
      }
    }

    // Upsert workflow nodes
    await upsertWorkflowNodesFromWorkflow(connectionId, n8nWorkflowId, workflow);
  }

  return {
    synced: !unchanged,
    workflowUpdatedAt: currentTimestamp,
    cacheUpdatedAt: cachedTimestamp || null,
    unchanged,
  };
}

async function resolveUserIdForConnection(req: Request, connectionId: string): Promise<string | null> {
  const connectionUserId = await getConnectionUserId(connectionId);
  if (!connectionUserId) return null;

  const headerUserId = req.headers['x-user-id'] as string | undefined;
  if (headerUserId && headerUserId !== connectionUserId) {
    return null;
  }

  return connectionUserId;
}

async function tryGetLatestExecution(connectionId: string, workflowId: string) {
  try {
    const recent = await listRecentExecutions(connectionId, workflowId, 1, { includeData: false });
    const latest = recent.data?.[0];
    const latestId = (latest as any)?.id;
    if (!latestId) return null;
    const exec = await getExecution(connectionId, String(latestId));
    return exec.data || null;
  } catch (e) {
    console.warn('[sync] Failed to fetch latest execution (non-fatal):', e);
    return null;
  }
}

/**
 * Minimal workflow state payload for the cloned workflow UI.
 * Requirements:
 * - state.nodes[].key = node.name
 * - state.nodes[].id  = node.name
 * - configured.credentials true if node.credentials exists and has keys
 * - placeholders/requiredFields simplistic for now
 * - verified.status = "not_run"
 */
function buildMinimalState(connectionId: string, workflowId: string, workflow: N8nWorkflow) {
  const nodes = (workflow.nodes || []).map((node) => {
    const hasCreds = !!node.credentials && Object.keys(node.credentials).length > 0;
    const configured = {
      credentials: hasCreds,
      placeholders: false,
      requiredFields: true,
    };

    return {
      // Back-compat fields (kept)
      key: node.name,
      id: node.name,

      // New matching fields (requested)
      nodeKey: node.name,
      nodeId: (node as any).id ?? null,

      name: node.name,
      type: node.type,
      configured,
      verified: { status: 'not_run' as const },
      progress: configured.credentials ? 70 : 0,
      missing: {
        credentials: configured.credentials ? [] : ['Attach the required credential in n8n'],
        placeholders: [],
        requiredFields: [],
      },
    };
  });

  return {
    connectionId,
    workflowId,
    workflowUpdatedAt: (workflow.updatedAt || workflow.createdAt || new Date().toISOString()) as string,
    nodes,
    debug: {
      nodesCount: nodes.length,
      firstNodeKey: nodes[0]?.nodeKey,
      firstNodeId: nodes[0]?.nodeId,
    },
    summary: {},
  };
}

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

    // Publish to SSE subscribers (UI-decorated)
    const key = getWorkflowKey(payload.connectionId, payload.workflowId);
    publishWorkflowState(key, decorateStateForUi(state));

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
 * 
 * Accepts either:
 * - Supabase workflow UUID (resolved to n8n_workflow_id via database lookup)
 * - Direct n8n workflow ID (used as-is)
 */
router.get('/stream/workflow-state', async (req: Request, res: Response) => {
  const { connectionId, workflowId } = req.query;

  if (!connectionId || !workflowId || typeof connectionId !== 'string' || typeof workflowId !== 'string') {
    return res.status(400).json({
      error: 'Missing required query parameters',
      details: 'connectionId and workflowId are required',
    });
  }

  console.log(`[SSE] Connection opened for workflow ${workflowId.slice(0, 8)}...`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Resolve user first (before setting up stream)
  const userId = await resolveUserIdForConnection(req, connectionId);
  if (!userId) {
    res.write(`data: ${JSON.stringify({ error: 'Unauthorized or connection not found' })}\n\n`);
    return res.end();
  }

  // CRITICAL: Resolve Supabase UUID → n8n workflow ID ONCE at stream start
  const resolveResult = await resolveN8nWorkflowId({ workflowId, connectionId, userId });
  if (resolveResult.ok === false) {
    console.log(`[SSE] Failed to resolve workflowId: ${resolveResult.code} - ${resolveResult.error}`);
    res.write(`data: ${JSON.stringify({
      error: resolveResult.error,
      code: resolveResult.code,
      workflowId
    })}\n\n`);
    return res.end();
  }

  const n8nWorkflowId = resolveResult.n8nWorkflowId;
  console.log(`[SSE] Resolved: ${workflowId.slice(0, 8)}... → ${n8nWorkflowId}`);

  // Send initial state
  try {
    // Use resolved n8nWorkflowId for n8n API calls
    const workflowResult = await getWorkflow(connectionId, n8nWorkflowId);

    if (workflowResult.data) {
      const exec = await tryGetLatestExecution(connectionId, n8nWorkflowId);
      const baseState = buildWorkflowState(connectionId, n8nWorkflowId, workflowResult.data, exec);
      const state = decorateStateForUi(baseState);

      console.log(`[SSE] Initial state: ${state.nodes?.length || 0} nodes`);
      res.write(`data: ${JSON.stringify(state)}\n\n`);

      // Start poller for this workflow while SSE subscribers are connected
      // Use n8nWorkflowId for consistency
      onSubscriberConnected({
        connectionId,
        workflowId: n8nWorkflowId,
        userId,
        workflow: workflowResult.data,
        seedState: baseState,
      });
    } else {
      console.log(`[SSE] n8n returned no data for workflow ${n8nWorkflowId}`);
      res.write(`data: ${JSON.stringify({ error: 'Failed to fetch workflow from n8n', n8nWorkflowId })}\n\n`);
    }
  } catch (err) {
    console.error('[SSE] Error fetching initial state:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to fetch initial state' })}\n\n`);
  }

  // Subscribe to updates using n8nWorkflowId
  const key = getWorkflowKey(connectionId, n8nWorkflowId);
  const onState = (state: WorkflowState) => {
    try {
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    } catch (err) {
      console.error('[SSE] Error writing to stream:', err);
    }
  };

  const unsubscribe = subscribeWorkflowState(key, onState);

  // Heartbeat to keep connection alive (every 25 seconds)
  const heartbeat = setInterval(() => {
    try {
      res.write(':keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  // Cleanup on disconnect
  req.on('close', () => {
    console.log(`[SSE] Connection closed for workflow ${n8nWorkflowId}`);
    clearInterval(heartbeat);
    unsubscribe();
    onSubscriberDisconnected(connectionId, n8nWorkflowId);
  });
});

/**
 * POST /api/n8n/sync
 * Manually sync workflow state (without execution data)
 * 
 * Accepts either:
 * - Supabase workflow UUID (resolved to n8n_workflow_id via database lookup)
 * - Direct n8n workflow ID (used as-is)
 */
router.post('/n8n/sync', async (req: Request, res: Response) => {
  try {
    const { connectionId, workflowId } = req.body;

    if (!connectionId || !workflowId) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields',
        details: 'connectionId and workflowId are required',
      });
    }

    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({ ok: false, error: 'Unauthorized or connection not found' });
    }

    // Resolve workflowId: if UUID, look up n8n_workflow_id from Supabase
    const resolveResult = await resolveN8nWorkflowId({ workflowId, connectionId, userId });
    if (resolveResult.ok === false) {
      console.log(`[sync] Failed to resolve workflowId: ${resolveResult.code} - ${resolveResult.error}`);
      const statusCode =
        resolveResult.code === 'WORKFLOW_NOT_FOUND' ? 404
          : resolveResult.code === 'MISSING_N8N_ID' ? 404
            : resolveResult.code === 'USER_MISMATCH' ? 403
              : resolveResult.code === 'DB_ERROR' ? 500
                : 400;
      return res.status(statusCode).json({
        ok: false,
        error: resolveResult.error,
        code: resolveResult.code,
      });
    }

    const n8nWorkflowId = resolveResult.n8nWorkflowId;
    const supabaseWorkflowId = resolveResult.supabaseWorkflowId || workflowId;

    console.log(`[sync] Resolved: ${workflowId.slice(0, 8)}... → ${n8nWorkflowId} (source: ${resolveResult.sourceTable})`);

    // Fetch workflow JSON using resolved n8n ID
    const workflowResult = await getWorkflow(connectionId, n8nWorkflowId);

    if (workflowResult.error) {
      return res.status(workflowResult.error.status).json({
        error: workflowResult.error.message,
        details: workflowResult.error.details,
      });
    }

    const workflow = workflowResult.data as N8nWorkflow;

    // Use n8nWorkflowId for all n8n API calls and internal state storage
    // This ensures consistency across the system

    // Check if workflow has changed (compare updatedAt)
    const cacheKey = getWorkflowKey(connectionId, n8nWorkflowId);
    const cachedTimestamp = workflowTimestampCache.get(cacheKey);
    const currentTimestamp = workflow.updatedAt || '';
    const unchanged = !!(cachedTimestamp && cachedTimestamp === currentTimestamp);

    // Update cache
    workflowTimestampCache.set(cacheKey, currentTimestamp);

    // Use n8nWorkflowId for n8n API calls
    const executionForState = await tryGetLatestExecution(connectionId, n8nWorkflowId);

    // Build base state and decorate for UI
    const baseState = buildWorkflowState(connectionId, n8nWorkflowId, workflow, executionForState);
    const state = decorateStateForUi(baseState);
    console.log('[sync]', { connectionId, n8nWorkflowId, nodesCount: state.nodes.length });

    // IMPORTANT: do not overwrite execution-derived fields (failed/verified/last_error/last_execution_id/last_run_at)
    // Sync should only update identity + configured_* fields.
    await upsertNodeConfigStates(userId, connectionId, n8nWorkflowId, baseState);

    // V3.1 Coverage Guard: Ensure all node types exist in node_library_nodes (create stubs for missing ones)
    if (process.env.NODE_LIBRARY_AUTO_STUBS !== '0') {
      try {
        const uniqueNodeTypes = [...new Set((workflow.nodes || []).map((n) => n.type).filter(Boolean))];
        if (uniqueNodeTypes.length > 0) {
          const result = await ensureNodeLibraryNodesExist(uniqueNodeTypes);
          if (result.error) {
            console.warn('[sync] Failed to ensure node library coverage (non-fatal):', result.error.message);
          }
        }
      } catch (e) {
        console.warn('[sync] Error ensuring node library coverage (non-fatal):', e instanceof Error ? e.message : 'Unknown error');
        // Continue sync even if coverage guard fails
      }
    }

    // V3.1: Upsert workflow nodes to link them to node library
    await upsertWorkflowNodesFromWorkflow(connectionId, n8nWorkflowId, workflow);

    // Optional: Backfill missing schemas and summaries (behind env flag)
    if (process.env.NODE_LIBRARY_BACKFILL === '1') {
      try {
        const schemaBackfill = await backfillNodeLibrarySchemas(connectionId);
        if (schemaBackfill.error) {
          console.warn('[sync] Schema backfill failed (non-fatal):', schemaBackfill.error.message);
        } else if (schemaBackfill.filled > 0) {
          console.log(`[sync] Backfilled ${schemaBackfill.filled} node schemas`);
        }

        const summaryBackfill = await backfillWorkflowNodeSummaries(connectionId);
        if (summaryBackfill.error) {
          console.warn('[sync] Summary backfill failed (non-fatal):', summaryBackfill.error.message);
        } else if (summaryBackfill.filled > 0) {
          console.log(`[sync] Backfilled ${summaryBackfill.filled} workflow node summaries`);
        }
      } catch (e) {
        console.warn('[sync] Backfill error (non-fatal):', e instanceof Error ? e.message : 'Unknown error');
        // Continue sync even if backfill fails
      }
    }

    // Start (or refresh) execution polling for this workflow (even without SSE subscribers)
    ensurePolling({
      connectionId,
      workflowId: n8nWorkflowId,
      userId,
      workflow,
      seedState: baseState,
      reason: 'sync',
    });

    // Sync node catalog to ensure real schemas (throttled: once per connection per 5 minutes)
    const lastRepairTime = repairThrottle.get(connectionId) || 0;
    const now = Date.now();
    if (now - lastRepairTime >= REPAIR_THROTTLE_MS) {
      repairThrottle.set(connectionId, now);
      // Run catalog sync in background (non-blocking) - this fetches real schemas from n8n
      syncNodeTypeCatalog(connectionId, { refresh: false }).catch((e) => {
        console.warn('[sync] Catalog sync failed (non-fatal):', e instanceof Error ? e.message : 'Unknown error');
      });
    }

    // Publish to SSE subscribers
    publishWorkflowState(cacheKey, state as any);

    res.json({ ok: true, unchanged, state });
  } catch (error) {
    console.error('[V3] Error syncing workflow:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to sync workflow', details: message });
  }
});

/**
 * GET /api/v3/workflows/evaluate?connectionId=...&workflowId=...
 * Evaluate workflow for issues (blockers, warnings, info)
 * Used by dashboard to show workflow health status
 * 
 * Accepts either:
 * - Supabase workflow UUID (resolved to n8n_workflow_id via database lookup)
 * - Direct n8n workflow ID (used as-is)
 */
router.get('/v3/workflows/evaluate', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId;
    const workflowId = req.query.workflowId;

    if (!connectionId || typeof connectionId !== 'string' || !workflowId || typeof workflowId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing connectionId or workflowId',
      });
    }

    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized or connection not found',
      });
    }

    // Resolve workflowId: if UUID, look up n8n_workflow_id from Supabase
    const resolveResult = await resolveN8nWorkflowId({ workflowId, connectionId, userId });
    if (resolveResult.ok === false) {
      console.log(`[evaluate] Failed to resolve workflowId: ${resolveResult.code} - ${resolveResult.error}`);
      const statusCode =
        resolveResult.code === 'WORKFLOW_NOT_FOUND' ? 404
          : resolveResult.code === 'MISSING_N8N_ID' ? 404
            : resolveResult.code === 'USER_MISMATCH' ? 403
              : resolveResult.code === 'DB_ERROR' ? 500
                : 400;
      return res.status(statusCode).json({
        ok: false,
        error: resolveResult.error,
        code: resolveResult.code,
      });
    }

    const n8nWorkflowId = resolveResult.n8nWorkflowId;
    console.log(`[evaluate] Resolved: ${workflowId.slice(0, 8)}... → ${n8nWorkflowId} (source: ${resolveResult.sourceTable})`);

    // Fetch workflow using resolved n8n ID
    const workflowResult = await getWorkflow(connectionId, n8nWorkflowId);
    if (workflowResult.error) {
      return res.status(workflowResult.error.status).json({
        ok: false,
        error: workflowResult.error.message,
      });
    }

    const workflow = workflowResult.data as N8nWorkflow;

    // Fetch latest execution to detect credential errors
    const executionForState = await tryGetLatestExecution(connectionId, n8nWorkflowId);

    // Build workflow state using the same validation logic as sync
    const state = buildWorkflowState(connectionId, n8nWorkflowId, workflow, executionForState);

    // Convert node states to issues format expected by frontend
    const issues: Array<{
      issue_code: string;
      severity: 'blocker' | 'warning' | 'info';
      node_locator: { node_id: string; node_name: string };
      details: Record<string, unknown>;
      suggested_fix?: {
        action: string;
        credential_alternatives?: string[];
        required_any_of?: string[];
        patch?: Record<string, unknown>;
        autofix_supported?: boolean;
      };
    }> = [];

    for (const node of state.nodes) {
      // Skip disabled nodes
      const workflowNode = workflow.nodes?.find(n => n.name === node.name);
      if (workflowNode?.disabled) continue;

      // Check credentials
      if (!node.configured.credentials && node.missing.credentials.length > 0) {
        issues.push({
          issue_code: 'MISSING_CREDENTIALS',
          severity: 'blocker',
          node_locator: { node_id: node.id, node_name: node.name },
          details: {
            node_type: node.type,
            reason: node.missing.credentials.join(', '),
          },
          suggested_fix: {
            action: 'attach_credential',
            autofix_supported: false,
          },
        });
      }

      // Check placeholders
      if (!node.configured.placeholders && node.missing.placeholders.length > 0) {
        issues.push({
          issue_code: 'PLACEHOLDER_VALUES',
          severity: 'warning',
          node_locator: { node_id: node.id, node_name: node.name },
          details: {
            node_type: node.type,
            placeholders: node.missing.placeholders,
          },
          suggested_fix: {
            action: 'replace_placeholders',
            autofix_supported: false,
          },
        });
      }

      // Check execution failures (not related to credentials)
      if (node.verified.status === 'failed' && node.configured.credentials) {
        issues.push({
          issue_code: 'EXECUTION_FAILED',
          severity: 'warning',
          node_locator: { node_id: node.id, node_name: node.name },
          details: {
            node_type: node.type,
            error: node.verified.error || 'Unknown error',
          },
        });
      }
    }

    // Count by severity
    const blockers = issues.filter(i => i.severity === 'blocker').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const info = issues.filter(i => i.severity === 'info').length;

    // Disable caching - evaluation results are dynamic and must be fresh
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.json({
      ok: true,
      ts: Date.now(), // For cache-bust verification in DevTools
      evaluation: {
        summary: {
          blockers,
          warnings,
          info,
          total: issues.length,
        },
        issues,
      },
    });
  } catch (e) {
    console.error('[evaluate] failed', e);
    res.status(500).json({
      ok: false,
      error: 'Failed to evaluate workflow',
    });
  }
});

/**
 * POST /api/v3/workflows/:workflowId/poll?connectionId=...
 * Run exactly one execution polling cycle and return the decorated state.
 * 
 * Accepts either:
 * - Supabase workflow UUID (resolved to n8n_workflow_id via database lookup)
 * - Direct n8n workflow ID (used as-is)
 */
router.post('/v3/workflows/:workflowId/poll', async (req: Request, res: Response) => {
  try {
    const { workflowId } = req.params;
    const connectionId = req.query.connectionId;

    if (!connectionId || typeof connectionId !== 'string' || !workflowId) {
      return res.status(400).json({ error: 'Missing connectionId or workflowId' });
    }

    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({ error: 'Unauthorized or connection not found' });
    }

    // CRITICAL: Resolve Supabase UUID → n8n workflow ID
    const resolveResult = await resolveN8nWorkflowId({ workflowId, connectionId, userId });
    if (resolveResult.ok === false) {
      console.log(`[poll] Failed to resolve workflowId: ${resolveResult.code} - ${resolveResult.error}`);
      const statusCode =
        resolveResult.code === 'WORKFLOW_NOT_FOUND' ? 404
          : resolveResult.code === 'MISSING_N8N_ID' ? 404
            : resolveResult.code === 'USER_MISMATCH' ? 403
              : resolveResult.code === 'DB_ERROR' ? 500
                : 400;
      return res.status(statusCode).json({
        ok: false,
        error: resolveResult.error,
        code: resolveResult.code,
      });
    }

    const n8nWorkflowId = resolveResult.n8nWorkflowId;
    console.log(`[poll] Resolved: ${workflowId.slice(0, 8)}... → ${n8nWorkflowId}`);

    // Use resolved n8nWorkflowId for polling
    const result = await pollOnce({ connectionId, workflowId: n8nWorkflowId, userId });

    // Disable caching - poll results are dynamic and must be fresh
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.json({ ...result, ts: Date.now() });
  } catch (e) {
    console.error('[poll] failed', e);
    res.status(500).json({ error: 'Failed to poll executions' });
  }
});

/**
 * Helper: Find upstream node names that connect to a target node
 */
function findUpstreamNodeNames(workflow: N8nWorkflow, targetNodeName: string): string[] {
  const connections = workflow.connections || {};
  const upstreamNames: string[] = [];

  // Parse connections: for each source node, find all target nodes
  for (const [sourceNodeName, outputTypes] of Object.entries(connections)) {
    if (!outputTypes || typeof outputTypes !== 'object') continue;

    // Iterate through output types (usually "main")
    for (const connectionArrays of Object.values(outputTypes)) {
      if (!Array.isArray(connectionArrays)) continue;

      // Each array represents connections from an output index
      for (const connectionArray of connectionArrays) {
        if (!Array.isArray(connectionArray)) continue;

        for (const conn of connectionArray) {
          if (!conn || typeof conn !== 'object') continue;
          if (typeof conn.node === 'string' && conn.node === targetNodeName) {
            if (!upstreamNames.includes(sourceNodeName)) {
              upstreamNames.push(sourceNodeName);
            }
          }
        }
      }
    }
  }

  return upstreamNames;
}

/**
 * Helper: Build input preview from upstream node outputs
 */
function buildInputPreview(
  runData: Record<string, any[]>,
  upstreamNodeNames: string[],
  maxItems: number = 3
): {
  sources: Array<{
    nodeName: string;
    itemsPreview: unknown[];
    totalItems: number;
    truncated: boolean;
  }>;
  mergedPreview?: unknown[];
} | null {
  if (upstreamNodeNames.length === 0) {
    return null;
  }

  const sources: Array<{
    nodeName: string;
    itemsPreview: unknown[];
    totalItems: number;
    truncated: boolean;
  }> = [];

  const mergedItems: unknown[] = [];

  for (const upstreamName of upstreamNodeNames) {
    const nodeRuns = runData[upstreamName];
    if (!Array.isArray(nodeRuns) || nodeRuns.length === 0) continue;

    const lastRun = nodeRuns[nodeRuns.length - 1];
    const outputData = lastRun?.data?.main;
    if (!Array.isArray(outputData) || outputData.length === 0) continue;

    // Get first output array (main[0])
    const firstOutputArray = outputData[0];
    if (!Array.isArray(firstOutputArray)) continue;

    const totalItems = firstOutputArray.length;
    const itemsToTake = Math.min(maxItems, totalItems);
    const itemsPreview = firstOutputArray.slice(0, itemsToTake).map((item) => {
      // Extract json from item if it exists
      const jsonData = item?.json || item;
      return sanitizeForResponse(jsonData);
    });

    sources.push({
      nodeName: upstreamName,
      itemsPreview,
      totalItems,
      truncated: totalItems > maxItems,
    });

    // Add to merged preview
    mergedItems.push(...itemsPreview);
  }

  if (sources.length === 0) {
    return null;
  }

  return {
    sources,
    mergedPreview: mergedItems.length > 0 ? mergedItems : undefined,
  };
}

/**
 * Helper: Build output preview from target node output
 */
function buildOutputPreview(
  runData: Record<string, any[]>,
  targetNodeName: string,
  maxItems: number = 3
): {
  itemsPreview: unknown[];
  totalItems: number;
  truncated: boolean;
} | null {
  const nodeRuns = runData[targetNodeName];
  if (!Array.isArray(nodeRuns) || nodeRuns.length === 0) {
    return null;
  }

  const lastRun = nodeRuns[nodeRuns.length - 1];
  const outputData = lastRun?.data?.main;
  if (!Array.isArray(outputData) || outputData.length === 0) {
    return null;
  }

  // Get first output array (main[0])
  const firstOutputArray = outputData[0];
  if (!Array.isArray(firstOutputArray)) {
    return null;
  }

  const totalItems = firstOutputArray.length;
  const itemsToTake = Math.min(maxItems, totalItems);
  const itemsPreview = firstOutputArray.slice(0, itemsToTake).map((item) => {
    // Extract json from item if it exists
    const jsonData = item?.json || item;
    return sanitizeForResponse(jsonData);
  });

  return {
    itemsPreview,
    totalItems,
    truncated: totalItems > maxItems,
  };
}

/**
 * GET /api/v3/node-inspect?connectionId=...&workflowId=...&nodeKey=...&executionId=...
 * (nodeId can be used as fallback identifier if nodeKey is not provided)
 */
router.get('/v3/node-inspect', async (req: Request, res: Response) => {
  try {
    // Disable caching to prevent 304 responses
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.removeHeader('ETag'); // Disable ETag

    const connectionId = req.query.connectionId;
    const workflowId = req.query.workflowId;
    const nodeKey = req.query.nodeKey;
    const nodeId = req.query.nodeId;
    const executionId = req.query.executionId;

    if (typeof connectionId !== 'string' || typeof workflowId !== 'string') {
      return res.status(400).json({ error: 'Missing connectionId or workflowId' });
    }

    if (typeof nodeKey !== 'string' && typeof nodeId !== 'string') {
      return res.status(400).json({ error: 'Missing nodeKey (or nodeId)' });
    }

    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({ error: 'Unauthorized or connection not found' });
    }

    // Fetch workflow so we can resolve node metadata
    const wfRes = await getWorkflow(connectionId, workflowId);
    if (wfRes.error || !wfRes.data) {
      return res.status(wfRes.error?.status || 502).json({ error: 'Failed to fetch workflow from n8n' });
    }

    const wf = wfRes.data as N8nWorkflow;
    const resolvedNode =
      (typeof nodeKey === 'string' ? wf.nodes?.find((n) => n.name === nodeKey) : undefined) ||
      (typeof nodeId === 'string' ? wf.nodes?.find((n) => n.id === nodeId) : undefined);

    if (!resolvedNode) {
      return res.status(404).json({ error: 'Node not found in workflow' });
    }

    const effectiveNodeKey = resolvedNode.name;

    // Resolve execution id (latest if not provided)
    let effectiveExecutionId: string | null = typeof executionId === 'string' ? executionId : null;
    if (!effectiveExecutionId) {
      // Try to get from state first
      const { data: stateData } = await supabaseAdmin
        .from('workflow_node_state')
        .select('last_execution_id')
        .eq('connection_id', connectionId)
        .eq('workflow_id', workflowId)
        .eq('node_key', effectiveNodeKey)
        .single();

      if (stateData?.last_execution_id) {
        effectiveExecutionId = stateData.last_execution_id;
      } else {
        const list = await listRecentExecutions(connectionId, workflowId, 1, { includeData: false });
        const latest = list.data?.[0] as any;
        if (latest?.id) effectiveExecutionId = String(latest.id);
      }
    }

    if (process.env.NODE_INSPECT_DEBUG === '1') {
      console.log('[node-inspect] Cache headers set, executionId:', effectiveExecutionId);
    }

    if (!effectiveExecutionId) {
      return res.status(404).json({ error: 'No executions found for workflow' });
    }

    const execRes = await getExecution(connectionId, effectiveExecutionId);
    if (execRes.error || !execRes.data) {
      return res.status(execRes.error?.status || 502).json({ error: 'Failed to fetch execution from n8n' });
    }

    const exec = execRes.data as any;
    const rd = exec?.data?.resultData ?? exec?.resultData ?? exec?.data?.data?.resultData ?? null;
    const runData: Record<string, any[]> = (rd?.runData ?? {}) as any;

    // Check for missing execution data
    if (!rd || (!rd.runData || Object.keys(rd.runData).length === 0)) {
      return res.status(200).json({
        ok: true,
        executionId: effectiveExecutionId,
        node: {
          nodeId: resolvedNode.id || null,
          nodeName: resolvedNode.name,
          nodeType: resolvedNode.type,
        },
        status: 'not_run' as const,
        errorSummary: null,
        errorDetails: {
          message: 'Execution data not available via API; enable EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS in n8n for step runs.',
        },
        inputPreview: null,
        outputPreview: null,
        input: null,
        output: null,
        error: null,
        meta: {
          executionId: effectiveExecutionId,
          startedAt: exec.startedAt || null,
          stoppedAt: exec.stoppedAt || null,
        },
      });
    }
    const topError: any | null = (rd?.error ?? null) as any;
    const topErrorNodeName: string | null =
      (typeof topError?.node?.name === 'string' ? topError.node.name : null) ??
      (typeof topError?.node === 'string' ? topError.node : null) ??
      (typeof topError?.context?.node?.name === 'string' ? topError.context.node.name : null) ??
      null;
    const topErrorMessage: string | null =
      (typeof topError?.message === 'string' ? topError.message : null) ??
      (Array.isArray(topError?.messages) && typeof topError.messages[0] === 'string' ? topError.messages[0] : null) ??
      null;
    const subNodeMatch =
      topErrorMessage?.match(/sub-node\s+'([^']+)'/i) ??
      topErrorMessage?.match(/sub-node\s+"([^"]+)"/i) ??
      null;
    const subNodeName = subNodeMatch?.[1] || null;

    const nodeRuns = runData?.[effectiveNodeKey];
    const lastRun = Array.isArray(nodeRuns) && nodeRuns.length > 0 ? nodeRuns[nodeRuns.length - 1] : null;

    let status: 'success' | 'failed' | 'not_run' = 'not_run';
    let errorObj: unknown = null;
    const ran = !!lastRun;
    const runFailed = !!(lastRun && (lastRun?.error || lastRun?.executionStatus === 'error'));
    const failedByTopError = !!(
      (topErrorNodeName && topErrorNodeName === effectiveNodeKey) ||
      (subNodeName && subNodeName === effectiveNodeKey)
    );

    if (ran && !runFailed && !failedByTopError) status = 'success';
    if (runFailed || failedByTopError) status = 'failed';
    if (!ran && !failedByTopError) status = 'not_run';

    if (runFailed) errorObj = lastRun?.error || topError || null;
    else if (failedByTopError) errorObj = topError || null;

    // Error details (deep, but sanitized + truncated)
    const errorDetails = sanitizeForResponse(errorObj || null, { maxBytes: 20_000 });

    // Build errorSummary with fallbacks
    let errorSummary: string | null = null;
    if (status === 'failed') {
      if (errorObj) {
        errorSummary =
          typeof errorObj === 'string'
            ? errorObj.slice(0, 200)
            : (errorObj as any)?.message ||
            (Array.isArray((errorObj as any)?.messages) &&
              typeof (errorObj as any).messages[0] === 'string'
              ? (errorObj as any).messages[0]
              : null) ||
            (errorObj as any)?.name ||
            'Execution failed';
      }
      // Fallback: if errorSummary is still empty, use errorDetails.message
      if (!errorSummary && errorDetails) {
        errorSummary = (errorDetails as any)?.message || 'Execution failed';
      }
      // Final fallback
      if (!errorSummary) {
        errorSummary = 'Execution failed';
      }
    }

    // Build accurate input/output previews from runData
    const upstreamNodeNames = findUpstreamNodeNames(wf, effectiveNodeKey);
    const inputPreview = buildInputPreview(runData, upstreamNodeNames);
    const outputPreview = buildOutputPreview(runData, effectiveNodeKey);

    // Build response with new shape and backward compatibility
    res.json({
      ok: true,
      executionId: effectiveExecutionId,
      node: {
        nodeId: resolvedNode.id || null,
        nodeName: resolvedNode.name,
        nodeType: resolvedNode.type,
      },
      status,
      errorSummary,
      errorDetails,
      inputPreview,
      outputPreview,
      // Backward compatibility fields
      input: inputPreview?.mergedPreview || inputPreview?.sources[0]?.itemsPreview || null,
      output: outputPreview?.itemsPreview || null,
      error: errorDetails,
      meta: {
        executionId: effectiveExecutionId,
        startedAt: exec.startedAt || null,
        stoppedAt: exec.stoppedAt || null,
      },
    });
  } catch (e) {
    console.error('[node-inspect] failed', e);
    res.status(500).json({ error: 'Failed to inspect node' });
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
 * Upsert workflow_node_state rows in database (config + execution fields)
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
    // Your DB schema uses node_key (node name) as the primary unique identifier.
    // node_key is NOT NULL and has a UNIQUE constraint on (connection_id, workflow_id, node_key).
    node_key: node.name,

    // Store the true n8n node id too (nullable in DB; good for ReactFlow matching).
    node_id: node.id || null,
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
  if (rows.length > 0) {
    console.log('[V3] upsert sample', { node_id: rows[0].node_id, node_key: rows[0].node_key, node_name: rows[0].node_name });
  }
  for (const row of rows) {
    const { error } = await supabaseAdmin
      .from('workflow_node_state')
      .upsert(row, {
        // IMPORTANT: match your actual UNIQUE constraint
        onConflict: 'connection_id,workflow_id,node_key',
      });

    if (error) {
      console.error(`[V3] Failed to upsert node state for ${row.node_name}:`, error);
    }
  }
}

/**
 * Upsert workflow_node_state rows in database (config fields ONLY, skip execution fields)
 * Used by /sync to avoid overwriting execution results.
 */
async function upsertNodeConfigStates(
  userId: string,
  connectionId: string,
  workflowId: string,
  state: WorkflowState
): Promise<void> {
  const rows = state.nodes.map(node => ({
    user_id: userId,
    connection_id: connectionId,
    workflow_id: workflowId,
    node_key: node.name,
    node_id: node.id || null,
    node_name: node.name,
    node_type: node.type,
    configured_credentials: node.configured.credentials,
    configured_placeholders: node.configured.placeholders,
    configured_required_fields: node.configured.requiredFields,
    // DO NOT include: verified, failed, last_execution_id, last_error, last_run_at
    updated_at: new Date().toISOString(),
  }));

  for (const row of rows) {
    const { error } = await supabaseAdmin
      .from('workflow_node_state')
      .upsert(row, {
        onConflict: 'connection_id,workflow_id,node_key',
      });

    if (error) {
      console.error(`[V3] Failed to upsert node config for ${row.node_name}:`, error);
    }
  }
}



/**
 * V3.1: Upsert workflow nodes to link them to node library
 */
async function upsertWorkflowNodesFromWorkflow(
  connectionId: string,
  workflowId: string,
  workflow: N8nWorkflow
): Promise<void> {
  if (!workflow.nodes || workflow.nodes.length === 0) {
    return;
  }

  const subNodeTypes = new Set([
    '@n8n/n8n-nodes-langchain.lmChatOpenAi',
    '@n8n/n8n-nodes-langchain.lmChatAnthropic',
    '@n8n/n8n-nodes-langchain.lmChatOllama',
    '@n8n/n8n-nodes-langchain.toolCode',
    '@n8n/n8n-nodes-langchain.toolHttpRequest',
    '@n8n/n8n-nodes-langchain.memoryBufferWindow',
  ]);

  // Fetch node schemas for better summarization (batch fetch)
  const nodeTypes = [...new Set(workflow.nodes.map((n) => n.type).filter(Boolean))];
  const schemaMap = new Map<string, Record<string, unknown>>();

  for (const nodeType of nodeTypes) {
    const defResult = await getNodeDefinition(nodeType);
    if (defResult.data?.config_schema) {
      schemaMap.set(nodeType, defResult.data.config_schema as Record<string, unknown>);
    }
  }

  const workflowNodes: WorkflowNode[] = workflow.nodes.map((node) => {
    const nodeSchema = schemaMap.get(node.type);
    const paramsSummary = summarizeNodeParams(
      node.type,
      node.parameters || {},
      nodeSchema
    );

    return {
      connection_id: connectionId,
      workflow_id: workflowId,
      node_id: node.id || node.name,
      node_name: node.name,
      node_type: node.type,
      node_type_version: node.typeVersion !== undefined ? node.typeVersion : 0,
      node_package_version: null, // Default to null (empty string in DB)
      is_subnode: subNodeTypes.has(node.type),
      params_summary: paramsSummary,
    };
  });

  const result = await upsertWorkflowNodes(workflowNodes);
  if (result.error) {
    console.error('[V3] Failed to upsert workflow nodes:', result.error);
  } else {
    console.log(`[V3] Upserted ${workflowNodes.length} workflow nodes`);
  }
}
// ============================================================================
// V3.1 Node Library Routes
// ============================================================================

/**
 * GET /api/v3/node-library/health
 * Connectivity check endpoint - no auth required
 * Dashboard uses this to verify backend is reachable
 */
router.get('/v3/node-library/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'vibenoding-core',
    ts: Date.now(),
  });
});

/**
 * GET /api/v3/workflows/resolve?workflowId=...&connectionId=...
 * DEV ONLY: Diagnostic endpoint to test workflow ID resolution
 * Returns the resolved n8n workflow ID and source table
 * 
 * Guarded by NODE_ENV !== 'production' or ADMIN_API_KEY header
 */
router.get('/v3/workflows/resolve', async (req: Request, res: Response) => {
  // Guard: dev-only or admin key
  const isProduction = process.env.NODE_ENV === 'production';
  const adminKey = req.headers['x-admin-key'] as string | undefined;
  const expectedAdminKey = process.env.ADMIN_API_KEY;

  if (isProduction && (!expectedAdminKey || adminKey !== expectedAdminKey)) {
    return res.status(403).json({
      ok: false,
      error: 'This endpoint is only available in development mode or with admin key',
    });
  }

  const workflowId = (req.query.workflowId || req.query.workflow_id) as string | undefined;
  const connectionId = (req.query.connectionId || req.query.connection_id) as string | undefined;

  if (!workflowId || !connectionId) {
    return res.status(400).json({
      ok: false,
      error: 'Missing workflowId or connectionId query parameter',
    });
  }

  const result = await resolveN8nWorkflowId({ workflowId, connectionId });

  if (result.ok === false) {
    const statusCode =
      result.code === 'WORKFLOW_NOT_FOUND' ? 404
        : result.code === 'MISSING_N8N_ID' ? 404
          : result.code === 'DB_ERROR' ? 500
            : 400;
    return res.status(statusCode).json({
      ok: false,
      error: result.error,
      code: result.code,
      input: { workflowId, connectionId },
    });
  }

  res.json({
    ok: true,
    input: { workflowId, connectionId },
    resolved: {
      n8nWorkflowId: result.n8nWorkflowId,
      supabaseWorkflowId: result.supabaseWorkflowId,
      sourceTable: result.sourceTable,
    },
  });
});

/**
 * GET /api/v3/node-library/search
 * Search node library for node type definitions
 */
router.get('/v3/node-library/search', async (req: Request, res: Response) => {
  try {
    const q = req.query.q;
    const limit = parseInt(req.query.limit as string) || 10;

    if (typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'Missing or empty query parameter: q' });
    }

    const result = await searchNodeLibrary(q, Math.min(limit, 50));

    if (result.error) {
      console.error('[node-library] search failed:', result.error);
      return res.status(500).json({ error: 'Search failed' });
    }

    res.json({
      ok: true,
      query: q,
      results: result.data,
      count: result.data.length,
    });
  } catch (e) {
    console.error('[node-library] search error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v3/node-library/node
 * Get a node definition with its error patterns
 */
router.get('/v3/node-library/node', async (req: Request, res: Response) => {
  try {
    const nodeType = req.query.type;

    if (typeof nodeType !== 'string' || nodeType.trim().length === 0) {
      return res.status(400).json({ error: 'Missing or empty query parameter: type' });
    }

    const result = await getNodeWithPatterns(nodeType);

    if (result.error) {
      console.error('[node-library] getNode failed:', result.error);
      return res.status(500).json({ error: 'Failed to fetch node definition' });
    }

    if (!result.data.nodeDefinition) {
      return res.status(404).json({ error: 'Node type not found in library' });
    }

    res.json({
      ok: true,
      nodeDefinition: result.data.nodeDefinition,
      errorPatterns: result.data.errorPatterns,
    });
  } catch (e) {
    console.error('[node-library] getNode error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v3/node-library/sync-catalog?connectionId=...&refresh=false
 * Sync node type catalog from n8n instance
 */
router.post('/v3/node-library/sync-catalog', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId;
    const refresh = req.query.refresh === 'true';

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'routes/v3.ts:1078', message: 'sync-catalog route called', data: { connectionId, refresh }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'A' }) }).catch(() => { });
    // #endregion

    if (typeof connectionId !== 'string') {
      return res.status(400).json({ error: 'Missing connectionId query parameter' });
    }

    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({ error: 'Unauthorized or connection not found' });
    }

    // Get endpoint info for debug response
    const { discoverNodeCatalogEndpoint } = await import('../v3/n8nClient');
    const endpointResult = await discoverNodeCatalogEndpoint(connectionId);

    const result = await syncNodeTypeCatalog(connectionId, { refresh });

    // Count nodes with non-null config_schema (node_library_nodes doesn't have connection_id)
    const { data: nodesWithSchema } = await supabaseAdmin
      .from('node_library_nodes')
      .select('node_type')
      .not('config_schema', 'is', null);

    const withSchemaCount = nodesWithSchema?.length || 0;

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/64a46d96-58fd-4c47-936c-eca813d7ba71', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'routes/v3.ts:1092', message: 'sync-catalog result', data: { synced: result.synced, errors: result.errors, hasError: !!result.error, errorMessage: result.error?.message || null, endpoint: endpointResult.data?.endpoint || null, withSchemaCount }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'A' }) }).catch(() => { });
    // #endregion

    if (result.error) {
      console.error('[node-library] sync-catalog failed:', result.error);
      return res.status(500).json({
        error: 'Failed to sync catalog',
        details: result.error.message,
        endpoint: result.endpoint || endpointResult.data?.endpoint || null,
        endpointError: result.endpointError || (endpointResult.error ? { status: endpointResult.error.status, message: endpointResult.error.message } : null),
        canonicalFilledCount: result.canonicalFilledCount || 0,
        overrideFilledCount: result.overrideFilledCount || 0,
        stillNullCount: result.stillNullCount || 0,
        withSchemaCount,
      });
    }

    res.json({
      ok: true,
      synced: result.synced,
      errors: result.errors,
      endpoint: result.endpoint || endpointResult.data?.endpoint || null,
      endpointError: result.endpointError || null,
      canonicalFilledCount: result.canonicalFilledCount || 0,
      overrideFilledCount: result.overrideFilledCount || 0,
      stillNullCount: result.stillNullCount || 0,
      withSchemaCount,
    });
  } catch (e) {
    console.error('[node-library] sync-catalog error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Normalize canonical node entry to handle both camelCase and snake_case formats
 * Returns null if entry is invalid, with reason for rejection
 */
function normalizeCanonicalNode(raw: any): {
  nodeType: string;
  typeVersion: number;
  packageVersion: string;
  configSchema: any;
  credentialTypes: string[];
  displayName: string | null;
  packageName: string;
  docsUrl: string | null;
  category: string;
} | { rejected: true; reason: string } {
  // Normalize nodeType
  const nodeType = raw.node_type ?? raw.nodeType ?? '';
  if (typeof nodeType !== 'string' || nodeType === '') {
    return { rejected: true, reason: 'missing or invalid nodeType' };
  }

  // Normalize typeVersion - MUST be a valid number (not null, not NaN, not undefined)
  let typeVersion: number | null = null;
  if (raw.typeVersion !== undefined && raw.typeVersion !== null) {
    const tv = Number(raw.typeVersion);
    if (!isNaN(tv) && isFinite(tv)) {
      typeVersion = tv;
    }
  } else if (raw.type_version !== undefined && raw.type_version !== null) {
    const tv = Number(raw.type_version);
    if (!isNaN(tv) && isFinite(tv)) {
      typeVersion = tv;
    }
  }

  // Reject if typeVersion is missing/NaN/non-finite
  if (typeVersion === null || isNaN(typeVersion) || !isFinite(typeVersion)) {
    return { rejected: true, reason: `missing or invalid typeVersion (got: ${raw.typeVersion ?? raw.type_version ?? 'undefined'})` };
  }

  // Normalize packageVersion
  const packageVersion = raw.package_version ?? raw.packageVersion ?? raw.package?.version ?? '';

  // Normalize configSchema
  const configSchema = raw.config_schema ?? raw.configSchema ?? raw.schema ?? null;

  // Validate: skip entries missing configSchema
  if (!configSchema || typeof configSchema !== 'object') {
    return { rejected: true, reason: 'missing or invalid configSchema' };
  }

  // Validate: configSchema.properties MUST be an array
  const properties = configSchema.properties;
  if (!Array.isArray(properties)) {
    return { rejected: true, reason: `configSchema.properties is not an array (got: ${typeof properties})` };
  }

  // Skip placeholder schemas (properties.length === 0 AND schema_bytes < 200)
  const schemaStr = JSON.stringify(configSchema);
  const schemaBytes = Buffer.byteLength(schemaStr, 'utf8');
  if (properties.length === 0 && schemaBytes < 200) {
    return { rejected: true, reason: 'placeholder schema (empty properties and small size)' };
  }

  // Normalize other fields
  const credentialTypes = raw.credential_types ?? raw.credentialTypes ?? [];
  const displayName = raw.display_name ?? raw.displayName ?? null;
  const packageName = raw.package_name ?? raw.packageName ?? 'n8n-nodes-base';
  const docsUrl = raw.docs_url ?? raw.docsUrl ?? null;
  const category = raw.category ?? 'general';

  return {
    nodeType,
    typeVersion, // Now guaranteed to be a number
    packageVersion,
    configSchema,
    credentialTypes: Array.isArray(credentialTypes) ? credentialTypes : [],
    displayName,
    packageName,
    docsUrl,
    category,
  };
}

/**
 * POST /api/v3/node-library/import-canonical
 * Import canonical.json into node_library_canonical_schemas
 * Accepts canonical.json as POST body (object map) or loads from file
 * Processes in chunks to handle large imports
 */
router.post('/v3/node-library/import-canonical', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
  const chunkSize = parseInt(process.env.NODE_LIBRARY_IMPORT_CHUNK_SIZE || '10', 10);

  try {
    // Normalize input: accept POST body (array or object map) or load from file
    let entries: any[] = [];

    if (req.body && typeof req.body === 'object') {
      if (Array.isArray(req.body)) {
        // POST body is already an array
        entries = req.body;
      } else if (req.body.nodes && typeof req.body.nodes === 'object') {
        // POST body contains canonical.json structure with nodes object
        if (Array.isArray(req.body.nodes)) {
          entries = req.body.nodes;
        } else {
          entries = Object.values(req.body.nodes);
        }
      } else {
        // Try to treat as object map (keys are node types)
        entries = Object.values(req.body);
      }
    }

    // Fallback: load from file if no entries found
    if (entries.length === 0) {
      const { loadCanonicalCatalog } = await import('../catalog/loader');
      const catalog = loadCanonicalCatalog();
      if (catalog.nodes && Array.isArray(catalog.nodes) && catalog.nodes.length > 0) {
        entries = catalog.nodes;
      } else if (catalog.nodes && typeof catalog.nodes === 'object' && !Array.isArray(catalog.nodes)) {
        // Fallback for old format
        entries = Object.values(catalog.nodes);
      }
    }

    if (entries.length === 0) {
      return res.json({
        ok: true,
        scanned: 0,
        chunks: 0,
        inserted_or_updated: 0,
        skipped: 0,
        duration_ms: Date.now() - startTime,
      });
    }

    // Validate and normalize entries using helper
    const validEntries: Array<{
      nodeType: string;
      typeVersion: number;
      packageVersion: string;
      configSchema: any;
      credentialTypes: string[];
      displayName: string | null;
      packageName: string;
      docsUrl: string | null;
      category: string;
    }> = [];
    const rejectedEntries: Array<{ nodeType?: string; reason: string }> = [];
    let skippedInvalid = 0;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        skippedInvalid++;
        rejectedEntries.push({ reason: 'not an object' });
        continue;
      }

      const normalized = normalizeCanonicalNode(entry);
      if ('rejected' in normalized && normalized.rejected) {
        skippedInvalid++;
        const nodeType = entry.node_type ?? entry.nodeType ?? 'unknown';
        rejectedEntries.push({ nodeType, reason: normalized.reason });
        if (debugEnabled && rejectedEntries.length <= 10) {
          console.log(`[import-canonical] Rejected entry: ${nodeType} - ${normalized.reason}`);
        }
        continue;
      }

      // TypeScript: normalized is now guaranteed to be a valid entry (not rejected)
      const validNormalized = normalized as {
        nodeType: string;
        typeVersion: number;
        packageVersion: string;
        configSchema: any;
        credentialTypes: string[];
        displayName: string | null;
        packageName: string;
        docsUrl: string | null;
        category: string;
      };

      // Normalize node_type: strip .v\d+ suffix and add prefix if needed
      let normalizedNodeType = validNormalized.nodeType;
      let inferredTypeVersion: number | null = null;
      const versionSuffixMatch = normalizedNodeType.match(/\.v(\d+)$/);
      if (versionSuffixMatch) {
        normalizedNodeType = normalizedNodeType.replace(/\.v\d+$/, '');
        inferredTypeVersion = parseInt(versionSuffixMatch[1], 10);
      }

      if (!normalizedNodeType.includes('.')) {
        normalizedNodeType = `n8n-nodes-base.${normalizedNodeType}`;
      }

      // Use typeVersion from normalized entry (guaranteed to be a number), or inferred
      const finalTypeVersion = validNormalized.typeVersion !== null && validNormalized.typeVersion !== undefined
        ? validNormalized.typeVersion
        : (inferredTypeVersion !== null && !isNaN(inferredTypeVersion) ? inferredTypeVersion : null);

      // Final check: typeVersion must be a valid number
      if (finalTypeVersion === null || isNaN(finalTypeVersion) || !isFinite(finalTypeVersion)) {
        skippedInvalid++;
        rejectedEntries.push({ nodeType: normalizedNodeType, reason: `final typeVersion invalid: ${finalTypeVersion}` });
        continue;
      }

      validEntries.push({
        ...validNormalized,
        nodeType: normalizedNodeType,
        typeVersion: finalTypeVersion,
      });
    }

    if (validEntries.length === 0) {
      return res.json({
        ok: true,
        scanned: entries.length,
        chunks: 0,
        inserted_or_updated: 0,
        skipped: skippedInvalid,
        duration_ms: Date.now() - startTime,
      });
    }

    /**
     * Helper to check if schema is usable
     */
    function isUsableSchemaForDedup(configSchema: any): boolean {
      if (!configSchema || typeof configSchema !== 'object') return false;
      const properties = configSchema.properties;
      if (!Array.isArray(properties) || properties.length === 0) return false;
      const schemaStr = JSON.stringify(configSchema);
      const schemaBytes = Buffer.byteLength(schemaStr, 'utf8');
      return schemaBytes > 2000;
    }

    /**
     * Deduplicate rows by stable key: node_type|type_version|package_version
     * Keep the "best" row when duplicates exist
     */
    function deduplicateRows(rows: any[]): { unique: any[]; dropped: number } {
      const seen = new Map<string, any>();
      let dropped = 0;

      for (const row of rows) {
        // Skip rows with missing/NaN type_version
        if (row.type_version === null || row.type_version === undefined || isNaN(row.type_version) || !isFinite(row.type_version)) {
          dropped++;
          continue;
        }

        const key = `${row.node_type}|${row.type_version}|${row.package_version ?? ''}`;
        const existing = seen.get(key);

        if (!existing) {
          seen.set(key, row);
        } else {
          // Compare rows to keep the "best" one
          const existingUsable = isUsableSchemaForDedup(existing.config_schema);
          const currentUsable = isUsableSchemaForDedup(row.config_schema);

          if (currentUsable && !existingUsable) {
            // Current is usable, existing is not - replace
            seen.set(key, row);
            dropped++;
          } else if (!currentUsable && existingUsable) {
            // Existing is usable, current is not - keep existing
            dropped++;
          } else if (currentUsable && existingUsable) {
            // Both usable - compare properties.length and schema_bytes
            const existingProps = Array.isArray(existing.config_schema?.properties) ? existing.config_schema.properties.length : 0;
            const currentProps = Array.isArray(row.config_schema?.properties) ? row.config_schema.properties.length : 0;
            const existingBytes = JSON.stringify(existing.config_schema || {}).length;
            const currentBytes = JSON.stringify(row.config_schema || {}).length;

            if (currentProps > existingProps || (currentProps === existingProps && currentBytes > existingBytes)) {
              // Current is better - replace
              seen.set(key, row);
              dropped++;
            } else {
              // Existing is better - keep existing
              dropped++;
            }
          } else {
            // Neither usable - keep first encountered (existing)
            dropped++;
          }
        }
      }

      return { unique: Array.from(seen.values()), dropped };
    }

    // Build rows for node_library_canonical_schemas
    // Separate real version rows from type_version=0 alias rows
    const realVersionRows: any[] = [];
    const aliasRows: any[] = [];
    let httpRequestEntryCount = 0;

    for (const entry of validEntries) {
      // Track httpRequest entries
      if (entry.nodeType === 'n8n-nodes-base.httpRequest') {
        httpRequestEntryCount++;
      }

      // Use real typeVersion from entry (guaranteed to be a number)
      const typeVersion = entry.typeVersion;
      const packageVersion = entry.packageVersion || '';
      const schemaHash = computeSchemaHash(entry.configSchema);

      const row = {
        node_type: entry.nodeType,
        type_version: typeVersion,
        package_version: packageVersion,
        config_schema: entry.configSchema,
        credential_types: entry.credentialTypes.length > 0 ? entry.credentialTypes : null,
        schema_hash: schemaHash,
        fetched_at: new Date().toISOString(),
        source: 'canonical',
      };

      // Separate real versions from alias (type_version=0)
      if (typeVersion === 0) {
        aliasRows.push(row);
      } else {
        realVersionRows.push(row);
      }
    }

    // Deduplicate real version rows and alias rows separately
    const realDeduped = deduplicateRows(realVersionRows);
    const aliasDeduped = deduplicateRows(aliasRows);
    const totalDropped = realDeduped.dropped + aliasDeduped.dropped;
    const dedupedUnique = realDeduped.unique.length + aliasDeduped.unique.length;

    if (debugEnabled && totalDropped > 0) {
      console.log(`[import-canonical] Deduplicated: ${totalDropped} duplicates dropped, ${dedupedUnique} unique rows`);
    }

    // Process real version rows first, then aliases
    const allRows = [...realDeduped.unique, ...aliasDeduped.unique];

    // Process in chunks with error handling
    // After deduplication, error_count should be 0 (no duplicate conflict targets)
    let insertedOrUpdated = 0;
    let errorCount = 0;
    let firstError: string | null = null;
    const totalChunks = Math.ceil(allRows.length / chunkSize);

    for (let i = 0; i < allRows.length; i += chunkSize) {
      const chunk = allRows.slice(i, i + chunkSize);
      const chunkNum = Math.floor(i / chunkSize) + 1;

      if (debugEnabled) {
        console.log(`[import-canonical] Processing chunk ${chunkNum}/${totalChunks} (${chunk.length} rows)`);
      }

      try {
        const { error: chunkError } = await supabaseAdmin
          .from('node_library_canonical_schemas')
          .upsert(chunk, {
            onConflict: 'node_type,type_version,package_version',
          });

        if (chunkError) {
          // This should not happen after deduplication, but handle it gracefully
          errorCount++;
          if (!firstError) {
            firstError = chunkError.message || String(chunkError);
          }

          if (debugEnabled) {
            console.error(`[import-canonical] Chunk ${chunkNum} failed:`, chunkError);
            console.error(`[import-canonical] This may indicate duplicate conflict targets in chunk. Checking...`);

            // Debug: check for duplicates in chunk
            const chunkKeys = chunk.map(r => `${r.node_type}|${r.type_version}|${r.package_version ?? ''}`);
            const keyCounts = new Map<string, number>();
            for (const key of chunkKeys) {
              keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
            }
            const duplicates = Array.from(keyCounts.entries()).filter(([_, count]) => count > 1);
            if (duplicates.length > 0) {
              console.error(`[import-canonical] Found duplicate keys in chunk:`, duplicates);
            }
          }

          // Retry row-by-row to identify offending rows
          if (debugEnabled) {
            console.log(`[import-canonical] Retrying chunk ${chunkNum} row-by-row...`);
          }

          for (const row of chunk) {
            try {
              const { error: rowError } = await supabaseAdmin
                .from('node_library_canonical_schemas')
                .upsert([row], {
                  onConflict: 'node_type,type_version,package_version',
                });

              if (rowError) {
                errorCount++;
                if (debugEnabled) {
                  console.error(`[import-canonical] Row failed: ${row.node_type} v${row.type_version} -`, rowError.message || String(rowError));
                }
                // Skip this row and continue
              } else {
                insertedOrUpdated++;
              }
            } catch (rowErr) {
              errorCount++;
              if (debugEnabled) {
                console.error(`[import-canonical] Row exception: ${row.node_type} v${row.type_version} -`, rowErr instanceof Error ? rowErr.message : String(rowErr));
              }
            }
          }
        } else {
          insertedOrUpdated += chunk.length;
        }
      } catch (chunkErr) {
        errorCount++;
        if (!firstError) {
          firstError = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
        }

        if (debugEnabled) {
          console.error(`[import-canonical] Chunk ${chunkNum} exception:`, chunkErr);
        }

        // Retry row-by-row
        for (const row of chunk) {
          try {
            const { error: rowError } = await supabaseAdmin
              .from('node_library_canonical_schemas')
              .upsert([row], {
                onConflict: 'node_type,type_version,package_version',
              });

            if (!rowError) {
              insertedOrUpdated++;
            } else {
              errorCount++;
              if (debugEnabled) {
                console.error(`[import-canonical] Row failed: ${row.node_type} v${row.type_version} -`, rowError.message || String(rowError));
              }
            }
          } catch (rowErr) {
            errorCount++;
            if (debugEnabled) {
              console.error(`[import-canonical] Row exception: ${row.node_type} v${row.type_version} -`, rowErr instanceof Error ? rowErr.message : String(rowErr));
            }
          }
        }
      }
    }

    // Hard regression check: verify httpRequest has real schemas
    const { data: httpRequestRows } = await supabaseAdmin
      .from('node_library_canonical_schemas')
      .select('type_version, config_schema')
      .eq('node_type', 'n8n-nodes-base.httpRequest')
      .gt('type_version', 0); // Check for any real version > 0

    const httpRequestInserted = httpRequestRows?.length || 0;
    const hasRealSchema = httpRequestRows?.some(row => {
      if (!row.config_schema) return false;
      const schemaStr = JSON.stringify(row.config_schema);
      const schemaBytes = Buffer.byteLength(schemaStr, 'utf8');
      const properties = (row.config_schema as any)?.properties || [];
      const propertiesCount = Array.isArray(properties) ? properties.length : 0;
      return schemaBytes > 2000 && propertiesCount > 10;
    }) || false;

    if (!hasRealSchema) {
      const debugSummary = {
        httpRequestEntriesSeen: httpRequestEntryCount,
        httpRequestInserted,
        httpRequestRejected: rejectedEntries.filter(e => e.nodeType?.includes('httpRequest')).length,
        httpRequestDedupedDropped: realDeduped.unique.filter(r => r.node_type === 'n8n-nodes-base.httpRequest').length === 0
          ? realVersionRows.filter(r => r.node_type === 'n8n-nodes-base.httpRequest').length - realDeduped.unique.filter(r => r.node_type === 'n8n-nodes-base.httpRequest').length
          : 0,
        httpRequestRowsInDb: httpRequestRows?.map(r => ({
          type_version: r.type_version,
          schema_bytes: r.config_schema ? JSON.stringify(r.config_schema).length : 0,
          properties_count: Array.isArray((r.config_schema as any)?.properties) ? (r.config_schema as any).properties.length : 0,
        })) || [],
      };

      const errorMsg = `Regression check failed: httpRequest must have at least one row with type_version > 0 AND schema_bytes > 2000 AND properties_count > 10. ` +
        `Found ${httpRequestInserted} rows, but none satisfy requirements. ` +
        `Debug: ${JSON.stringify(debugSummary)}`;

      console.error(`[import-canonical] ${errorMsg}`);

      return res.status(500).json({
        ok: false,
        error: 'Regression check failed',
        message: errorMsg,
        debug_summary: debugSummary,
        scanned: entries.length,
        deduped_unique: dedupedUnique,
        deduped_dropped: totalDropped,
        chunks: totalChunks,
        inserted_or_updated: insertedOrUpdated,
        skipped: skippedInvalid,
        rejected_count: rejectedEntries.length,
        rejected_examples: rejectedEntries.slice(0, 5),
        error_count: errorCount,
        first_error: firstError || undefined,
        duration_ms: Date.now() - startTime,
      });
    }

    if (debugEnabled) {
      console.log(`[import-canonical] Regression check passed: httpRequest has ${httpRequestInserted} real schemas`);
    }

    const durationMs = Date.now() - startTime;

    if (debugEnabled) {
      console.log(`[import-canonical] Completed: ${insertedOrUpdated} rows in ${totalChunks} chunks, ${durationMs}ms`);
      if (rejectedEntries.length > 0) {
        console.log(`[import-canonical] Rejected ${rejectedEntries.length} entries`);
      }
      if (errorCount > 0) {
        console.log(`[import-canonical] ${errorCount} errors occurred`);
      }
    }

    res.json({
      ok: true,
      scanned: entries.length,
      deduped_unique: dedupedUnique,
      deduped_dropped: totalDropped,
      chunks: totalChunks,
      inserted_or_updated: insertedOrUpdated,
      skipped: skippedInvalid,
      rejected_count: rejectedEntries.length,
      rejected_examples: rejectedEntries.slice(0, 10),
      error_count: errorCount,
      first_error: firstError || undefined,
      duration_ms: durationMs,
    });
  } catch (e) {
    const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
    if (debugEnabled) {
      console.error('[node-library] import-canonical error:', e);
    }
    res.status(500).json({
      error: 'Internal server error',
      duration_ms: Date.now() - startTime,
    });
  }
});

/**
 * POST /api/v3/node-library/admin/backfill-canonical-schemas
 * Backfill node_library_canonical_schemas from existing node_library_nodes rows (admin only)
 * Guarded by ENABLE_NODE_LIBRARY_BACKFILL=1 and x-admin-secret header
 */
router.post('/v3/node-library/admin/backfill-canonical-schemas', async (req: Request, res: Response) => {
  try {
    const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

    // Guard: require both env flag and secret header
    const enableBackfill = process.env.ENABLE_NODE_LIBRARY_BACKFILL === '1';
    const adminSecret = req.headers['x-admin-secret'] as string;
    const expectedSecret = process.env.ADMIN_SECRET;

    if (!enableBackfill || !expectedSecret || adminSecret !== expectedSecret) {
      // Return 404 to avoid discovery
      return res.status(404).json({ error: 'Not found' });
    }

    // Find all rows in node_library_nodes with non-null config_schema
    const { data: legacyNodes, error: queryError } = await supabaseAdmin
      .from('node_library_nodes')
      .select('node_type, config_schema, credential_types, source, fetched_at')
      .not('config_schema', 'is', null);

    if (queryError) {
      if (debugEnabled) {
        console.error('[backfill-canonical-schemas] Failed to query legacy nodes:', queryError);
      }
      return res.status(500).json({ error: 'Failed to query legacy nodes', details: queryError.message });
    }

    if (!legacyNodes || legacyNodes.length === 0) {
      return res.json({
        ok: true,
        scanned: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        message: 'No legacy nodes found to backfill',
      });
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const node of legacyNodes) {
      const typeVersion = 0; // Default
      const packageVersion = ''; // Default
      const schemaHash = node.config_schema ? computeSchemaHash(node.config_schema as Record<string, unknown>) : null;

      // Check if canonical_schemas row already exists for this triplet
      const { data: existing } = await supabaseAdmin
        .from('node_library_canonical_schemas')
        .select('config_schema')
        .eq('node_type', node.node_type)
        .eq('type_version', typeVersion)
        .eq('package_version', packageVersion)
        .single();

      // For default triplet (type_version=0, package_version=''), update if incoming config_schema is non-null
      // Otherwise, skip if already exists
      if (existing && existing.config_schema !== null && node.config_schema === null) {
        skipped++;
        if (debugEnabled) {
          console.log(`[backfill-canonical-schemas] Skipped ${node.node_type} (already exists with non-null schema)`);
        }
        continue;
      }

      const canonicalSchemaData = {
        node_type: node.node_type,
        type_version: typeVersion,
        package_version: packageVersion,
        config_schema: node.config_schema,
        credential_types: node.credential_types || null,
        schema_hash: schemaHash,
        fetched_at: node.fetched_at || new Date().toISOString(),
        source: 'canonical',
      };

      const { error: upsertError } = await supabaseAdmin
        .from('node_library_canonical_schemas')
        .upsert(canonicalSchemaData, { onConflict: 'node_type,type_version,package_version' });

      if (upsertError) {
        if (debugEnabled) {
          console.error(`[backfill-canonical-schemas] Failed to upsert ${node.node_type}:`, upsertError);
        }
        skipped++;
      } else {
        if (existing) {
          updated++;
          if (debugEnabled) {
            console.log(`[backfill-canonical-schemas] Updated ${node.node_type} (typeVersion: ${typeVersion}, packageVersion: ${packageVersion})`);
          }
        } else {
          inserted++;
          if (debugEnabled) {
            console.log(`[backfill-canonical-schemas] Inserted ${node.node_type} (typeVersion: ${typeVersion}, packageVersion: ${packageVersion})`);
          }
        }
      }
    }

    res.json({
      ok: true,
      scanned: legacyNodes.length,
      inserted,
      updated,
      skipped,
    });
  } catch (e) {
    const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
    if (debugEnabled) {
      console.error('[node-library] backfill-canonical-schemas error:', e);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v3/node-library/debug-node?connectionId=...&nodeType=...
 * Debug endpoint to see which source is used for a node type
 */
router.get('/v3/node-library/debug-node', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId;
    const nodeType = req.query.nodeType;

    if (typeof connectionId !== 'string' || typeof nodeType !== 'string') {
      return res.status(400).json({ error: 'Missing connectionId or nodeType query parameters' });
    }

    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({ error: 'Unauthorized or connection not found' });
    }

    // Get node from library
    const { data: libraryNode } = await supabaseAdmin
      .from('node_library_nodes')
      .select('node_type, config_schema, credential_types, source, package_name, package_version, schema_hash, fetched_at')
      .eq('node_type', nodeType)
      .single();

    // Get override if exists
    const { data: override } = await supabaseAdmin
      .from('node_library_node_overrides')
      .select('config_schema, credential_types, source, fetched_at')
      .eq('connection_id', connectionId)
      .eq('node_type', nodeType)
      .single();

    // Get canonical entry
    const { getCanonicalEntry } = await import('../catalog/loader');
    const canonical = getCanonicalEntry(nodeType);

    // Determine which source is used
    let activeSource = 'none';
    let reason = '';

    if (override?.config_schema) {
      activeSource = 'override';
      reason = 'Instance-specific override exists';
    } else if (canonical?.config_schema) {
      activeSource = 'canonical';
      reason = 'Using canonical catalog (no instance override)';
    } else if (libraryNode?.config_schema) {
      activeSource = libraryNode.source || 'unknown';
      reason = `Using existing library entry (source: ${libraryNode.source || 'unknown'})`;
    } else {
      activeSource = 'none';
      reason = 'No config_schema available (NULL)';
    }

    res.json({
      node_type: nodeType,
      connection_id: connectionId,
      active_source: activeSource,
      reason,
      library: libraryNode ? {
        has_schema: !!libraryNode.config_schema,
        source: libraryNode.source,
        package_name: libraryNode.package_name,
        package_version: libraryNode.package_version,
        schema_hash: libraryNode.schema_hash,
        fetched_at: libraryNode.fetched_at,
      } : null,
      override: override ? {
        has_schema: !!override.config_schema,
        source: override.source,
        fetched_at: override.fetched_at,
      } : null,
      canonical: canonical ? {
        has_schema: !!canonical.config_schema,
        package_name: canonical.package_name,
        package_version: canonical.package_version,
      } : null,
    });
  } catch (e) {
    console.error('[node-library] debug-node error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v3/node-library/resolve-schema?connectionId=...&nodeType=...&typeVersion=...&packageVersion=...
 * Resolve schema for a node with typeVersion-aware resolution
 * 
 * Modes:
 * 1) Canonical-only (connectionId missing/empty): Resolves from canonical_schemas only
 * 2) Full resolution (connectionId provided): Resolves from overrides + canonical
 */
router.get('/v3/node-library/resolve-schema', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId;
    const nodeType = req.query.nodeType;
    const typeVersion = req.query.typeVersion;
    const packageVersion = req.query.packageVersion;
    const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';

    // nodeType is always required
    if (typeof nodeType !== 'string') {
      return res.status(400).json({
        error: 'Missing required query parameters',
        details: 'nodeType is required',
      });
    }

    // connectionId is optional - if provided, validate it; if missing/empty, use canonical-only mode
    let validatedConnectionId: string | null = null;
    if (connectionId !== undefined && connectionId !== null && connectionId !== '') {
      if (typeof connectionId !== 'string') {
        return res.status(400).json({
          error: 'Invalid connectionId',
          details: 'connectionId must be a string',
        });
      }

      // Validate connection exists and user has access
      const userId = await resolveUserIdForConnection(req, connectionId);
      if (!userId) {
        // Return 404 (not 403) to avoid leaking behavior
        return res.status(404).json({ error: 'connection not found' });
      }
      validatedConnectionId = connectionId;
    }

    // Parse typeVersion to int (null if not provided or invalid)
    let typeVersionInt: number | null = null;
    if (typeVersion !== undefined && typeVersion !== null) {
      const parsed = Number(typeVersion);
      if (!isNaN(parsed) && isFinite(parsed)) {
        typeVersionInt = parsed;
      } else {
        return res.status(400).json({
          error: 'Invalid typeVersion',
          details: 'typeVersion must be a valid integer',
        });
      }
    }

    // Parse packageVersion to string (default to empty string)
    const packageVersionStr = packageVersion !== undefined && packageVersion !== null ? String(packageVersion) : '';

    const { resolveSchemaForNode } = await import('../v3/nodeLibrary');
    const resolved = await resolveSchemaForNode({
      connectionId: validatedConnectionId,
      nodeType,
      typeVersion: typeVersionInt,
      packageVersion: packageVersionStr,
    });

    // Build meta object - omit connectionId if null
    const meta: any = {
      nodeType,
      typeVersion: typeVersionInt,
      packageVersion: packageVersionStr,
    };
    if (validatedConnectionId !== null) {
      meta.connectionId = validatedConnectionId;
    }

    res.json({
      ok: true,
      meta,
      resolved,
    });
  } catch (e) {
    const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
    if (debugEnabled) {
      console.error('[node-library] resolve-schema error:', e);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v3/node-library/admin/ensure-patterns
 * Ensure generic error patterns exist (admin only)
 */
router.post('/v3/node-library/admin/ensure-patterns', async (req: Request, res: Response) => {
  try {
    const adminKey = req.headers['x-admin-key'] as string;
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey || adminKey !== expectedKey) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const result = await ensureGenericErrorPatterns();

    if (result.error) {
      console.error('[node-library] ensure-patterns failed:', result.error);
      return res.status(500).json({ error: 'Failed to ensure patterns', details: result.error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[node-library] ensure-patterns error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v3/node-library/admin/backfill-schemas?connectionId=...
 * Backfill missing config_schema for node_library_nodes (admin only)
 */
router.post('/v3/node-library/admin/backfill-schemas', async (req: Request, res: Response) => {
  try {
    const adminKey = req.headers['x-admin-key'] as string;
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey || adminKey !== expectedKey) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const connectionId = req.query.connectionId as string | undefined;

    const result = await backfillNodeLibrarySchemas(connectionId);

    if (result.error) {
      console.error('[node-library] backfill-schemas failed:', result.error);
      return res.status(500).json({ error: 'Failed to backfill schemas', details: result.error.message });
    }

    res.json({
      ok: true,
      filled: result.filled,
      errors: result.errors,
    });
  } catch (e) {
    console.error('[node-library] backfill-schemas error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v3/node-library/admin/backfill-summaries?connectionId=...
 * Backfill missing params_summary for workflow_nodes (admin only)
 */
router.post('/v3/node-library/admin/backfill-summaries', async (req: Request, res: Response) => {
  try {
    const adminKey = req.headers['x-admin-key'] as string;
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey || adminKey !== expectedKey) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const connectionId = req.query.connectionId;
    if (typeof connectionId !== 'string') {
      return res.status(400).json({ error: 'Missing connectionId query parameter' });
    }

    const result = await backfillWorkflowNodeSummaries(connectionId);

    if (result.error) {
      console.error('[node-library] backfill-summaries failed:', result.error);
      return res.status(500).json({ error: 'Failed to backfill summaries', details: result.error.message });
    }

    res.json({
      ok: true,
      filled: result.filled,
      errors: result.errors,
    });
  } catch (e) {
    console.error('[node-library] backfill-summaries error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v3/node-library/admin/repair-schemas?connectionId=...
 * Repair stub/NULL node library schemas (admin only)
 */
router.post('/v3/node-library/admin/repair-schemas', async (req: Request, res: Response) => {
  try {
    const adminKey = req.headers['x-admin-key'] as string;
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey || adminKey !== expectedKey) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const connectionId = req.query.connectionId;
    if (typeof connectionId !== 'string') {
      return res.status(400).json({ error: 'Missing connectionId query parameter' });
    }

    const result = await repairNodeLibrarySchemas(connectionId);

    if (result.error) {
      console.error('[node-library] repair-schemas failed:', result.error);
      return res.status(500).json({ error: 'Failed to repair schemas', details: result.error.message });
    }

    res.json({
      ok: true,
      repaired: result.repaired,
      errors: result.errors,
    });
  } catch (e) {
    console.error('[node-library] repair-schemas error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v3/node-library/admin/seed
 * Seed the node library from JSON file (admin only)
 */
router.post('/v3/node-library/admin/seed', async (req: Request, res: Response) => {
  try {
    const adminKey = req.headers['x-admin-key'] as string;
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey) {
      console.error('[node-library] ADMIN_API_KEY not configured');
      return res.status(500).json({ error: 'Admin API not configured' });
    }

    if (!adminKey || adminKey !== expectedKey) {
      return res.status(403).json({ error: 'Invalid or missing admin key' });
    }

    const overwrite = req.body?.overwrite === true;
    const seedPath = process.env.NODE_LIBRARY_SEED_PATH || 'src/v3/nodeLibrarySeed.json';

    console.log(`[node-library] Seeding from ${seedPath} (overwrite: ${overwrite})`);

    const result = await seedNodeLibraryFromJson(seedPath, { overwrite });

    if (result.error) {
      return res.status(500).json({ error: result.error.message });
    }

    res.json({
      ok: true,
      nodesSeeded: result.nodesSeeded,
      patternsSeeded: result.patternsSeeded,
    });
  } catch (e) {
    console.error('[node-library] seed error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});


/**
 * GET /api/v3/node-context
 * Build a context pack for LLM consumption - merges runtime + library data
 */
router.get('/v3/node-context', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId;
    const workflowId = req.query.workflowId;
    const nodeId = req.query.nodeId;
    const nodeKey = req.query.nodeKey;
    const executionId = req.query.executionId;

    if (typeof connectionId !== 'string' || typeof workflowId !== 'string') {
      return res.status(400).json({ error: 'Missing connectionId or workflowId' });
    }

    if (typeof nodeId !== 'string' && typeof nodeKey !== 'string') {
      return res.status(400).json({ error: 'Missing nodeId or nodeKey' });
    }

    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({ error: 'Unauthorized or connection not found' });
    }

    // 1. Get workflow node from our database
    let workflowNode: WorkflowNode | null = null;
    if (typeof nodeId === 'string') {
      const result = await getWorkflowNode(connectionId, workflowId, nodeId);
      workflowNode = result.data;
    }
    if (!workflowNode && typeof nodeKey === 'string') {
      const result = await getWorkflowNodeByName(connectionId, workflowId, nodeKey);
      workflowNode = result.data;
    }

    // 2. Get workflow node state from database
    let state: any = null;
    const nodeKeyForState = workflowNode?.node_name || (typeof nodeKey === 'string' ? nodeKey : null);
    if (nodeKeyForState) {
      const { data } = await supabaseAdmin
        .from('workflow_node_state')
        .select('verified, failed, last_error, last_run_at, last_execution_id, updated_at')
        .eq('connection_id', connectionId)
        .eq('workflow_id', workflowId)
        .eq('node_key', nodeKeyForState)
        .single();

      if (data) {
        state = {
          status: data.verified ? 'success' : data.failed ? 'failed' : 'not_run',
          last_error: data.last_error,
          last_run_at: data.last_run_at,
          last_execution_id: data.last_execution_id,
          updated_at: data.updated_at,
        };
      }
    }

    // 3. Get library data
    const nodeType = workflowNode?.node_type || null;
    const nodeTypeVersion = workflowNode?.node_type_version !== undefined ? workflowNode.node_type_version : null;
    const nodePackageVersion = workflowNode?.node_package_version !== undefined ? workflowNode.node_package_version : null;
    let nodeDefinition: NodeLibraryNode | null = null;
    let errorPatterns: any[] = [];
    let matchedPattern = null;
    let resolvedSchemaSource: 'override' | 'canonical' | 'canonical_nearest_lower' | 'canonical_legacy' | 'none' = 'none';
    let resolvedSchema: Record<string, unknown> | null = null;

    if (nodeType) {
      const currentError = state?.last_error || null;
      const libResult = await getNodeWithPatterns(nodeType, {
        errorText: typeof currentError === 'string' ? currentError : undefined,
        operation: workflowNode?.params_summary?.operation as string | undefined,
      });
      if (!libResult.error) {
        nodeDefinition = libResult.data.nodeDefinition;
        errorPatterns = libResult.data.errorPatterns;

        if (currentError && errorPatterns.length > 0) {
          matchedPattern = matchErrorPattern(errorPatterns, currentError);
        }
      }

      // Resolve schema with typeVersion-aware resolution
      const { resolveSchemaForNode } = await import('../v3/nodeLibrary');
      const resolved = await resolveSchemaForNode({
        connectionId,
        nodeType,
        typeVersion: nodeTypeVersion,
        packageVersion: nodePackageVersion,
      });
      resolvedSchemaSource = resolved.source;
      resolvedSchema = resolved.config_schema;

      // If nodeDefinition is still null, create a stub (DO NOT insert to DB)
      if (!nodeDefinition && nodeType) {
        const debugEnabled = process.env.NODE_LIBRARY_DEBUG === '1';
        if (debugEnabled) {
          console.log(`[node-context] Using stub for node_type: ${nodeType}`);
        }
        const lastSegment = nodeType.split('.').pop() || nodeType;
        nodeDefinition = {
          node_type: nodeType,
          display_name: lastSegment,
          category: 'general',
          description: '',
          docs_url: null,
          credential_types: null,
          config_schema: null,
          input_hints: null,
          output_hints: null,
          troubleshooting: null,
          search_text: nodeType,
        };
      }
    }

    // 4. Build context pack
    const contextPack: NodeContextPack = {
      meta: {
        connectionId,
        workflowId,
        nodeId: typeof nodeId === 'string' ? nodeId : (workflowNode?.node_id || ''),
        executionId: state?.last_execution_id || undefined,
      },
      workflowNode: workflowNode ? {
        node_id: workflowNode.node_id,
        node_name: workflowNode.node_name,
        node_type: workflowNode.node_type,
        nodeTypeVersion: workflowNode.node_type_version !== undefined ? workflowNode.node_type_version : null,
        is_subnode: workflowNode.is_subnode,
        is_executable: isExecutableNodeType(workflowNode.node_type),
      } : null,
      state,
      inspect: null,
      library: {
        nodeDefinition: nodeDefinition || {
          node_type: nodeType || '',
          display_name: nodeType || '',
          category: 'general',
          description: '',
          docs_url: null,
          credential_types: null,
          config_schema: null,
          input_hints: null,
          output_hints: null,
          troubleshooting: null,
          search_text: nodeType || '',
        },
        errorPatterns,
        matchedPattern,
        resolvedSchemaSource,
        resolvedSchema,
      },
    };

    res.json({
      ok: true,
      context: contextPack,
    });
  } catch (e) {
    console.error('[node-context] error:', e);
    res.status(500).json({ error: 'Failed to build node context' });
  }
});

// ============================================================================
// SANDBOX ENGINE ENDPOINTS (V3.3)
// ============================================================================

/**
 * POST /api/v3/workflows/:workflowUuid/sandbox/ensure
 * Ensure a test workflow exists for the given production workflow.
 * Creates a clone if one doesn't exist.
 */
router.post('/v3/workflows/:workflowUuid/sandbox/ensure', async (req: Request, res: Response) => {
  try {
    const { workflowUuid } = req.params;
    const { connectionId } = req.body;

    // Debug mode: if keepFailed=1, don't delete workflow on failure (for inspection)
    const keepFailed = req.query.keepFailed === '1';
    if (keepFailed) {
      console.log('[sandbox/ensure] DEBUG MODE: keepFailed=1, will NOT delete workflow on failure');
    }

    // 1. Validate input
    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing connectionId in request body',
      });
    }

    if (!workflowUuid || typeof workflowUuid !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing workflowUuid in URL path',
      });
    }

    // 2. Resolve user
    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized or connection not found',
      });
    }

    // 3. Resolve n8n workflow ID
    const resolveResult = await resolveN8nWorkflowId({
      workflowId: workflowUuid,
      connectionId,
      userId,
    });
    if (resolveResult.ok === false) {
      return res.status(404).json({
        ok: false,
        error: resolveResult.error,
        code: resolveResult.code,
      });
    }
    const n8nWorkflowId = resolveResult.n8nWorkflowId;

    // 4. Check if test workflow already exists
    const { data: existingTest, error: lookupError } = await supabaseAdmin
      .from('vn_test_workflows')
      .select('*')
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .eq('prod_workflow_uuid', workflowUuid)
      .maybeSingle();

    if (lookupError) {
      console.error('[sandbox/ensure] DB lookup error:', lookupError);
      return res.status(500).json({
        ok: false,
        error: 'Database error',
      });
    }

    // If exists, activate and verify (self-healing)
    if (existingTest) {
      console.log(`[sandbox/ensure] Existing test workflow found: ${existingTest.test_n8n_workflow_id}`);

      // Get base URL for webhook verification
      const baseUrlResult = await getConnectionBaseUrl(connectionId);
      if (baseUrlResult.error) {
        return res.status(500).json({
          ok: false,
          error: 'Failed to get connection URL',
        });
      }
      const baseUrl = baseUrlResult.data!;
      const webhookUrl = buildWebhookUrl(baseUrl, existingTest.test_webhook_path_secret);

      // Always activate the workflow
      console.log(`[sandbox/ensure] Activating existing test workflow: ${existingTest.test_n8n_workflow_id}`);
      const activateResult = await setWorkflowActive(connectionId, existingTest.test_n8n_workflow_id, true);
      if (activateResult.error) {
        console.error('[sandbox/ensure] Failed to activate existing workflow:', activateResult.error);
        // Don't return error yet - continue to webhook verification
      } else {
        const { endpointUsed, verified } = activateResult.data!;
        console.log(`[sandbox/ensure] Activated via ${endpointUsed}, verified=${verified}`);

        if (!verified) {
          console.warn('[sandbox/ensure] Activation call succeeded but verification failed');
        }
      }

      // Verify webhook is registered by calling it with test payload
      console.log(`[sandbox/ensure] Verifying webhook registration: ${webhookUrl}`);
      const verifyResult = await invokeWebhook(
        baseUrl,
        existingTest.test_webhook_path_secret,
        { test: true, timestamp: Date.now() },
        { 'X-VN-Test-Secret': existingTest.webhook_auth_secret }
      );

      // If webhook verification succeeds (any non-404 status), return existing workflow
      if (verifyResult.status !== 404) {
        console.log(`[sandbox/ensure] Webhook verified successfully (status: ${verifyResult.status})`);
        return res.json({
          ok: true,
          created: false,
          testWorkflow: {
            id: existingTest.id,
            testN8nWorkflowId: existingTest.test_n8n_workflow_id,
            webhookUrl,
            webhookSecret: existingTest.webhook_auth_secret,
            createdAt: existingTest.created_at,
          },
        });
      }

      // Webhook verification failed (404) - delete and recreate
      console.warn('[sandbox/ensure] Webhook verification failed (404), deleting old workflow and recreating...');

      // Delete old workflow in n8n
      await deleteWorkflow(connectionId, existingTest.test_n8n_workflow_id).catch((e) => {
        console.error('[sandbox/ensure] Failed to delete old test workflow:', e);
      });

      // Delete DB record
      const { error: deleteError } = await supabaseAdmin
        .from('vn_test_workflows')
        .delete()
        .eq('id', existingTest.id);

      if (deleteError) {
        console.error('[sandbox/ensure] Failed to delete DB record:', deleteError);
      }

      console.log('[sandbox/ensure] Old workflow deleted, proceeding to create new one...');
      // Fall through to create new workflow
    }

    // 5. Fetch production workflow from n8n
    const prodResult = await getWorkflow(connectionId, n8nWorkflowId);
    if (prodResult.error) {
      return res.status(prodResult.error.status).json({
        ok: false,
        error: `Failed to fetch production workflow: ${prodResult.error.message}`,
      });
    }
    const prodWorkflow = prodResult.data!;

    // 6. Generate webhook path and secret
    const webhookPath = generateWebhookPath(connectionId, workflowUuid);
    const webhookSecret = generateWebhookSecret();

    // 7. Clone workflow for testing
    const { workflow: testWorkflowJson } = cloneWorkflowForTest(
      prodWorkflow,
      webhookPath,
      webhookSecret
    );

    // 8. Create test workflow in n8n
    const createResult = await createWorkflow(connectionId, testWorkflowJson);
    if (createResult.error) {
      console.error('[sandbox/ensure] Failed to create test workflow in n8n:', createResult.error);
      return res.status(500).json({
        ok: false,
        error: `Failed to create test workflow in n8n: ${createResult.error.message}`,
        n8n_status: createResult.error.status,
        n8n_body: createResult.error.details,
      });
    }
    const createdWorkflow = createResult.data!;
    console.log(`[sandbox/ensure] Workflow created in n8n with ID: ${createdWorkflow.id}`);

    // ========== DIAGNOSTIC: Fetch workflow back from n8n to verify what was actually created ==========
    const diagFetch = await getWorkflow(connectionId, createdWorkflow.id);
    if (diagFetch.data) {
      const wf = diagFetch.data;
      const webhookNodes = wf.nodes.filter((n: { type: string }) => n.type === 'n8n-nodes-base.webhook');

      console.log('[sandbox/ensure] === DIAGNOSTIC: Workflow fetched from n8n ===');
      console.log(JSON.stringify({
        workflow_id: wf.id,
        workflow_name: wf.name,
        workflow_active: wf.active,
        total_nodes: wf.nodes.length,
        webhook_nodes_count: webhookNodes.length,
        webhook_nodes: webhookNodes.map((n: { name: string; type: string; typeVersion?: number; disabled?: boolean; parameters?: Record<string, unknown> }) => ({
          name: n.name,
          type: n.type,
          typeVersion: n.typeVersion,
          disabled: n.disabled,
          'parameters.path': n.parameters?.path,
          'parameters.httpMethod': n.parameters?.httpMethod,
          'parameters.responseMode': n.parameters?.responseMode,
        })),
        all_node_types: wf.nodes.map((n: { name: string; type: string; disabled?: boolean }) => ({
          name: n.name,
          type: n.type,
          disabled: n.disabled
        })),
      }, null, 2));
      console.log('[sandbox/ensure] === END DIAGNOSTIC ===');
    } else {
      console.warn('[sandbox/ensure] Could not fetch workflow back from n8n for diagnostics');
    }
    // ========== END DIAGNOSTIC ==========

    // 8b. Activate the workflow so /webhook/ URLs work (production webhooks require active workflows)
    console.log(`[sandbox/ensure] Activating test workflow: ${createdWorkflow.id}`);
    const activateResult = await setWorkflowActive(connectionId, createdWorkflow.id, true);
    if (activateResult.error) {
      console.error('[sandbox/ensure] Failed to activate test workflow:', {
        workflowId: createdWorkflow.id,
        status: activateResult.error.status,
        message: activateResult.error.message,
        details: activateResult.error.details,
      });

      // Cleanup: delete the inactive workflow since it won't be usable (unless keepFailed)
      if (!keepFailed) {
        await deleteWorkflow(connectionId, createdWorkflow.id).catch((e) => {
          console.error('[sandbox/ensure] Failed to cleanup inactive workflow:', e);
        });
      } else {
        console.log(`[sandbox/ensure] keepFailed=1: NOT deleting workflow ${createdWorkflow.id} - inspect in n8n UI`);
      }

      return res.status(500).json({
        ok: false,
        error: `Failed to activate test workflow: ${activateResult.error.message}`,
        n8n_status: activateResult.error.status,
        n8n_body: activateResult.error.details,
        workflow_id: createdWorkflow.id,
        keep_failed: keepFailed,
      });
    }

    const { endpointUsed, verified } = activateResult.data!;
    console.log(`[sandbox/ensure] Test workflow activated via ${endpointUsed}, verified=${verified}`);

    if (!verified) {
      console.error('[sandbox/ensure] Activation call succeeded but verification failed');

      // Cleanup: delete the workflow that won't activate properly (unless keepFailed)
      if (!keepFailed) {
        await deleteWorkflow(connectionId, createdWorkflow.id).catch((e) => {
          console.error('[sandbox/ensure] Failed to cleanup unverified workflow:', e);
        });
      } else {
        console.log(`[sandbox/ensure] keepFailed=1: NOT deleting workflow ${createdWorkflow.id} - inspect in n8n UI`);
      }

      return res.status(500).json({
        ok: false,
        error: 'Workflow activation reported success but verification failed - workflow may not support activation',
        endpoint_used: endpointUsed,
        workflow_id: createdWorkflow.id,
        keep_failed: keepFailed,
      });
    }

    // 9. Store in database
    const { data: insertedRow, error: insertError } = await supabaseAdmin
      .from('vn_test_workflows')
      .insert({
        user_id: userId,
        connection_id: connectionId,
        prod_workflow_uuid: workflowUuid,
        test_n8n_workflow_id: createdWorkflow.id,
        test_webhook_path_secret: webhookPath,
        webhook_auth_secret: webhookSecret,
      })
      .select()
      .single();

    if (insertError) {
      // Cleanup: delete the n8n workflow since DB insert failed
      console.error('[sandbox/ensure] DB insert failed, cleaning up n8n workflow:', insertError);
      await deleteWorkflow(connectionId, createdWorkflow.id).catch((e) => {
        console.error('[sandbox/ensure] Failed to cleanup n8n workflow:', e);
      });

      return res.status(500).json({
        ok: false,
        error: 'Failed to store test workflow reference',
      });
    }

    // 10. Wait for webhook registration and verify with retries
    const baseUrlResult = await getConnectionBaseUrl(connectionId);
    const baseUrl = baseUrlResult.data || '';
    const webhookUrl = buildWebhookUrl(baseUrl, insertedRow.test_webhook_path_secret);

    // Retry webhook verification with increasing delays (n8n Cloud can be slow)
    const verifyDelays = [1000, 2000, 3000]; // Total: up to 6 seconds of waiting
    let verifyResult: { status: number; data: unknown; latencyMs: number; error?: string } = { status: 0, data: {}, latencyMs: 0 };
    let webhookRegistered = false;

    for (let attempt = 0; attempt < verifyDelays.length; attempt++) {
      const delayMs = verifyDelays[attempt];
      console.log(`[sandbox/ensure] Webhook verification attempt ${attempt + 1}/${verifyDelays.length}, waiting ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));

      console.log(`[sandbox/ensure] Verifying webhook registration: ${webhookUrl}`);
      verifyResult = await invokeWebhook(
        baseUrl,
        insertedRow.test_webhook_path_secret,
        { test: true, timestamp: Date.now() },
        { 'X-VN-Test-Secret': insertedRow.webhook_auth_secret }
      );

      if (verifyResult.status !== 404) {
        console.log(`[sandbox/ensure] Webhook verified successfully on attempt ${attempt + 1} (status: ${verifyResult.status})`);
        webhookRegistered = true;
        break;
      }

      console.log(`[sandbox/ensure] Attempt ${attempt + 1} returned 404, will retry...`);
    }

    if (!webhookRegistered) {
      console.error('[sandbox/ensure] CRITICAL: Webhook verification failed with 404 after all retries!');
      console.error('[sandbox/ensure] Webhook URL:', webhookUrl);
      console.error('[sandbox/ensure] Workflow ID:', createdWorkflow.id);
      console.error('[sandbox/ensure] Response:', verifyResult.data);

      // Fetch final workflow state for diagnostics
      let finalDiagnostics: Record<string, unknown> = {};
      const finalFetch = await getWorkflow(connectionId, createdWorkflow.id);
      if (finalFetch.data) {
        const wf = finalFetch.data;
        const webhookNodes = wf.nodes.filter((n: { type: string }) => n.type === 'n8n-nodes-base.webhook');
        finalDiagnostics = {
          workflow_active_in_n8n: wf.active,
          webhook_nodes: webhookNodes.map((n: { name: string; disabled?: boolean; parameters?: Record<string, unknown> }) => ({
            name: n.name,
            disabled: n.disabled,
            path: n.parameters?.path,
            httpMethod: n.parameters?.httpMethod,
          })),
        };
        console.error('[sandbox/ensure] FINAL DIAGNOSTIC:', JSON.stringify(finalDiagnostics, null, 2));
      }

      // Clean up the broken workflow (unless keepFailed)
      if (!keepFailed) {
        console.log('[sandbox/ensure] Cleaning up broken workflow...');
        try {
          await deleteWorkflow(connectionId, createdWorkflow.id);
        } catch (e) {
          console.error('[sandbox/ensure] Failed to cleanup n8n workflow:', e);
        }
        try {
          await supabaseAdmin.from('vn_test_workflows').delete().eq('id', insertedRow.id);
        } catch (e) {
          console.error('[sandbox/ensure] Failed to cleanup DB record:', e);
        }
      } else {
        console.log(`[sandbox/ensure] keepFailed=1: NOT deleting workflow ${createdWorkflow.id} - inspect in n8n UI`);
        console.log(`[sandbox/ensure] n8n UI URL: ${baseUrl}/workflow/${createdWorkflow.id}`);
      }

      return res.status(500).json({
        ok: false,
        error: 'Webhook registration failed: webhook returns 404 even after activation and retries',
        webhook_url: webhookUrl,
        webhook_path_configured: insertedRow.test_webhook_path_secret,
        workflow_id: createdWorkflow.id,
        verification_status: verifyResult.status,
        verification_response: verifyResult.data,
        activation_endpoint: endpointUsed,
        activation_verified: verified,
        keep_failed: keepFailed,
        diagnostics: finalDiagnostics,
        inspect_url: keepFailed ? `${baseUrl}/workflow/${createdWorkflow.id}` : null,
      });
    }

    console.log(`[sandbox/ensure] Webhook verified successfully (status: ${verifyResult.status})`);

    // 11. Return success with activation diagnostics
    res.json({
      ok: true,
      created: true,
      testWorkflow: {
        id: insertedRow.id,
        testN8nWorkflowId: insertedRow.test_n8n_workflow_id,
        webhookUrl,
        webhookSecret: insertedRow.webhook_auth_secret,
        createdAt: insertedRow.created_at,
      },
      activationEndpoint: endpointUsed,
      activationVerified: verified,
    });
  } catch (e) {
    console.error('[sandbox/ensure] error:', e);
    res.status(500).json({
      ok: false,
      error: 'Failed to ensure sandbox workflow',
    });
  }
});

/**
 * POST /api/v3/workflows/:workflowUuid/sandbox/status
 * Health check for VN TEST sandbox: checks workflow exists, is active, webhook reachable.
 * Safe self-heal: tries activate + retry on 404, but does NOT auto-delete.
 */
router.post('/v3/workflows/:workflowUuid/sandbox/status', async (req: Request, res: Response) => {
  try {
    const { workflowUuid } = req.params;
    const { connectionId } = req.body;

    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing connectionId' });
    }
    if (!workflowUuid || typeof workflowUuid !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing workflowUuid' });
    }

    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({ ok: false, error: 'Unauthorized or connection not found' });
    }

    // 1. Lookup VN TEST workflow from DB
    const { data: testRow, error: lookupErr } = await supabaseAdmin
      .from('vn_test_workflows')
      .select('*')
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .eq('prod_workflow_uuid', workflowUuid)
      .maybeSingle();

    if (lookupErr) {
      console.error('[sandbox/status] DB lookup error:', lookupErr);
      return res.status(500).json({ ok: false, error: 'Database error' });
    }

    if (!testRow) {
      return res.json({
        ok: true,
        active: false,
        webhook_reachable: false,
        needs_recreate: true,
        test_workflow_id: null,
      });
    }

    const testWorkflowId = testRow.test_n8n_workflow_id;

    // 2. Check if n8n workflow exists and is active
    const wfResult = await getWorkflow(connectionId, testWorkflowId);
    if (wfResult.error) {
      console.warn(`[sandbox/status] Workflow ${testWorkflowId} not found in n8n:`, wfResult.error.message);
      return res.json({
        ok: true,
        active: false,
        webhook_reachable: false,
        needs_recreate: true,
        test_workflow_id: testWorkflowId,
      });
    }

    const isActive = wfResult.data!.active === true;

    // 3. Ping webhook URL
    const baseUrlResult = await getConnectionBaseUrl(connectionId);
    if (baseUrlResult.error) {
      return res.status(500).json({ ok: false, error: 'Failed to get connection URL' });
    }
    const baseUrl = baseUrlResult.data!;

    let pingResult = await invokeWebhook(
      baseUrl,
      testRow.test_webhook_path_secret,
      { _vn_status_check: true, timestamp: Date.now() },
      { 'X-VN-Test-Secret': testRow.webhook_auth_secret }
    );

    let webhookReachable = pingResult.status !== 404 && pingResult.status !== 410 && pingResult.status !== 0;
    let needsRecreate = false;

    // 4. Self-heal on 404/410/unreachable
    if (!webhookReachable) {
      // Don't attempt repair on auth or rate-limit issues
      if (pingResult.status === 401 || pingResult.status === 403 || pingResult.status === 429) {
        console.warn(`[sandbox/status] Webhook returned ${pingResult.status}, skipping repair`);
      } else {
        console.log(`[sandbox/status] Webhook unreachable (${pingResult.status}), attempting activation...`);
        const activateResult = await setWorkflowActive(connectionId, testWorkflowId, true);
        if (activateResult.error) {
          console.error('[sandbox/status] Activation failed:', activateResult.error.message);
        } else {
          console.log('[sandbox/status] Activated, retrying webhook...');
          await new Promise(r => setTimeout(r, 1500));

          pingResult = await invokeWebhook(
            baseUrl,
            testRow.test_webhook_path_secret,
            { _vn_status_check: true, timestamp: Date.now() },
            { 'X-VN-Test-Secret': testRow.webhook_auth_secret }
          );

          webhookReachable = pingResult.status !== 404 && pingResult.status !== 410 && pingResult.status !== 0;
        }

        if (!webhookReachable) {
          needsRecreate = true;
          console.warn('[sandbox/status] Webhook still unreachable after repair, needs_recreate=true');
        }
      }
    }

    // Re-check active state after potential activation
    let activeNow = isActive;
    if (!isActive && !needsRecreate) {
      const recheck = await getWorkflow(connectionId, testWorkflowId);
      if (recheck.data) activeNow = recheck.data.active === true;
    }

    console.log(`[sandbox/status] Result: active=${activeNow}, reachable=${webhookReachable}, recreate=${needsRecreate}`);

    return res.json({
      ok: true,
      active: activeNow,
      webhook_reachable: webhookReachable,
      needs_recreate: needsRecreate,
      test_workflow_id: testWorkflowId,
    });
  } catch (e) {
    console.error('[sandbox/status] error:', e);
    res.status(500).json({ ok: false, error: 'Failed to check sandbox status' });
  }
});

/**
 * GET /api/v3/workflows/:workflowUuid/fixtures
 * List fixtures for a workflow
 */
router.get('/v3/workflows/:workflowUuid/fixtures', async (req: Request, res: Response) => {
  try {
    const { workflowUuid } = req.params;
    const connectionId = req.query.connectionId;

    // Validate input
    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing connectionId query parameter',
      });
    }

    // Resolve user
    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized or connection not found',
      });
    }

    // Fetch fixtures
    const { data: fixtures, error } = await supabaseAdmin
      .from('vn_fixtures')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_uuid', workflowUuid)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[fixtures/list] DB error:', error);
      return res.status(500).json({
        ok: false,
        error: 'Database error',
      });
    }

    res.json({
      ok: true,
      fixtures: fixtures || [],
    });
  } catch (e) {
    console.error('[fixtures/list] error:', e);
    res.status(500).json({
      ok: false,
      error: 'Failed to list fixtures',
    });
  }
});

/**
 * POST /api/v3/workflows/:workflowUuid/fixtures
 * Create a new fixture for testing
 */
router.post('/v3/workflows/:workflowUuid/fixtures', async (req: Request, res: Response) => {
  try {
    const { workflowUuid } = req.params;
    const { connectionId, name, payload, headers } = req.body;

    // Validate input
    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing connectionId in request body',
      });
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing fixture name',
      });
    }

    // Resolve user
    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized or connection not found',
      });
    }

    // Insert fixture
    const { data: fixture, error } = await supabaseAdmin
      .from('vn_fixtures')
      .insert({
        user_id: userId,
        connection_id: connectionId,
        workflow_uuid: workflowUuid,
        name,
        payload: payload || {},
        headers: headers || {},
      })
      .select()
      .single();

    if (error) {
      console.error('[fixtures/create] DB error:', error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to create fixture',
      });
    }

    res.status(201).json({
      ok: true,
      fixture,
    });
  } catch (e) {
    console.error('[fixtures/create] error:', e);
    res.status(500).json({
      ok: false,
      error: 'Failed to create fixture',
    });
  }
});

/**
 * POST /api/v3/workflows/:workflowUuid/sandbox/run
 * Execute a test run using the sandbox workflow
 */
router.post('/v3/workflows/:workflowUuid/sandbox/run', async (req: Request, res: Response) => {
  try {
    const { workflowUuid } = req.params;
    const { connectionId, fixtureId } = req.body;

    // Validate input
    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing connectionId in request body',
      });
    }

    if (!fixtureId || typeof fixtureId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing fixtureId in request body',
      });
    }

    // Resolve user
    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized or connection not found',
      });
    }

    // Load test workflow
    const { data: testWorkflow, error: twError } = await supabaseAdmin
      .from('vn_test_workflows')
      .select('*')
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .eq('prod_workflow_uuid', workflowUuid)
      .single();

    if (twError || !testWorkflow) {
      return res.status(404).json({
        ok: false,
        error: 'Test workflow not found. Call /sandbox/ensure first.',
      });
    }

    // Load fixture
    const { data: fixture, error: fixError } = await supabaseAdmin
      .from('vn_fixtures')
      .select('*')
      .eq('id', fixtureId)
      .eq('user_id', userId)
      .single();

    if (fixError || !fixture) {
      return res.status(404).json({
        ok: false,
        error: 'Fixture not found',
      });
    }

    // Get n8n base URL
    const baseUrlResult = await getConnectionBaseUrl(connectionId);
    if (baseUrlResult.error) {
      return res.status(500).json({
        ok: false,
        error: 'Failed to get connection URL',
      });
    }
    const baseUrl = baseUrlResult.data!;

    // Invoke webhook
    const webhookHeaders: Record<string, string> = {
      'X-VN-Test-Secret': testWorkflow.webhook_auth_secret,
      ...(fixture.headers || {}),
    };

    let result = await invokeWebhook(
      baseUrl,
      testWorkflow.test_webhook_path_secret,
      fixture.payload || {},
      webhookHeaders
    );

    // RETRY LOGIC: On ANY 404 from webhook, try activating workflow and retry once
    if (result.status === 404) {
      console.log(`[sandbox/run] Webhook returned 404, attempting to activate: ${testWorkflow.test_n8n_workflow_id}`);

      const activateResult = await setWorkflowActive(connectionId, testWorkflow.test_n8n_workflow_id, true);
      if (activateResult.error) {
        console.error('[sandbox/run] Failed to activate workflow:', activateResult.error);
      } else {
        console.log('[sandbox/run] Workflow activated, waiting 1s then retrying webhook...');
        await new Promise(r => setTimeout(r, 1000));

        // Retry webhook invocation
        result = await invokeWebhook(
          baseUrl,
          testWorkflow.test_webhook_path_secret,
          fixture.payload || {},
          webhookHeaders
        );
        console.log(`[sandbox/run] Retry result: status=${result.status}`);
      }
    }

    // Determine status
    const status = result.error ? 'error' : (result.status >= 200 && result.status < 300 ? 'success' : 'error');

    // Store test run
    const { data: testRun, error: runError } = await supabaseAdmin
      .from('vn_test_runs')
      .insert({
        user_id: userId,
        connection_id: connectionId,
        workflow_uuid: workflowUuid,
        fixture_id: fixtureId,
        test_workflow_id: testWorkflow.id,
        status,
        response_json: result.data,
        error_message: result.error || null,
        latency_ms: result.latencyMs,
      })
      .select()
      .single();

    if (runError) {
      console.error('[sandbox/run] Failed to store test run:', runError);
      // Still return the result even if storage failed
    }

    res.json({
      ok: true,
      testRun: testRun || {
        status,
        latency_ms: result.latencyMs,
        response_json: result.data,
        error_message: result.error,
      },
      response: result.data,
    });
  } catch (e) {
    console.error('[sandbox/run] error:', e);
    res.status(500).json({
      ok: false,
      error: 'Failed to execute sandbox run',
    });
  }
});

/**
 * POST /api/v3/assist/ask
 * Phase 2A: Ask mode - Deterministic AI assistance for workflow questions
 * 
 * Guarantees:
 * - temperature=0 for deterministic outputs
 * - Stable issue ranking (severity -> category -> node)
 * - Structured response with citations and evidence
 * - Timing instrumentation for debugging
 */
router.post('/v3/assist/ask', async (req: Request, res: Response) => {
  // Phase 2A: Start timing instrumentation
  const startTotal = Date.now();
  const timings: AskTimings = createEmptyTimings();

  try {
    const { connectionId, workflowUuid, sessionId, message } = req.body;

    // 1. Validate input
    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing connectionId in request body',
      });
    }

    if (!workflowUuid || typeof workflowUuid !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing workflowUuid in request body',
      });
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing message in request body',
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        ok: false,
        error: 'Message too long (max 2000 characters)',
      });
    }

    // 2. Resolve user
    const userId = await getConnectionUserId(connectionId);
    if (!userId) {
      return res.status(403).json({
        ok: false,
        error: 'Unauthorized or connection not found',
      });
    }

    // 3. Resolve workflow UUID -> n8n workflow ID
    const resolveResult = await resolveN8nWorkflowId({
      workflowId: workflowUuid,
      connectionId,
      userId,
    });

    if (resolveResult.ok === false) {
      return res.status(404).json({
        ok: false,
        error: resolveResult.error,
        code: resolveResult.code,
      });
    }

    const n8nWorkflowId = resolveResult.n8nWorkflowId;
    const sourceTable = resolveResult.sourceTable || 'workflows';

    // 4. Fetch workflow JSON from n8n
    const fetchStart = Date.now();
    const workflowResult = await getWorkflow(connectionId, n8nWorkflowId);
    timings.fetch_workflow = Date.now() - fetchStart;

    if (workflowResult.error) {
      return res.status(500).json({
        ok: false,
        error: 'Failed to fetch workflow from n8n',
        details: workflowResult.error.message,
        debug: createEmptyDebug(workflowUuid),
      });
    }

    const workflow = workflowResult.data!;

    // 4a. Sync workflow to DB/cache if changed (ensures fresh state)
    console.log(`[assist/ask] Checking if workflow needs sync...`);
    const syncInfo = await syncWorkflowIfChanged(userId, connectionId, n8nWorkflowId, workflow);
    console.log(`[assist/ask] Sync info:`, syncInfo);

    // 4b. Analyze execution health (is workflow currently failing?)
    console.log(`[assist/ask] Analyzing execution health...`);
    const executionHealth = await analyzeExecutionHealth(connectionId, n8nWorkflowId);
    console.log(`[assist/ask] Execution health:`, {
      isHealthy: executionHealth.isHealthy,
      pickedExecutionId: executionHealth.pickedExecutionId,
      pickedExecutionStatus: executionHealth.pickedExecutionStatus,
    });

    // 4c. Fetch latest execution error (if any) - with improved parsing
    let latestExecutionError: LatestExecutionError | null = null;
    let executionErrorDebug: Record<string, unknown> | null = null;

    // If workflow is healthy, skip error analysis
    if (executionHealth.isHealthy) {
      console.log(`[assist/ask] Workflow is healthy, skipping error analysis`);
      executionErrorDebug = {
        executionId: executionHealth.pickedExecutionId,
        status: 'success',
        failedNode: 'N/A',
        rawErrorSnippet: null,
      };
    } else {
      // Workflow has error or unknown state, analyze it
      console.log(`[assist/ask] Workflow not healthy, analyzing latest error execution`);

      try {
        const executionsResult = await listRecentExecutions(connectionId, n8nWorkflowId, 5, {
          includeData: true,
        });

        if (!executionsResult.error && executionsResult.data && executionsResult.data.length > 0) {
          // Find first error execution
          const failedExecution = executionsResult.data.find(exec => exec.status === 'error');

          if (failedExecution) {
            let failedNode = 'Unknown';
            let errorMessage = 'Unknown error';
            let rawErrorSnippet: Record<string, unknown> = {};

            // Strategy 1: Extract from resultData.error (top-level error)
            if (failedExecution.data?.resultData?.error) {
              const topError = failedExecution.data.resultData.error;
              errorMessage = topError.message || 'Unknown error';
              rawErrorSnippet = {
                source: 'resultData.error',
                message: topError.message,
                stack: topError.stack?.slice(0, 200),
              };
            }

            // Strategy 2: Find failed node from runData
            if (failedExecution.data?.resultData?.runData) {
              for (const [nodeName, nodeData] of Object.entries(failedExecution.data.resultData.runData)) {
                if (Array.isArray(nodeData) && nodeData.length > 0) {
                  const lastRun = nodeData[nodeData.length - 1];
                  if (lastRun.error) {
                    failedNode = nodeName;
                    errorMessage = lastRun.error.message || errorMessage;
                    rawErrorSnippet = {
                      source: 'runData',
                      nodeName,
                      message: lastRun.error.message,
                    };
                    break;
                  }
                }
              }
            }

            // Strategy 3: If still unknown, fetch full execution details
            if (failedNode === 'Unknown' && failedExecution.id) {
              try {
                const fullExecResult = await getExecution(connectionId, failedExecution.id);
                if (!fullExecResult.error && fullExecResult.data) {
                  const fullExec = fullExecResult.data;

                  // Try to extract from full execution data
                  if (fullExec.data?.resultData?.runData) {
                    for (const [nodeName, nodeData] of Object.entries(fullExec.data.resultData.runData)) {
                      if (Array.isArray(nodeData) && nodeData.length > 0) {
                        const lastRun = nodeData[nodeData.length - 1];
                        if (lastRun.error || lastRun.executionStatus === 'error') {
                          failedNode = nodeName;
                          errorMessage = lastRun.error?.message || errorMessage;
                          rawErrorSnippet = {
                            source: 'fullExecution',
                            nodeName,
                            executionStatus: lastRun.executionStatus,
                            error: lastRun.error,
                          };
                          break;
                        }
                      }
                    }
                  }
                }
              } catch (fullExecError) {
                console.warn('[assist/ask] Could not fetch full execution details:', fullExecError);
              }
            }

            latestExecutionError = {
              executionId: failedExecution.id || '',
              failedNode,
              errorMessage,
              timestamp: failedExecution.stoppedAt || '',
            };

            executionErrorDebug = {
              executionId: failedExecution.id,
              status: failedExecution.status,
              failedNode,
              rawErrorSnippet,
            };

            console.log(`[assist/ask] Found latest execution error at node: ${latestExecutionError.failedNode}`);
          }
        }
      } catch (execError) {
        console.warn('[assist/ask] Could not fetch execution history:', execError);
        // Continue without execution error - not critical
      }
    }

    // 5. Build context pack (includes evaluation)
    console.log(`[assist/ask] Building context for workflow: ${workflow.name}`);

    // If workflow is healthy, prepare a health-focused context
    let contextPack: ContextPack;
    if (executionHealth.isHealthy && executionHealth.latestSuccess) {
      console.log(`[assist/ask] Workflow is healthy, building success-focused context`);
      // Build a minimal context for a healthy workflow
      // Compute uniqueNodeTypes from actual workflow nodes
      const uniqueTypes = new Set<string>();
      (workflow.nodes || []).forEach(node => {
        if (node.type) {
          uniqueTypes.add(node.type);
        }
      });

      contextPack = {
        workflow: {
          id: workflow.id || '',
          name: workflow.name || '',
          active: workflow.active || false,
          nodeCount: (workflow.nodes || []).length,
          connectionCount: Object.keys(workflow.connections || {}).length,
        },
        nodes: [],
        missingCredentials: [],
        evaluationIssues: [],
        latestExecutionError: null,
        evaluation: {
          missingCredentials: [],
          brokenConnections: 0,
          disabledNodes: 0,
          issues: [],
        },
        schemas: {},
        metadata: {
          totalNodes: (workflow.nodes || []).length,
          uniqueNodeTypes: uniqueTypes.size,
          triggersCount: 0,
          schemasTruncated: 0,
        },
      };
    } else {
      contextPack = await buildContextPack(workflow, {
        maxNodes: 300,
        maxSchemaSize: 5000,
        connectionId,
        latestExecution: latestExecutionError,
      });
    }

    // 6. Sanitize context pack (remove any potential secrets)
    const safeContext = sanitizeContextPack(contextPack);

    console.log(`[assist/ask] Context: ${safeContext.nodes.length} nodes, ${safeContext.missingCredentials.length} missing creds, ${safeContext.evaluationIssues.length} issues, execution error: ${safeContext.latestExecutionError ? 'YES' : 'NO'}`);

    // 7. Attempt LLM call with validation (up to 2 attempts)
    // BUT: if workflow is healthy, use simple canned response instead
    let assistResponse: AssistResponse;
    let validationResult: ReturnType<typeof validateAssistResponse> | null = null;
    let llmAttempts = 0;
    const MAX_ATTEMPTS = 2;

    if (executionHealth.isHealthy && executionHealth.latestSuccess) {
      // Healthy workflow: no LLM needed, use simple response
      // This happens when: latest execution succeeded AND (no error OR latest success is newer than latest error)
      console.log(`[assist/ask] Workflow is healthy, using simple response (no LLM)`);

      const previousErrorId = executionHealth.latestError ? ` (previously failed at execution ${executionHealth.latestError.id})` : '';
      assistResponse = {
        answer: `Looks fixed. Latest execution #${executionHealth.latestAny?.id || 'unknown'} succeeded.${previousErrorId}`,
        topFixFirst: null,
        issues: [],
        citations: [],
      };
      llmAttempts = 0; // No LLM was called
    } else {
      // Unhealthy: use LLM to analyze the error
      let assistResponseOrNull: AssistResponse | null = null;

      while (llmAttempts < MAX_ATTEMPTS && !assistResponseOrNull) {
        llmAttempts++;
        const isRetry = llmAttempts > 1;

        // Build prompt (stricter on retry)
        const systemPrompt = buildSystemPrompt(safeContext, isRetry);
        const userContextStr = buildUserContext(safeContext);
        const userPrompt = `${userContextStr}\n\n**User Question:** ${message}`;

        // Estimate tokens
        const totalInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);

        if (totalInputTokens > 100000) {
          return res.status(400).json({
            ok: false,
            error: 'Workflow too complex for Ask mode',
            details: `Token budget exceeded: ${totalInputTokens} tokens (limit: 100k)`,
          });
        }

        console.log(`[assist/ask] LLM attempt ${llmAttempts}/${MAX_ATTEMPTS}`);

        // Call LLM with JSON mode - Phase 2A: wrapped in timing
        const llmStart = Date.now();
        const llmResult = await callLLM({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: ASK_BUDGETS.temperature, // Phase 2A: Always 0 for determinism
          maxTokens: ASK_BUDGETS.max_tokens,
          jsonMode: true, // Force JSON response
        });
        timings.llm += Date.now() - llmStart;

        if (!llmResult.ok) {
          console.error('[assist/ask] LLM error:', llmResult.error);

          // On LLM failure, use deterministic fallback
          console.log('[assist/ask] Using deterministic fallback due to LLM error');
          assistResponseOrNull = buildDeterministicResponse(safeContext, message);
          break;
        }

        // Parse JSON response
        const parsedResponse = parseAssistResponse(llmResult.data.answer);
        if (!parsedResponse) {
          console.warn('[assist/ask] Failed to parse LLM JSON response, attempt:', llmAttempts);

          if (llmAttempts >= MAX_ATTEMPTS) {
            console.log('[assist/ask] Max attempts reached, using deterministic fallback');
            assistResponseOrNull = buildDeterministicResponse(safeContext, message);
          }
          continue; // Retry
        }

        // Validate response
        validationResult = validateAssistResponse(parsedResponse, safeContext);

        if (validationResult.valid) {
          // Success!
          assistResponseOrNull = parsedResponse;
          console.log('[assist/ask] Response validated successfully');
        } else {
          console.warn(`[assist/ask] Validation failed (attempt ${llmAttempts}):`, validationResult.errors);

          if (llmAttempts >= MAX_ATTEMPTS) {
            // Max attempts - use deterministic fallback
            console.log('[assist/ask] Max attempts reached, using deterministic fallback');
            assistResponseOrNull = buildDeterministicResponse(safeContext, message);
          }
          // Otherwise retry with stricter prompt
        }
      }

      // Ensure we have a response (fallback if everything failed)
      if (!assistResponseOrNull) {
        console.warn('[assist/ask] No valid response after all attempts, using deterministic fallback');
        assistResponseOrNull = buildDeterministicResponse(safeContext, message);
      }

      assistResponse = assistResponseOrNull;
    }

    // 8. Return structured response with debug info
    // Ensure validation is always an object (never null to prevent truncation)
    const validationSafe = validationResult ? {
      errors: validationResult.errors || [],
      warnings: validationResult.warnings || [],
    } : {
      errors: [],
      warnings: [],
    };

    // Phase 2A: Finalize timings
    timings.total = Date.now() - startTotal;
    timings.analyze = timings.total - timings.fetch_workflow - timings.llm; // Remainder is analyze time

    const responsePayload = {
      ok: true,
      answer: assistResponse.answer,
      topFixFirst: assistResponse.topFixFirst,
      issues: assistResponse.issues,
      citations: assistResponse.citations,
      debug: {
        // Phase 2A: Core contract fields
        analyzed_source: (sourceTable === 'vn_test_workflows' ? 'test' : 'prod') as 'prod' | 'test',
        workflow_uuid: workflowUuid,
        n8n_workflow_id: n8nWorkflowId,
        workflow_updated_at_from_n8n: syncInfo.workflowUpdatedAt,

        // Phase 2A: Budgets (constant for transparency)
        budgets: { ...ASK_BUDGETS },

        // Phase 2A: Timing breakdown
        timings_ms: timings,

        // Context summary
        contextPackSummary: {
          workflowName: safeContext.workflow.name,
          nodeCount: safeContext.workflow.nodeCount,
          uniqueTypes: safeContext.metadata.uniqueNodeTypes,
          missingCredentials: safeContext.missingCredentials.length,
          evaluationIssues: safeContext.evaluationIssues.length,
          latestExecutionError: safeContext.latestExecutionError ? 'YES' : 'NO',
        },

        // Execution selection & health analysis
        executionSelection: {
          pickedExecutionId: executionHealth.pickedExecutionId,
          pickedExecutionStatus: executionHealth.pickedExecutionStatus,
          workflowIsHealthy: executionHealth.isHealthy,
          latestAnyId: executionHealth.latestAny?.id || null,
          latestAnyStatus: executionHealth.latestAny?.status || null,
          latestAnyFinishedAt: executionHealth.latestAny?.finishedAt || null,
          latestErrorId: executionHealth.latestError?.id || null,
          latestErrorStatus: executionHealth.latestError?.status || null,
          latestErrorFinishedAt: executionHealth.latestError?.finishedAt || null,
          latestSuccessId: executionHealth.latestSuccess?.id || null,
          latestSuccessStatus: executionHealth.latestSuccess?.status || null,
          latestSuccessFinishedAt: executionHealth.latestSuccess?.finishedAt || null,
          recentExecutions: executionHealth.recentExecutions,
        },

        // Execution error details
        executionErrorDebug: executionErrorDebug || null,

        // Validation (always an object, never null)
        validation: validationSafe,

        // LLM metadata
        llmAttempts,
        usedDeterministicFallback: llmAttempts === 0 || (validationResult && !validationResult.valid),
        sessionId,
      },
    };

    // Defensive JSON serialization guard
    try {
      JSON.stringify(responsePayload);
      // If stringify succeeds, send the response
      res.json(responsePayload);
    } catch (stringifyError) {
      console.error('[assist/ask] JSON stringify failed, sanitizing debug:', stringifyError);
      // Fallback: send minimal response with sanitized debug
      res.json({
        ok: true,
        answer: assistResponse.answer,
        topFixFirst: assistResponse.topFixFirst,
        issues: assistResponse.issues,
        citations: assistResponse.citations,
        debug: {
          analyzed_n8n_workflow_id: n8nWorkflowId,
          error: 'Debug data could not be serialized',
          validation: validationSafe,
        },
      });
    }

  } catch (e) {
    console.error('[assist/ask] error:', e);
    res.status(500).json({
      ok: false,
      error: 'Internal error processing Ask request',
      details: e instanceof Error ? e.message : String(e),
    });
  }
});

/**
 * POST /api/v3/assist/plan
 * Phase 2B: Generate structured fix plan with DB persistence
 * 
 * Input:
 * - connectionId: string (required)
 * - workflowUuid: string (required)
 * - analyzed_source: 'prod' | 'test' (optional, default 'prod')
 * - userGoal: string (optional)
 * 
 * Returns: PlanContractResponse
 */
router.post('/v3/assist/plan', async (req: Request, res: Response) => {
  const timings = createEmptyPlanTimings();
  const startTotal = Date.now();

  try {
    // 1. Validate input - accept both workflowUuid and workflowId
    const { connectionId, analyzed_source, userGoal } = req.body;
    const workflowId = req.body.workflowUuid ?? req.body.workflowId;

    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'connectionId is required',
        plan: null,
        debug: createEmptyPlanDebug(workflowId || ''),
      });
    }

    if (!workflowId || typeof workflowId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'workflowUuid is required',
        plan: null,
        debug: createEmptyPlanDebug(''),
      });
    }

    const analyzedSource = analyzed_source === 'test' ? 'test' : 'prod';
    const debug: PlanDebug = createEmptyPlanDebug(workflowId);
    debug.analyzed_source = analyzedSource;

    console.log(`[assist/plan] Starting for workflow ${workflowId}, source=${analyzedSource}`);

    // 2. Resolve user from connection
    const userId = await getConnectionUserId(connectionId);
    if (!userId) {
      console.error('[assist/plan] Failed to get userId for connection:', connectionId);
      return res.status(400).json({
        ok: false,
        error: 'Invalid connectionId',
        plan: null,
        debug,
      });
    }

    // 3. Resolve workflow ID using the same bridge as other endpoints
    const startFetch = Date.now();

    const resolveResult = await resolveN8nWorkflowId({
      workflowId,
      connectionId,
      userId,
    });

    if (!resolveResult.ok) {
      console.error('[assist/plan] Workflow resolution failed:', resolveResult.error);
      return res.status(404).json({
        ok: false,
        error: 'Workflow not found',
        plan: null,
        debug: {
          ...debug,
          lookup: {
            connectionId,
            workflowId,
            resolveError: resolveResult.error,
            resolveCode: resolveResult.code,
            hint: 'Run /api/n8n/sync then retry',
          },
        },
      });
    }

    const n8nWorkflowId = resolveResult.n8nWorkflowId;
    debug.n8n_workflow_id = n8nWorkflowId;
    console.log(`[assist/plan] Resolved n8nWorkflowId: ${n8nWorkflowId}`);

    // 4. Fetch workflow JSON from n8n
    const workflowResult = await getWorkflow(connectionId, n8nWorkflowId);
    if (workflowResult.error || !workflowResult.data) {
      console.error('[assist/plan] Failed to fetch workflow:', workflowResult.error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to fetch workflow from n8n',
        plan: null,
        debug,
      });
    }

    const workflow = workflowResult.data;
    timings.fetch_workflow = Date.now() - startFetch;

    // 5. Build context pack
    const startAnalyze = Date.now();
    const contextPack = await buildContextPack(workflow, {
      connectionId,
      maxNodes: 50,
      maxSchemaSize: 2000,
    });
    const sanitizedContext = sanitizeContextPack(contextPack);
    timings.analyze = Date.now() - startAnalyze;

    // 6. Build LLM messages
    const systemPrompt = buildPlanSystemPrompt(sanitizedContext, userGoal);
    const userContext = buildPlanUserContext(sanitizedContext);

    const estimatedTokens = estimateTokens(systemPrompt + userContext);
    console.log(`[assist/plan] Estimated tokens: ${estimatedTokens}`);

    // 7. Call LLM with deterministic settings
    const startLLM = Date.now();
    const llmResult = await callLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContext },
      ],
      temperature: PLAN_BUDGETS.temperature, // Always 0
      maxTokens: PLAN_BUDGETS.max_tokens,
      jsonMode: true,
    });
    timings.llm = Date.now() - startLLM;

    if (!llmResult.ok) {
      console.error('[assist/plan] LLM error:', llmResult.error);
      timings.total = Date.now() - startTotal;
      debug.timings_ms = timings;
      return res.json({
        ok: false,
        error: 'LLM call failed',
        plan: null,
        debug,
      });
    }

    // 8. Parse and validate plan
    const plan = parsePlanResponse(llmResult.data.answer);
    if (!plan) {
      console.error('[assist/plan] Plan validation failed');
      timings.total = Date.now() - startTotal;
      debug.timings_ms = timings;
      return res.json({
        ok: false,
        error: 'Invalid plan format from LLM',
        plan: null,
        debug,
      });
    }

    // 9. Atomic DB persistence via RPC (transactional)
    const startDb = Date.now();
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('create_completion_plan', {
      p_workflow_id: workflowId,
      p_connection_id: connectionId,
      p_plan_json: plan,
      p_analyzed_source: analyzedSource,
      p_created_by: 'assist/plan',
    });

    if (rpcError) {
      console.error('[assist/plan] RPC create_completion_plan failed:', rpcError.message);
      timings.total = Date.now() - startTotal;
      debug.timings_ms = timings;
      return res.json({
        ok: false,
        error: 'Failed to persist plan',
        plan: null,
        debug,
      });
    }

    // Validate RPC result shape
    const rpcData = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
    if (!rpcData?.plan_id || !rpcData?.plan_created_at) {
      console.error('[assist/plan] RPC returned invalid shape:', JSON.stringify(rpcData).slice(0, 200));
      timings.total = Date.now() - startTotal;
      debug.timings_ms = timings;
      return res.json({
        ok: false,
        error: 'Plan persistence returned invalid data',
        plan: null,
        debug,
      });
    }

    const dbTime = Date.now() - startDb;
    console.log(`[assist/plan] Plan persisted via RPC in ${dbTime}ms, id: ${rpcData.plan_id}`);

    // 10. Server overrides identity fields (security)
    plan.id = rpcData.plan_id;
    plan.created_at = rpcData.plan_created_at;

    // 11. Sort for determinism
    const sortedPlan = sortPlanForDeterminism(plan);

    // 12. Finalize timings
    timings.total = Date.now() - startTotal;
    debug.timings_ms = timings;

    // 13. Return response
    const response: PlanContractResponse = {
      ok: true,
      plan: sortedPlan,
      debug,
    };

    console.log(`[assist/plan] Success in ${timings.total}ms, phases=${sortedPlan.phases.length}`);
    res.json(response);

  } catch (e) {
    console.error('[assist/plan] error:', e);
    res.status(500).json({
      ok: false,
      error: 'Internal error processing Plan request',
      plan: null,
      debug: createEmptyPlanDebug(''),
    });
  }
});

/**
 * POST /api/v3/assist/apply-step
 * Phase 2B Step 2: Apply a single plan step to VN TEST workflow
 * 
 * Safety:
 * - NEVER writes to prod workflow
 * - Only whitelisted patch operations allowed
 * - dry_run=true (default) skips n8n update
 */
router.post('/v3/assist/apply-step', async (req: Request, res: Response) => {
  const timings = createEmptyApplyStepTimings();
  const startTotal = Date.now();

  try {
    // 1. Validate input - accept both workflowUuid and workflowId
    const { connectionId, planId, stepId, analyzed_source } = req.body;
    const workflowId = req.body.workflowUuid ?? req.body.workflowId;
    const dryRun = req.body.dry_run !== false; // Default true for safety

    // Parse idempotency_key: accept snake_case or camelCase, trim, treat empty as null
    const rawKey = req.body.idempotency_key || req.body.idempotencyKey;
    const idempotency_key = (typeof rawKey === 'string' && rawKey.trim()) ? rawKey.trim() : null;

    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'connectionId is required',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug: createEmptyApplyStepDebug(workflowId || '', planId || '', stepId || ''),
      });
    }

    if (!workflowId || typeof workflowId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'workflowUuid is required',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug: createEmptyApplyStepDebug('', planId || '', stepId || ''),
      });
    }

    if (!planId || typeof planId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'planId is required',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug: createEmptyApplyStepDebug(workflowId, '', stepId || ''),
      });
    }

    if (!stepId || typeof stepId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'stepId is required',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug: createEmptyApplyStepDebug(workflowId, planId, ''),
      });
    }

    const debug: ApplyStepDebug = createEmptyApplyStepDebug(workflowId, planId, stepId);
    debug.dry_run = dryRun;
    debug.idempotency_key = idempotency_key || null;
    debug.idempotency_hit = false;

    console.log(`[assist/apply-step] Starting: workflow=${workflowId}, plan=${planId}, step=${stepId}, dry_run=${dryRun}, idempotency=${idempotency_key}`);
    console.log(`[assist/apply-step] Parsed idempotency_key="${idempotency_key}" (type: ${typeof idempotency_key}, raw: "${rawKey}")`);

    // EARLY IDEMPOTENCY CHECK: If idempotency_key provided, check for existing application
    if (idempotency_key) {
      const { data: existingApp, error: lookupError } = await supabaseAdmin
        .from('step_applications')
        .select('*')
        .eq('idempotency_key', idempotency_key)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lookupError) {
        console.error('[assist/apply-step] Idempotency lookup error:', lookupError);
      }

      if (existingApp) {
        console.log(`[assist/apply-step] Idempotency hit: key=${idempotency_key}, existing_id=${existingApp.id}`);

        // Validate metadata matches
        if (
          existingApp.workflow_uuid !== workflowId ||
          existingApp.plan_id !== planId ||
          existingApp.step_id !== stepId
        ) {
          console.error('[assist/apply-step] Idempotency key conflict:', {
            key: idempotency_key,
            existing: { workflow: existingApp.workflow_uuid, plan: existingApp.plan_id, step: existingApp.step_id },
            requested: { workflow: workflowId, plan: planId, step: stepId },
          });
          return res.status(409).json({
            ok: false,
            error: 'Idempotency key already used with different workflow/plan/step',
            patch: null,
            test_workflow_id: existingApp.test_workflow_id,
            diff_summary: null,
            debug: {
              ...debug,
              idempotency_hit: true,
              idempotency_key,
              existing_application_id: existingApp.id,
              dry_run: dryRun,
            },
          });
        }

        // Return cached result based on status
        const isSuccess = existingApp.status === 'applied';
        return res.json({
          ok: isSuccess,
          error: isSuccess ? undefined : existingApp.error || 'Previous application failed',
          patch: existingApp.patch_json,
          test_workflow_id: existingApp.test_workflow_id,
          diff_summary: existingApp.diff_summary,
          debug: {
            ...debug,
            idempotency_hit: true,
            idempotency_key,
            existing_application_id: existingApp.id,
            cached_status: existingApp.status,
            dry_run: dryRun,
          },
        });
      }
    }


    // 2. Resolve user from connection
    const userId = await getConnectionUserId(connectionId);
    if (!userId) {
      console.error('[assist/apply-step] Failed to get userId for connection:', connectionId);
      return res.status(400).json({
        ok: false,
        error: 'Invalid connectionId',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug,
      });
    }

    // 3. Resolve prod n8n workflow ID
    const startLookup = Date.now();
    const resolveResult = await resolveN8nWorkflowId({
      workflowId,
      connectionId,
      userId,
    });

    if (!resolveResult.ok) {
      console.error('[assist/apply-step] Workflow resolution failed:', resolveResult.error);
      return res.status(404).json({
        ok: false,
        error: 'Workflow not found',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug,
      });
    }

    const prodN8nWorkflowId = resolveResult.n8nWorkflowId;
    debug.prod_workflow_id_DENIED = prodN8nWorkflowId; // SAFETY: we NEVER write to this

    // 4. Load plan from completion_plans
    const { data: planRow, error: planError } = await supabaseAdmin
      .from('completion_plans')
      .select('id, workflow_id, plan_json, is_active')
      .eq('id', planId)
      .single();

    if (planError || !planRow) {
      console.error('[assist/apply-step] Plan not found:', planError);
      return res.status(404).json({
        ok: false,
        error: 'Plan not found',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug,
      });
    }

    // Verify workflow matches
    if (planRow.workflow_id !== workflowId) {
      console.error('[assist/apply-step] Plan workflow mismatch:', planRow.workflow_id, workflowId);
      return res.status(400).json({
        ok: false,
        error: 'Plan does not belong to this workflow',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug,
      });
    }

    // 5. Load step from completion_steps
    const { data: stepRow, error: stepError } = await supabaseAdmin
      .from('completion_steps')
      .select('step_id, plan_id, step_json, status')
      .eq('plan_id', planId)
      .eq('step_id', stepId)
      .single();

    if (stepError || !stepRow) {
      console.error('[assist/apply-step] Step not found:', stepError);
      return res.status(404).json({
        ok: false,
        error: 'Step not found in plan',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug,
      });
    }

    // 6. Get VN TEST workflow mapping
    const { data: testMapping, error: testError } = await supabaseAdmin
      .from('vn_test_workflows')
      .select('test_n8n_workflow_id')
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .eq('prod_workflow_uuid', workflowId)
      .maybeSingle();

    if (testError) {
      console.error('[assist/apply-step] Test workflow lookup error:', testError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to lookup test workflow',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug,
      });
    }

    if (!testMapping || !testMapping.test_n8n_workflow_id) {
      return res.status(400).json({
        ok: false,
        error: 'Test workflow not found. Call /sandbox/ensure first.',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug,
      });
    }

    const testWorkflowId = testMapping.test_n8n_workflow_id;
    debug.test_workflow_id = testWorkflowId;

    // SAFETY CHECK: Ensure test workflow != prod workflow
    if (testWorkflowId === prodN8nWorkflowId) {
      console.error('[assist/apply-step] SAFETY VIOLATION: test_workflow_id equals prod_workflow_id!');
      return res.status(400).json({
        ok: false,
        error: 'Safety violation: test workflow equals prod workflow',
        patch: null,
        test_workflow_id: null,
        diff_summary: null,
        debug,
      });
    }

    timings.lookup = Date.now() - startLookup;

    // 7. Fetch current VN TEST workflow from n8n
    const testWorkflowResult = await getWorkflow(connectionId, testWorkflowId);
    if (testWorkflowResult.error || !testWorkflowResult.data) {
      console.error('[assist/apply-step] Failed to fetch test workflow:', testWorkflowResult.error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to fetch test workflow from n8n',
        patch: null,
        test_workflow_id: testWorkflowId,
        diff_summary: null,
        debug,
      });
    }

    const testWorkflow = testWorkflowResult.data;
    const stepJson = stepRow.step_json as { title: string; nodeLocators: string[]; actions: string[]; expectedOutcome: string; checks: string[]; rollback?: string; rank: number; id: string };

    // 8. Generate patch via LLM (temperature=0)
    const startLlm = Date.now();
    const patchPrompt = buildPatchPrompt({
      id: stepJson.id,
      title: stepJson.title,
      nodeLocators: stepJson.nodeLocators || [],
      actions: stepJson.actions || [],
      expectedOutcome: stepJson.expectedOutcome || '',
      checks: stepJson.checks || [],
      rollback: stepJson.rollback,
      rank: stepJson.rank || 0,
    }, testWorkflow);

    const llmResult = await callLLM({
      messages: [
        { role: 'system', content: 'You are an n8n workflow patcher. Output only valid JSON arrays.' },
        { role: 'user', content: patchPrompt },
      ],
      temperature: APPLY_STEP_BUDGETS.temperature,
      maxTokens: APPLY_STEP_BUDGETS.max_tokens,
    });

    timings.llm = Date.now() - startLlm;

    if (!llmResult.ok) {
      console.error('[assist/apply-step] LLM call failed:', llmResult.error);
      timings.total = Date.now() - startTotal;
      debug.timings_ms = timings;
      return res.json({
        ok: false,
        error: 'LLM patch generation failed',
        patch: null,
        test_workflow_id: testWorkflowId,
        diff_summary: null,
        debug,
      });
    }

    // 9. Parse and validate patch
    const patch = parsePatchResponse(llmResult.data.answer, stepId);
    if (!patch) {
      console.error('[assist/apply-step] Patch parsing failed');
      timings.total = Date.now() - startTotal;
      debug.timings_ms = timings;
      return res.json({
        ok: false,
        error: 'Invalid patch format from LLM',
        patch: null,
        test_workflow_id: testWorkflowId,
        diff_summary: null,
        debug,
      });
    }

    // 10. Compute diff summary
    const diffSummary = computeDiffSummary(patch);

    // 11. If dry_run=false, apply patch
    let applyStatus = 'dry_run';
    if (!dryRun) {
      const startApply = Date.now();

      // Apply patch to workflow (may throw if node type is invalid)
      let patchedWorkflow: N8nWorkflow;
      let appliedDiff: string;
      try {
        const result = applyPatchToWorkflow(testWorkflow, patch);
        patchedWorkflow = result.workflow;
        appliedDiff = result.diffSummary;
      } catch (patchErr) {
        const errMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
        console.error('[assist/apply-step] Patch application failed:', errMsg);

        timings.apply = Date.now() - startApply;
        timings.total = Date.now() - startTotal;
        debug.timings_ms = timings;

        return res.status(400).json({
          ok: false,
          error: `Patch application failed: ${errMsg}`,
          patch,
          test_workflow_id: testWorkflowId,
          diff_summary: null,
          debug,
        });
      }

      // Prepare valid n8n update payload (ensures active:false)
      const updatePayload = prepareWorkflowForUpdate(patchedWorkflow);

      // Add nodes preview for debugging (last 3 nodes with type info)
      const nodesForPreview = patchedWorkflow.nodes?.slice(-3) || [];
      debug.applied_nodes_preview = nodesForPreview.map(n => ({
        name: n.name,
        type: n.type,
        typeVersion: n.typeVersion ?? 0,  // Default to 0 if undefined
      }));

      // Update test workflow in n8n
      console.log(`[assist/apply-step] Sending update to n8n for workflow ${testWorkflowId}`, {
        nodeCount: updatePayload.nodes?.length,
        lastNodes: debug.applied_nodes_preview,
      });
      const updateResult = await updateWorkflow(connectionId, testWorkflowId, updatePayload);
      timings.apply = Date.now() - startApply;

      if (updateResult.error) {
        const errDetails = updateResult.error;
        console.error('[assist/apply-step] Failed to update test workflow:', errDetails);

        // Sanitize error body (remove potential secrets)
        const sanitizedBody = errDetails.details
          ? errDetails.details.replace(/api[_-]?key[^"]*"[^"]+"/gi, 'api_key:"[REDACTED]"')
          : undefined;

        // Add apply_error to debug for transparency
        debug.apply_error = {
          status: errDetails.status || 500,
          message: errDetails.message || 'Unknown error',
          body: sanitizedBody?.slice(0, 500),  // Truncate to 500 chars
        };

        // Store failed audit record
        const record = {
          workflow_uuid: workflowId,
          plan_id: planId,
          step_id: stepId,
          test_workflow_id: testWorkflowId,
          patch_json: patch,
          rollback_json: patch.rollback,
          diff_summary: diffSummary,
          status: 'failed',
          error: `${errDetails.status}: ${errDetails.message}`,
          idempotency_key: idempotency_key || null,
          applied_by: 'assist/apply-step',
        };

        const { error: auditError } = await supabaseAdmin.from('step_applications').insert(record);

        if (auditError) {
          console.error('[assist/apply-step] Failed to write audit log:', auditError);
          debug.audit_error = `Failed to persist audit log: ${JSON.stringify(auditError)}`;
        }

        timings.total = Date.now() - startTotal;
        debug.timings_ms = timings;
        return res.json({
          ok: false,
          error: `Failed to apply patch: ${errDetails.message}`,
          patch,
          test_workflow_id: testWorkflowId,
          diff_summary: diffSummary,
          debug,
        });
      }

      applyStatus = 'applied';
      console.log(`[assist/apply-step] Patch applied successfully: ${appliedDiff}`);

      // Store successful audit record
      const record = {
        workflow_uuid: workflowId,
        plan_id: planId,
        step_id: stepId,
        test_workflow_id: testWorkflowId,
        patch_json: patch,
        rollback_json: patch.rollback,
        diff_summary: diffSummary,
        status: 'applied',
        error: null,
        idempotency_key: idempotency_key || null,
        applied_by: 'assist/apply-step',
      };

      const { error: auditError } = await supabaseAdmin.from('step_applications').insert(record);

      if (auditError) {
        console.error('[assist/apply-step] Failed to write audit log:', auditError);
        debug.audit_error = `Failed to persist audit log: ${JSON.stringify(auditError)}`;
      }

      // Update step status
      await supabaseAdmin
        .from('completion_steps')
        .update({ status: 'done' })
        .eq('plan_id', planId)
        .eq('step_id', stepId);
    }



    // 12. Return response
    timings.total = Date.now() - startTotal;
    debug.timings_ms = timings;

    const response: ApplyStepResponse = {
      ok: true,
      patch,
      test_workflow_id: testWorkflowId,
      diff_summary: diffSummary,
      debug,
    };

    console.log(`[assist/apply-step] Success in ${timings.total}ms, status=${applyStatus}, ops=${patch.operations.length}`);
    res.json(response);

  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[assist/apply-step] error:', e);
    res.status(500).json({
      ok: false,
      error: `Internal error: ${errMsg}`,
      patch: null,
      test_workflow_id: null,
      diff_summary: null,
      debug: createEmptyApplyStepDebug('', '', ''),
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Idempotency lookup (read-only, admin-token gated)
// ═══════════════════════════════════════════════════════════════════
router.get('/v3/assist/apply-step/idempotency/:key', async (req: Request, res: Response) => {
  try {
    // Auth: require VN_ADMIN_TOKEN header
    const adminToken = process.env.VN_ADMIN_TOKEN;
    const headerToken = req.headers['x-vn-admin-token'] as string | undefined;
    if (!adminToken || headerToken !== adminToken) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const key = req.params.key?.trim();
    if (!key) {
      return res.status(400).json({ ok: false, error: 'idempotency key is required' });
    }

    const { data: rows, error } = await supabaseAdmin
      .from('step_applications')
      .select('id, status, created_at, workflow_uuid, plan_id, step_id')
      .eq('idempotency_key', key)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[idempotency-lookup] DB error:', error);
      return res.status(500).json({ ok: false, error: 'database error' });
    }

    const count = rows?.length ?? 0;
    const latest = count > 0 ? rows![0] : null;

    return res.json({ ok: true, count, latest });
  } catch (e) {
    console.error('[idempotency-lookup] error:', e);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Sandbox reset (guarded, optional recreate, cooldown)
// ═══════════════════════════════════════════════════════════════════
const resetCooldowns = new Map<string, number>();

router.post('/v3/workflows/:workflowUuid/sandbox/reset', async (req: Request, res: Response) => {
  try {
    const { workflowUuid } = req.params;
    const { confirm, connectionId } = req.body;
    const recreate = req.query.recreate === '1';

    // 1. Validate confirm token
    if (confirm !== 'RESET_VN_TEST') {
      return res.status(400).json({
        ok: false,
        error: 'Body must include { confirm: "RESET_VN_TEST" }',
      });
    }

    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing connectionId in request body',
      });
    }

    if (!workflowUuid || typeof workflowUuid !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing workflowUuid in URL path',
      });
    }

    // 2. Cooldown check (10s per connectionId+workflowUuid)
    const cooldownKey = `${connectionId}:${workflowUuid}`;
    const lastReset = resetCooldowns.get(cooldownKey);
    if (lastReset && Date.now() - lastReset < 10_000) {
      return res.status(429).json({ ok: false, error: 'reset_cooldown' });
    }

    // 3. Auth: resolve user
    const userId = await resolveUserIdForConnection(req, connectionId);
    if (!userId) {
      return res.status(403).json({ ok: false, error: 'Unauthorized or connection not found' });
    }

    // 4. Resolve n8n workflow ID (prod)
    const resolveResult = await resolveN8nWorkflowId({
      workflowId: workflowUuid,
      connectionId,
      userId,
    });
    if (resolveResult.ok === false) {
      return res.status(404).json({ ok: false, error: resolveResult.error });
    }
    const prodN8nId = resolveResult.n8nWorkflowId;

    // 5. Look up existing test workflow
    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('vn_test_workflows')
      .select('id, test_n8n_workflow_id')
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .eq('prod_workflow_uuid', workflowUuid)
      .maybeSingle();

    if (lookupError) {
      console.error('[sandbox/reset] DB lookup error:', lookupError);
      return res.status(500).json({ ok: false, error: 'database error' });
    }

    if (!existing) {
      return res.status(404).json({ ok: false, error: 'No test workflow found for this workflow' });
    }

    // 6. Safety: refuse if test ID equals prod ID
    if (existing.test_n8n_workflow_id === prodN8nId) {
      console.error('[sandbox/reset] REFUSED: test_n8n_workflow_id equals prod_n8n_workflow_id');
      return res.status(403).json({
        ok: false,
        error: 'SAFETY: test workflow ID matches production workflow ID. Refusing to delete.',
      });
    }

    // 7. Delete n8n workflow
    const deletedId = existing.test_n8n_workflow_id;
    console.log(`[sandbox/reset] Deleting test workflow: ${deletedId}`);
    await deleteWorkflow(connectionId, deletedId).catch((e) => {
      console.error('[sandbox/reset] Failed to delete n8n workflow:', e instanceof Error ? e.message : e);
    });

    // 8. Delete DB row
    const { error: deleteError } = await supabaseAdmin
      .from('vn_test_workflows')
      .delete()
      .eq('id', existing.id);

    if (deleteError) {
      console.error('[sandbox/reset] Failed to delete DB record:', deleteError);
    }

    // Record cooldown
    resetCooldowns.set(cooldownKey, Date.now());

    console.log(`[sandbox/reset] Reset complete for ${workflowUuid}`);

    // 9. Optional: recreate via internal fetch to sandbox/ensure
    if (recreate) {
      console.log('[sandbox/reset] recreate=1, calling sandbox/ensure internally...');
      // Build internal request to sandbox/ensure
      const ensureUrl = `http://127.0.0.1:${req.socket.localPort}/api/v3/workflows/${workflowUuid}/sandbox/ensure`;
      const ensureRes = await fetch(ensureUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });
      const ensureData = await ensureRes.json() as {
        ok: boolean;
        testWorkflow?: { testN8nWorkflowId?: string; webhookUrl?: string };
        error?: string;
      };

      if (ensureData.ok && ensureData.testWorkflow) {
        return res.json({
          ok: true,
          deleted: deletedId,
          recreated: true,
          test_workflow_id: ensureData.testWorkflow.testN8nWorkflowId,
          // Do NOT log webhook URL in response for safety; include for client use only
          webhook_url: ensureData.testWorkflow.webhookUrl,
        });
      } else {
        return res.json({
          ok: true,
          deleted: deletedId,
          recreated: false,
          recreate_error: ensureData.error || 'sandbox/ensure failed',
        });
      }
    }

    return res.json({
      ok: true,
      deleted: deletedId,
      message: 'Reset complete. Call /sandbox/ensure to recreate.',
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[sandbox/reset] error:', errMsg);
    return res.status(500).json({ ok: false, error: `Internal error: ${errMsg}` });
  }
});

export default router;
