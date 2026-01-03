/**
 * V3 execution poller
 *
 * Goal: Automatically detect new executions for (connectionId, workflowId) and
 * update workflow_node_state + publish SSE updates without requiring users to add n8n nodes.
 */

import { supabaseAdmin } from '../lib/supabase';
import { getExecution, getWorkflow, listRecentExecutions } from './n8nClient';
import { getWorkflowKey, publishWorkflowState } from './pubsub';
import type { N8nExecution, N8nWorkflow, WorkflowState } from './types';
import { mergeExecutionIntoState, buildWorkflowState } from './workflowState';
import { decorateStateForUi } from './decorate';

type PollKey = string; // connectionId:workflowId

type PollerConfig = {
  pollMs: number;
  graceMs: number;
  maxBackoffMs: number;
};

type Session = {
  key: PollKey;
  connectionId: string;
  workflowId: string;
  userId: string;

  subscribers: number;

  workflow?: N8nWorkflow;
  state?: WorkflowState; // last known base state (non-decorated)

  lastSeenExecutionId?: string;
  lastSeenExecutionStatus?: string; // Track status to detect changes even if ID unchanged

  timer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;

  backoffMs: number;
  running: boolean;
};

function readConfig(): PollerConfig {
  const pollMs = Number(process.env.EXECUTION_POLL_MS || 2000);
  const graceMs = Number(process.env.EXECUTION_POLL_GRACE_MS || 45000);
  const maxBackoffMs = Number(process.env.EXECUTION_POLL_MAX_BACKOFF_MS || 30000);
  return {
    pollMs: Number.isFinite(pollMs) ? pollMs : 2000,
    graceMs: Number.isFinite(graceMs) ? graceMs : 45000,
    maxBackoffMs: Number.isFinite(maxBackoffMs) ? maxBackoffMs : 30000,
  };
}

const sessions = new Map<PollKey, Session>();

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}

function getLastRunAt(execution: N8nExecution): string | null {
  const ts = execution.stoppedAt || execution.startedAt;
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getExecutedNodeNames(execution: N8nExecution): Set<string> {
  const runData = execution?.data?.resultData?.runData;
  if (!runData || typeof runData !== 'object') return new Set();
  return new Set(Object.keys(runData));
}

/**
 * Extract debug information from execution for troubleshooting
 */
function getExecutionDebug(execution: N8nExecution | null, workflow: N8nWorkflow | null): {
  latestExecutionId: string | null;
  latestExecutionStatus: string | null;
  runDataKeys: string[];
  hasRunData: boolean;
  topErrorNode: string | null;
  topErrorMessage: string | null;
  matchedNodeNames: string[];
  unmatchedRunDataKeys: string[];
  includeDataReturnedRunData: boolean;
} {
  if (!execution) {
    return {
      latestExecutionId: null,
      latestExecutionStatus: null,
      runDataKeys: [],
      hasRunData: false,
      topErrorNode: null,
      topErrorMessage: null,
      matchedNodeNames: [],
      unmatchedRunDataKeys: [],
      includeDataReturnedRunData: false,
    };
  }

  // Try multiple paths for resultData (handle different n8n API shapes)
  const execAny = execution as any;
  const rd = execAny?.data?.resultData ?? execAny?.resultData ?? execAny?.data?.data?.resultData ?? null;
  const runData = rd?.runData ?? {};
  const topError = rd?.error ?? null;
  const runDataKeys = typeof runData === 'object' && runData !== null ? Object.keys(runData) : [];
  const hasRunData = runDataKeys.length > 0;

  // Check if includeData=true worked (has runData or error structure)
  const includeDataReturnedRunData = hasRunData || !!topError || !!rd;

  // Extract top error info
  const topErrorNode =
    (typeof topError?.node?.name === 'string' ? topError.node.name : null) ??
    (typeof topError?.node === 'string' ? topError.node : null) ??
    (typeof topError?.context?.node?.name === 'string' ? topError.context.node.name : null) ??
    null;
  const topErrorMessage =
    (typeof topError?.message === 'string' ? topError.message : null) ??
    (Array.isArray(topError?.messages) && typeof topError.messages[0] === 'string' ? topError.messages[0] : null) ??
    null;

  // Match runData keys to workflow node names
  const workflowNodeNames = new Set((workflow?.nodes || []).map((n) => n.name));
  const matchedNodeNames = runDataKeys.filter((name) => workflowNodeNames.has(name));
  const unmatchedRunDataKeys = runDataKeys.filter((name) => !workflowNodeNames.has(name));

  return {
    latestExecutionId: execution.id ? String(execution.id) : null,
    latestExecutionStatus: execution.status || null,
    runDataKeys,
    hasRunData,
    topErrorNode,
    topErrorMessage: topErrorMessage ? topErrorMessage.slice(0, 200) : null,
    matchedNodeNames,
    unmatchedRunDataKeys,
    includeDataReturnedRunData,
  };
}

async function upsertNodeRunResults(params: {
  userId: string;
  connectionId: string;
  workflowId: string;
  workflow: N8nWorkflow;
  execution: N8nExecution;
  updatedState: WorkflowState;
}): Promise<void> {
  const { userId, connectionId, workflowId, workflow, execution, updatedState } = params;

  const executedNames = getExecutedNodeNames(execution);
  if (executedNames.size === 0) return;

  const lastRunAt = getLastRunAt(execution);
  const nowIso = new Date().toISOString();

  // Build a lookup for workflow node metadata (id/type) by name
  const wfByName = new Map<string, { id: string | null; type: string }>();
  for (const n of workflow.nodes || []) {
    wfByName.set(n.name, { id: n.id || null, type: n.type });
  }

  // Update only nodes touched by this execution (executed or failed).
  const rows = updatedState.nodes
    .filter((n) => executedNames.has(n.name))
    .map((n) => {
      const wfMeta = wfByName.get(n.name);
      const status = n.verified.status;
      const isSuccess = status === 'success';
      const isFailed = status === 'failed';

      return {
        user_id: userId,
        connection_id: connectionId,
        workflow_id: workflowId,

        // required identity columns
        node_key: n.name,
        node_id: wfMeta?.id ?? n.id ?? null,
        node_name: n.name,
        node_type: wfMeta?.type ?? n.type,

        // execution metadata
        last_execution_id: execution.id,
        last_run_at: lastRunAt,

        // verification state (consistent rule: last run determines verified/failed)
        verified: isSuccess,
        failed: isFailed,
        last_error: isFailed
          ? (n.verified.error || 'Execution failed').slice(0, 2000) // Truncate to 2000 chars
          : null,

        // touch timestamp
        updated_at: nowIso,
      };
    });

  if (rows.length === 0) return;

  const t0 = Date.now();
  const { error } = await supabaseAdmin
    .from('workflow_node_state')
    .upsert(rows as any, { onConflict: 'connection_id,workflow_id,node_key' });
  const t1 = Date.now();

  if (error) {
    console.error('[poller] upsert failed', { connectionId, workflowId, error });
  } else {
    console.log('[poller] upsert ok', { connectionId, workflowId, rows: rows.length, ms: t1 - t0 });
  }
}

async function pollCycle(session: Session, reason: 'loop' | 'kick' | 'manual'): Promise<DecoratedWorkflowStateResult> {
  const cfg = readConfig();
  const key = session.key;

  // Always ensure we have workflow cached (node list required)
  if (!session.workflow) {
    const wf0 = Date.now();
    const wfRes = await getWorkflow(session.connectionId, session.workflowId);
    const wf1 = Date.now();
    console.log('[poller] getWorkflow', { key, ms: wf1 - wf0, ok: !!wfRes.data });
    if (wfRes.error || !wfRes.data) {
      throw new Error(wfRes.error?.message || 'Failed to fetch workflow');
    }
    session.workflow = wfRes.data;
  }

  // Ensure we have a base state (used to avoid regressions on nodes that didn't run in latest exec)
  if (!session.state) {
    session.state = buildWorkflowState(session.connectionId, session.workflowId, session.workflow);
  }

  // List latest execution (light call)
  const tList0 = Date.now();
  const listRes = await listRecentExecutions(session.connectionId, session.workflowId, 1, { includeData: false });
  const tList1 = Date.now();
  console.log('[poller] listExecutions', { key, ms: tList1 - tList0, ok: !!listRes.data });

  if (listRes.error) {
    throw new Error(listRes.error.message);
  }

  const latest = listRes.data?.[0] as any;
  const latestId = latest?.id ? String(latest.id) : null;
  const latestStatus = latest?.status || null;

  if (!latestId) {
    // No executions yet; return current state (decorated)
    const debugEnabled = process.env.EXECUTION_POLL_DEBUG === '1';
    return {
      key,
      state: decorateStateForUi(session.state),
      changed: false,
      ...(debugEnabled ? { debug: getExecutionDebug(null, session.workflow || null) } : {}),
    };
  }

  // Check if we need to fetch full execution:
  // 1. Execution ID changed, OR
  // 2. Same execution ID but status changed (e.g., running -> error)
  const executionIdChanged = !session.lastSeenExecutionId || session.lastSeenExecutionId !== latestId;
  const statusChanged = session.lastSeenExecutionStatus !== latestStatus && (latestStatus === 'error' || latestStatus === 'running');

  if (!executionIdChanged && !statusChanged) {
    // Unchanged - return cached state
    const debugEnabled = process.env.EXECUTION_POLL_DEBUG === '1';
    return {
      key,
      state: decorateStateForUi(session.state),
      changed: false,
      ...(debugEnabled
        ? {
            debug: {
              latestExecutionId: latestId,
              latestExecutionStatus: latestStatus,
              runDataKeys: [],
              matchedNodeNames: [],
              unmatchedRunDataKeys: [],
              hasRunData: false,
              includeDataReturnedRunData: false,
              topErrorNode: null,
              topErrorMessage: null,
            },
          }
        : {}),
    };
  }

  // Fetch execution details (heavy call when executionId or status changes)
  const tExec0 = Date.now();
  const execRes = await getExecution(session.connectionId, latestId);
  const tExec1 = Date.now();
  console.log('[poller] getExecution', { key, executionId: latestId, ms: tExec1 - tExec0, ok: !!execRes.data });

  if (execRes.error || !execRes.data) {
    throw new Error(execRes.error?.message || 'Failed to fetch execution details');
  }

  session.lastSeenExecutionId = latestId;
  session.lastSeenExecutionStatus = latestStatus;

  // Merge execution into state (does NOT regress nodes without runData)
  const updated = mergeExecutionIntoState(session.state, execRes.data);
  session.state = updated;

  // Persist execution results (best-effort)
  await upsertNodeRunResults({
    userId: session.userId,
    connectionId: session.connectionId,
    workflowId: session.workflowId,
    workflow: session.workflow,
    execution: execRes.data,
    updatedState: updated,
  });

  // Build debug info if enabled
  const debugEnabled = process.env.EXECUTION_POLL_DEBUG === '1';
  const debug = debugEnabled ? getExecutionDebug(execRes.data, session.workflow || null) : undefined;

  // Decorate state (with optional debug)
  const decorated = decorateStateForUi(updated, debug);

  // Publish decorated state to subscribers
  publishWorkflowState(key, decorated as any);

  return { key, state: decorated, changed: true, ...(debug ? { debug } : {}) };
}

type DecoratedWorkflowStateResult = {
  key: string;
  state: any;
  changed: boolean;
  debug?: {
    latestExecutionId: string | null;
    latestExecutionStatus: string | null;
    runDataKeys: string[];
    matchedNodeNames: string[];
    unmatchedRunDataKeys: string[];
    hasRunData: boolean;
    includeDataReturnedRunData: boolean;
    topErrorNode: string | null;
    topErrorMessage: string | null;
  };
};

function scheduleNext(session: Session, delayMs: number) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => void loop(session.key), delayMs);
}

async function loop(key: PollKey) {
  const session = sessions.get(key);
  if (!session) return;
  if (session.running) return;

  const cfg = readConfig();

  // Stop if no subscribers and grace timer already elapsed (stop() will remove session)
  if (session.subscribers <= 0 && session.stopTimer) {
    // waiting for stop
  }

  session.running = true;
  try {
    await pollCycle(session, 'loop');
    session.backoffMs = cfg.pollMs; // reset backoff on success
    scheduleNext(session, cfg.pollMs);
  } catch (e) {
    const msg = safeErrorMessage(e);
    session.backoffMs = Math.min(session.backoffMs ? Math.max(session.backoffMs, cfg.pollMs) : cfg.pollMs, cfg.maxBackoffMs);
    // increase backoff (2s -> 5s -> 10s -> ... up to max)
    const next = Math.min(Math.round(session.backoffMs * 2.5), cfg.maxBackoffMs);
    session.backoffMs = next;
    console.warn('[poller] error', { key, msg, nextMs: next });
    scheduleNext(session, next);
  } finally {
    session.running = false;
  }
}

export function ensurePolling(params: {
  connectionId: string;
  workflowId: string;
  userId: string;
  workflow?: N8nWorkflow;
  seedState?: WorkflowState;
  // if called from /sync without subscribers, poller will still run for grace period
  reason: 'sse' | 'sync' | 'manual';
}): void {
  const key = getWorkflowKey(params.connectionId, params.workflowId);
  const cfg = readConfig();

  let session = sessions.get(key);
  if (!session) {
    session = {
      key,
      connectionId: params.connectionId,
      workflowId: params.workflowId,
      userId: params.userId,
      subscribers: 0,
      workflow: params.workflow,
      state: params.seedState,
      lastSeenExecutionId: undefined,
      lastSeenExecutionStatus: undefined,
      backoffMs: cfg.pollMs,
      running: false,
    };
    sessions.set(key, session);
  } else {
    session.userId = params.userId;
    if (params.workflow) session.workflow = params.workflow;
    if (params.seedState) session.state = params.seedState;
  }

  // Cancel pending stop
  if (session.stopTimer) {
    clearTimeout(session.stopTimer);
    session.stopTimer = undefined;
  }

  // If started via sync and there are no subscribers, start a stop timer immediately.
  if (params.reason === 'sync' && session.subscribers <= 0) {
    session.stopTimer = setTimeout(() => stop(key), cfg.graceMs);
  }

  // Kick loop (immediate)
  scheduleNext(session, 0);
}

export function onSubscriberConnected(params: {
  connectionId: string;
  workflowId: string;
  userId: string;
  workflow?: N8nWorkflow;
  seedState?: WorkflowState;
}): void {
  const key = getWorkflowKey(params.connectionId, params.workflowId);
  ensurePolling({
    connectionId: params.connectionId,
    workflowId: params.workflowId,
    userId: params.userId,
    workflow: params.workflow,
    seedState: params.seedState,
    reason: 'sse',
  });
  const session = sessions.get(key);
  if (!session) return;
  session.subscribers += 1;
}

export function onSubscriberDisconnected(connectionId: string, workflowId: string): void {
  const key = getWorkflowKey(connectionId, workflowId);
  const session = sessions.get(key);
  if (!session) return;
  session.subscribers = Math.max(0, session.subscribers - 1);

  if (session.subscribers === 0) {
    const cfg = readConfig();
    if (session.stopTimer) clearTimeout(session.stopTimer);
    session.stopTimer = setTimeout(() => stop(key), cfg.graceMs);
  }
}

export function stop(key: PollKey): void {
  const session = sessions.get(key);
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  if (session.stopTimer) clearTimeout(session.stopTimer);
  sessions.delete(key);
  console.log('[poller] stopped', { key });
}

export async function pollOnce(params: {
  connectionId: string;
  workflowId: string;
  userId: string;
}): Promise<{ ok: true; state: any; changed: boolean; debug?: any }> {
  const key = getWorkflowKey(params.connectionId, params.workflowId);
  ensurePolling({
    connectionId: params.connectionId,
    workflowId: params.workflowId,
    userId: params.userId,
    reason: 'manual',
  });

  const session = sessions.get(key);
  if (!session) {
    // should not happen
    const wfRes = await getWorkflow(params.connectionId, params.workflowId);
    if (wfRes.error || !wfRes.data) throw new Error(wfRes.error?.message || 'Failed to fetch workflow');
    const base = buildWorkflowState(params.connectionId, params.workflowId, wfRes.data);
    const debugEnabled = process.env.EXECUTION_POLL_DEBUG === '1';
    return {
      ok: true,
      state: decorateStateForUi(base),
      changed: false,
      ...(debugEnabled ? { debug: getExecutionDebug(null, wfRes.data) } : {}),
    };
  }

  // Run exactly one cycle right now
  const result = await pollCycle(session, 'manual');
  return {
    ok: true,
    state: result.state,
    changed: result.changed,
    ...(result.debug ? { debug: result.debug } : {}),
  };
}


