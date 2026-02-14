/**
 * Vibe Noding Core - Health Check Doctor Script
 * 
 * Usage:
 *   npm run doctor                 # Unit checks only (health, CORS)
 *   npm run doctor:integration     # + n8n integration checks
 * 
 * Unit checks (always run):
 *   - GET /health returns 200
 *   - CORS config
 * 
 * Integration checks (require --integration flag or DOCTOR_INTEGRATION=1):
 *   - Workflow resolution
 *   - Sandbox engine (ensure, status, run)
 *   - Assist Ask, Plan, Apply-Step
 *   - Requires DOCTOR_WORKFLOW_UUID + DOCTOR_CONNECTION_ID
 */

import 'dotenv/config';
import { spawn, execSync, ChildProcess } from 'child_process';

let serverProcess: ChildProcess | null = null;

const PORT = process.env.PORT || '3000';
const BASE_URL = process.env.DOCTOR_BASE_URL || `http://127.0.0.1:${PORT}`;
const WORKFLOW_UUID = process.env.DOCTOR_WORKFLOW_UUID;
const CONNECTION_ID = process.env.DOCTOR_CONNECTION_ID;
const INTEGRATION = process.argv.includes('--integration') || process.env.DOCTOR_INTEGRATION === '1';

// Colors for terminal output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

const GRAY = '\x1b[90m';

function pass(msg: string): void { console.log(`${GREEN}[PASS]${RESET} ${msg}`); }
function fail(msg: string): void { console.log(`${RED}[FAIL]${RESET} ${msg}`); }
function warn(msg: string): void { console.log(`${YELLOW}[WARN]${RESET} ${msg}`); }
function info(msg: string): void { console.log(`${BLUE}[INFO]${RESET} ${msg}`); }
function skip(msg: string): void { console.log(`${GRAY}[SKIP]${RESET} ${msg}`); }

// Safe JSON parser - handles unknown response type
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Discovered endpoints from code analysis
const ENDPOINTS = {
  health: '/api/v3/node-library/health',
  sync: '/api/n8n/sync',
  evaluate: '/api/v3/workflows/evaluate',
  sse: '/api/stream/workflow-state',
  poll: '/api/v3/workflows/:workflowId/poll',
  resolve: '/api/v3/workflows/resolve',
  // Sandbox engine endpoints
  sandboxEnsure: '/api/v3/workflows/:workflowUuid/sandbox/ensure',
  sandboxRun: '/api/v3/workflows/:workflowUuid/sandbox/run',
  fixtures: '/api/v3/workflows/:workflowUuid/fixtures',
  // Assist mode endpoints
  assistAsk: '/api/v3/assist/ask',
  assistPlan: '/api/v3/assist/plan',
  assistApplyStep: '/api/v3/assist/apply-step',
};

async function checkHealth(): Promise<boolean> {
  console.log(`\n--- Health Check ---`);

  try {
    const res = await fetch(`${BASE_URL}${ENDPOINTS.health}`);
    const data = await safeJson(res);

    if (res.status === 200 && data.ok === true) {
      pass(`${ENDPOINTS.health} -> 200 OK`);
      info(`Service: ${String(data.service || 'unknown')}, ts: ${String(data.ts || 'n/a')}`);
      return true;
    } else {
      fail(`${ENDPOINTS.health} -> ${res.status}`);
      console.log(`   Body: ${JSON.stringify(data).slice(0, 300)}`);
      return false;
    }
  } catch (e) {
    fail(`Cannot reach ${BASE_URL}${ENDPOINTS.health}`);
    console.log(`   Error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function startApiServer(): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // Use stdio: 'inherit' to show API logs to user (helpful for debugging startup)
  serverProcess = spawn(cmd, ['run', 'start:doctor'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env }
  });

  console.log('Waiting for API to be ready...');

  // Poll for health (up to 30 seconds)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      // Use a short timeout for the dry run to avoid hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);

      const res = await fetch(`${BASE_URL}${ENDPOINTS.health}`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.status === 200) {
        console.log(`\n${GREEN}API server started and healthy.${RESET}`);
        return true;
      }
    } catch {
      process.stdout.write('.');
    }
  }
  return false;
}

function printEndpoints(): void {
  console.log(`\n--- Discovered Endpoints ---`);
  console.log(`Base URL: ${BASE_URL}\n`);
  console.log(`  GET  ${ENDPOINTS.health}`);
  console.log(`  POST ${ENDPOINTS.sync}`);
  console.log(`  GET  ${ENDPOINTS.evaluate}`);
  console.log(`  GET  ${ENDPOINTS.sse}`);
  console.log(`  POST ${ENDPOINTS.poll}`);
  console.log(`  GET  ${ENDPOINTS.resolve} (dev)`);
  console.log(`\n  --- Sandbox Engine ---`);
  console.log(`  POST ${ENDPOINTS.sandboxEnsure}`);
  console.log(`  GET  ${ENDPOINTS.fixtures}`);
  console.log(`  POST ${ENDPOINTS.fixtures}`);
  console.log(`  POST ${ENDPOINTS.sandboxRun}`);
  console.log(`\n  --- Assist Mode ---`);
  console.log(`  POST ${ENDPOINTS.assistAsk}`);
}

async function checkCORS(): Promise<boolean> {
  console.log(`\n--- CORS Check ---`);

  try {
    const res = await fetch(`${BASE_URL}${ENDPOINTS.health}`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:8080',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });

    const allowOrigin = res.headers.get('access-control-allow-origin') || '';
    const allowHeaders = res.headers.get('access-control-allow-headers') || '';

    let allPass = true;

    if (allowOrigin === 'http://localhost:8080' || allowOrigin === '*') {
      pass(`Origin allowed: ${allowOrigin}`);
    } else {
      fail(`Origin not allowed (got: ${allowOrigin || 'none'})`);
      allPass = false;
    }

    if (allowHeaders.toLowerCase().includes('authorization')) {
      pass('Authorization header allowed');
    } else {
      fail(`Authorization not in allowed headers: ${allowHeaders}`);
      allPass = false;
    }

    return allPass;
  } catch (e) {
    fail(`CORS check failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function testWorkflowResolution(): Promise<boolean> {
  console.log(`\n--- Workflow ID Resolution ---`);

  if (!WORKFLOW_UUID || !CONNECTION_ID) {
    info('Skipped: Set DOCTOR_WORKFLOW_UUID and DOCTOR_CONNECTION_ID to test');
    return true;
  }

  info(`Testing UUID: ${WORKFLOW_UUID.slice(0, 8)}...`);
  info(`Connection: ${CONNECTION_ID.slice(0, 8)}...`);

  // Test resolve endpoint
  try {
    const url = `${BASE_URL}${ENDPOINTS.resolve}?connectionId=${CONNECTION_ID}&workflowId=${WORKFLOW_UUID}`;
    const res = await fetch(url);
    const data = await safeJson(res);

    if (res.status === 200 && data.ok === true) {
      // The resolve endpoint returns nested structure: data.resolved.n8nWorkflowId
      const resolved = data.resolved as Record<string, unknown> | undefined;
      const n8nId = resolved ? String(resolved.n8nWorkflowId) : 'undefined';
      const sourceTable = resolved ? String(resolved.sourceTable) : 'undefined';

      // FAIL if undefined
      if (!n8nId || n8nId === 'undefined') {
        fail(`Resolved to undefined n8nWorkflowId (source: ${sourceTable})`);
        console.log(`   Full response: ${JSON.stringify(data).slice(0, 300)}`);
        return false;
      }

      pass(`Resolved -> n8nWorkflowId: ${n8nId}`);
      info(`Source: ${sourceTable}`);

      // Test evaluate endpoint
      const evalUrl = `${BASE_URL}${ENDPOINTS.evaluate}?connectionId=${CONNECTION_ID}&workflowId=${WORKFLOW_UUID}`;
      const evalRes = await fetch(evalUrl);
      const evalData = await safeJson(evalRes);

      if (evalRes.status === 200 && evalData.ok === true) {
        pass(`Evaluate endpoint works`);
        const cacheControl = evalRes.headers.get('cache-control') || '';
        if (cacheControl.includes('no-store')) {
          pass(`Cache-Control: ${cacheControl}`);
        } else {
          warn(`Cache-Control missing no-store: ${cacheControl}`);
        }
      } else {
        fail(`Evaluate returned ${evalRes.status}`);
      }

      // Test poll endpoint
      const pollUrl = `${BASE_URL}/api/v3/workflows/${n8nId}/poll?connectionId=${CONNECTION_ID}`;
      const pollRes = await fetch(pollUrl, { method: 'POST' });
      const pollData = await safeJson(pollRes);

      if (pollRes.status === 200) {
        pass(`Poll endpoint works`);
        const cacheControl = pollRes.headers.get('cache-control') || '';
        if (cacheControl.includes('no-store')) {
          pass(`Poll Cache-Control: ${cacheControl}`);
        } else {
          warn(`Poll Cache-Control missing no-store: ${cacheControl}`);
        }
      } else {
        warn(`Poll returned ${pollRes.status} (may need auth)`);
      }

      return true;
    } else if (res.status === 403) {
      warn('Resolve endpoint is production-protected');
      return true;
    } else {
      fail(`Resolution failed: ${String(data.error || res.status)}`);
      return false;
    }
  } catch (e) {
    fail(`Resolution test failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function testSandboxEndpoints(): Promise<boolean> {
  console.log(`\n--- Sandbox Engine ---`);

  if (!WORKFLOW_UUID || !CONNECTION_ID) {
    info('Skipped: Set DOCTOR_WORKFLOW_UUID and DOCTOR_CONNECTION_ID to test sandbox');
    return true;
  }

  let allPass = true;

  // Test ensure endpoint (with keepFailed=1 to allow inspection on failure)
  try {
    const ensureUrl = `${BASE_URL}/api/v3/workflows/${WORKFLOW_UUID}/sandbox/ensure?keepFailed=1`;
    info(`Testing: POST ${ensureUrl}`);

    const ensureRes = await fetch(ensureUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: CONNECTION_ID }),
    });
    const ensureData = await safeJson(ensureRes);

    if (ensureRes.status === 200 && ensureData.ok === true) {
      const testWorkflow = ensureData.testWorkflow as Record<string, unknown> | undefined;
      if (testWorkflow) {
        pass(`Sandbox ensure works (created: ${String(ensureData.created)})`);
        info(`Test workflow ID: ${String(testWorkflow.testN8nWorkflowId)}`);
        const webhookUrl = String(testWorkflow.webhookUrl);
        info(`Webhook URL: ${webhookUrl.slice(0, 60)}...`);

        // Print activation diagnostics if available
        if (ensureData.activationEndpoint) {
          info(`Activation endpoint: ${String(ensureData.activationEndpoint)}`);
        }
        if (ensureData.activationVerified !== undefined) {
          const verifiedStatus = ensureData.activationVerified ? 'YES' : 'NO';
          info(`Activation verified: ${verifiedStatus}`);

          if (!ensureData.activationVerified) {
            warn('Workflow activation could not be verified!');
          }
        }

        // Wait before webhook probe (allow n8n to register webhook)
        await new Promise(r => setTimeout(r, 500));

        // Verify workflow is active by attempting a webhook call
        try {
          const testPayload = { test: true, timestamp: Date.now() };
          const webhookTestRes = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload),
          });

          // Any response (even 500) means workflow is active and reachable
          // 404 means workflow is not active
          if (webhookTestRes.status === 404) {
            fail('Test workflow webhook returns 404 (workflow may not be active)');
            const body = await webhookTestRes.text().catch(() => '');
            if (body) {
              console.log(`   Response: ${body.slice(0, 200)}`);
            }
            allPass = false;
          } else {
            pass(`Test workflow is active and reachable (webhook status: ${webhookTestRes.status})`);
          }
        } catch (webhookErr) {
          warn(`Could not verify webhook reachability: ${webhookErr instanceof Error ? webhookErr.message : String(webhookErr)}`);
        }
      } else {
        pass('Sandbox ensure returned ok but no testWorkflow');
      }
    } else {
      fail(`Sandbox ensure failed: ${ensureRes.status}`);
      console.log(`   Error: ${String(ensureData.error || 'unknown')}`);
      if (ensureData.workflow_id) {
        console.log(`   Workflow ID: ${ensureData.workflow_id}`);
      }
      if (ensureData.webhook_url) {
        console.log(`   Webhook URL: ${ensureData.webhook_url}`);
      }
      if (ensureData.webhook_path_configured) {
        console.log(`   Webhook path configured: ${ensureData.webhook_path_configured}`);
      }
      if (ensureData.activation_endpoint) {
        console.log(`   Activation endpoint: ${ensureData.activation_endpoint}`);
      }
      if (ensureData.activation_verified !== undefined) {
        console.log(`   Activation verified: ${ensureData.activation_verified}`);
      }
      if (ensureData.n8n_status) {
        console.log(`   n8n status: ${ensureData.n8n_status}`);
      }
      if (ensureData.n8n_body) {
        console.log(`   n8n body: ${String(ensureData.n8n_body).slice(0, 500)}`);
      }
      if (ensureData.keep_failed) {
        console.log(`   keepFailed mode: workflow NOT deleted - inspect in n8n UI`);
      }
      if (ensureData.inspect_url) {
        console.log(`   Inspect URL: ${ensureData.inspect_url}`);
      }
      if (ensureData.diagnostics) {
        console.log(`   === DIAGNOSTICS FROM n8n ===`);
        const diag = ensureData.diagnostics as Record<string, unknown>;
        console.log(`   workflow_active_in_n8n: ${diag.workflow_active_in_n8n}`);
        if (Array.isArray(diag.webhook_nodes)) {
          for (const wh of diag.webhook_nodes as Array<Record<string, unknown>>) {
            console.log(`   Webhook node "${wh.name}": disabled=${wh.disabled}, path=${wh.path}, httpMethod=${wh.httpMethod}`);
          }
        }
        console.log(`   === END DIAGNOSTICS ===`);
      }
      allPass = false;
    }
  } catch (e) {
    fail(`Sandbox ensure error: ${e instanceof Error ? e.message : String(e)}`);
    allPass = false;
  }

  // Test fixtures list endpoint
  try {
    const fixturesUrl = `${BASE_URL}/api/v3/workflows/${WORKFLOW_UUID}/fixtures?connectionId=${CONNECTION_ID}`;
    info(`Testing: GET ${fixturesUrl}`);

    const fixturesRes = await fetch(fixturesUrl);
    const fixturesData = await safeJson(fixturesRes);

    if (fixturesRes.status === 200 && fixturesData.ok === true) {
      const fixtures = fixturesData.fixtures as unknown[] | undefined;
      pass(`Fixtures list works (${fixtures?.length || 0} fixtures)`);
    } else {
      fail(`Fixtures list failed: ${fixturesRes.status}`);
      allPass = false;
    }
  } catch (e) {
    fail(`Fixtures list error: ${e instanceof Error ? e.message : String(e)}`);
    allPass = false;
  }

  // Test fixture creation
  let createdFixtureId: string | null = null;
  try {
    const createFixtureUrl = `${BASE_URL}/api/v3/workflows/${WORKFLOW_UUID}/fixtures`;
    info(`Testing: POST ${createFixtureUrl}`);

    const createRes = await fetch(createFixtureUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        name: 'Doctor Test Fixture',
        payload: { test: true, timestamp: Date.now() },
        headers: {},
      }),
    });
    const createData = await safeJson(createRes);

    if (createRes.status === 201 && createData.ok === true) {
      const fixture = createData.fixture as Record<string, unknown> | undefined;
      createdFixtureId = fixture?.id as string || null;
      pass(`Fixture creation works (id: ${createdFixtureId?.slice(0, 8)}...)`);
    } else {
      fail(`Fixture creation failed: ${createRes.status}`);
      console.log(`   Response: ${JSON.stringify(createData).slice(0, 200)}`);
      allPass = false;
    }
  } catch (e) {
    fail(`Fixture creation error: ${e instanceof Error ? e.message : String(e)}`);
    allPass = false;
  }

  // Test sandbox run (only if fixture was created)
  if (createdFixtureId) {
    try {
      const runUrl = `${BASE_URL}/api/v3/workflows/${WORKFLOW_UUID}/sandbox/run`;
      info(`Testing: POST ${runUrl}`);

      const runRes = await fetch(runUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: CONNECTION_ID,
          fixtureId: createdFixtureId,
        }),
      });
      const runData = await safeJson(runRes);

      if (runRes.status === 200 && runData.ok === true) {
        const testRun = runData.testRun as Record<string, unknown> | undefined;
        pass(`Sandbox run works (status: ${testRun?.status}, latency: ${testRun?.latency_ms}ms)`);
      } else {
        // Run might fail if n8n webhook isn't set up properly - this is a warning, not failure
        warn(`Sandbox run returned: ${runRes.status} (webhook may not be active)`);
        console.log(`   Response: ${JSON.stringify(runData).slice(0, 200)}`);
      }
    } catch (e) {
      warn(`Sandbox run error: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    info('Skipping sandbox run test - no fixture created');
  }
  // Test sandbox/status endpoint
  try {
    const statusUrl = `${BASE_URL}/api/v3/workflows/${WORKFLOW_UUID}/sandbox/status`;
    info(`Testing: POST ${statusUrl}`);

    const statusRes = await fetch(statusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: CONNECTION_ID }),
    });
    const statusData = await safeJson(statusRes);

    if (statusRes.status === 200 && statusData.ok === true) {
      const webhookReachable = statusData.webhook_reachable === true;
      const needsRecreate = statusData.needs_recreate === true;
      const active = statusData.active === true;

      if (webhookReachable && !needsRecreate) {
        pass(`Sandbox status OK (active=${active}, webhook_reachable=${webhookReachable})`);
      } else if (needsRecreate) {
        fail(`Sandbox status: needs_recreate=true (webhook not reachable)`);
        allPass = false;
      } else {
        warn(`Sandbox status: webhook_reachable=${webhookReachable}, active=${active}`);
      }
    } else {
      fail(`Sandbox status failed: ${statusRes.status} - ${String(statusData.error || 'unknown')}`);
      allPass = false;
    }
  } catch (e) {
    fail(`Sandbox status error: ${e instanceof Error ? e.message : String(e)}`);
    allPass = false;
  }

  // Test double sandbox/run (reliability: both calls should succeed without manual intervention)
  if (createdFixtureId) {
    try {
      const runUrl = `${BASE_URL}/api/v3/workflows/${WORKFLOW_UUID}/sandbox/run`;
      info('Testing: double sandbox/run (reliability check)...');

      const run2Res = await fetch(runUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: CONNECTION_ID, fixtureId: createdFixtureId }),
      });
      const run2Data = await safeJson(run2Res);

      if (run2Res.status === 200 && run2Data.ok === true) {
        pass('Second sandbox/run succeeded (persistent webhook works)');
      } else {
        fail(`Second sandbox/run failed: ${run2Res.status} (webhook may not be persistently reachable)`);
        console.log(`   Response: ${JSON.stringify(run2Data).slice(0, 200)}`);
        allPass = false;
      }
    } catch (e) {
      fail(`Second sandbox/run error: ${e instanceof Error ? e.message : String(e)}`);
      allPass = false;
    }
  }

  return allPass;
}

async function testAssistAsk(): Promise<boolean> {
  console.log(`\n--- Assist Ask Mode (Phase 2A) ---`);

  // Skip if no workflow UUID configured
  if (!WORKFLOW_UUID || !CONNECTION_ID) {
    warn('DOCTOR_WORKFLOW_UUID and DOCTOR_CONNECTION_ID not set, skipping Assist Ask test');
    return true; // Don't fail, just skip
  }

  // Skip if no OpenAI API key configured
  if (!process.env.OPENAI_API_KEY) {
    warn('OPENAI_API_KEY not set, skipping Assist Ask test (optional feature)');
    return true; // Don't fail - Ask mode is optional
  }

  let allPass = true;

  // Helper to call Ask endpoint
  async function callAskEndpoint(msg: string): Promise<Record<string, unknown> | null> {
    const askUrl = `${BASE_URL}/api/v3/assist/ask`;
    const askRes = await fetch(askUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        workflowUuid: WORKFLOW_UUID,
        sessionId: 'doctor-test-' + Date.now(),
        message: msg,
      }),
    });

    const responseText = await askRes.text();
    try {
      return JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  try {
    info(`Testing: POST /api/v3/assist/ask`);

    // First call
    const askData = await callAskEndpoint('What issues exist in this workflow?');

    if (!askData) {
      fail('JSON correctness: INVALID');
      return false;
    }
    pass('JSON correctness: OK');

    if (askData.ok !== true) {
      fail(`Ask endpoint returned ok=false: ${String(askData.error)}`);
      return false;
    }
    pass('Assist Ask endpoint works');

    // Phase 2A: Contract shape validation
    console.log(`\n  ${BLUE}Phase 2A Contract Validation:${RESET}`);

    // Required top-level keys
    const requiredKeys = ['ok', 'answer', 'topFixFirst', 'issues', 'citations', 'debug'];
    for (const key of requiredKeys) {
      if (!(key in askData)) {
        fail(`Missing required key: ${key}`);
        allPass = false;
      } else {
        pass(`Has key: ${key}`);
      }
    }

    // Validate debug has Phase 2A fields
    if (askData.debug && typeof askData.debug === 'object') {
      const debug = askData.debug as Record<string, unknown>;

      // Check budgets
      if (debug.budgets && typeof debug.budgets === 'object') {
        const budgets = debug.budgets as Record<string, unknown>;
        if (budgets.temperature === 0) {
          pass('Deterministic mode: temperature=0');
        } else {
          fail(`Temperature is not 0: ${budgets.temperature}`);
          allPass = false;
        }
        if (typeof budgets.max_tokens === 'number') {
          pass(`Budgets.max_tokens: ${budgets.max_tokens}`);
        }
      } else {
        fail('Missing debug.budgets');
        allPass = false;
      }

      // Check timings
      if (debug.timings_ms && typeof debug.timings_ms === 'object') {
        const timings = debug.timings_ms as Record<string, unknown>;
        pass(`Timings: total=${timings.total}ms, fetch=${timings.fetch_workflow}ms, llm=${timings.llm}ms`);
      } else {
        fail('Missing debug.timings_ms');
        allPass = false;
      }

      // Check workflow_uuid
      if (debug.workflow_uuid) {
        pass(`workflow_uuid: ${String(debug.workflow_uuid).slice(0, 8)}...`);
      }

      // Check analyzed_source
      if (debug.analyzed_source === 'prod' || debug.analyzed_source === 'test') {
        pass(`analyzed_source: ${debug.analyzed_source}`);
      } else {
        warn(`analyzed_source has unexpected value: ${debug.analyzed_source}`);
      }
    }

    // Determinism check: call same endpoint twice
    console.log(`\n  ${BLUE}Determinism Check:${RESET}`);
    const askData2 = await callAskEndpoint('What issues exist in this workflow?');

    if (askData2 && askData2.ok === true) {
      // Compare issue ordering
      const issues1 = Array.isArray(askData.issues) ? askData.issues : [];
      const issues2 = Array.isArray(askData2.issues) ? askData2.issues : [];

      if (issues1.length === issues2.length) {
        pass(`Issue count stable: ${issues1.length}`);

        // Compare order (for string arrays)
        const order1 = issues1.map((i: unknown) => typeof i === 'string' ? i.slice(0, 50) : JSON.stringify(i).slice(0, 50)).join('|');
        const order2 = issues2.map((i: unknown) => typeof i === 'string' ? i.slice(0, 50) : JSON.stringify(i).slice(0, 50)).join('|');

        if (order1 === order2) {
          pass('Issue ordering deterministic');
        } else {
          warn('Issue ordering differs between calls (may be LLM variance)');
        }
      } else {
        warn(`Issue count changed: ${issues1.length} vs ${issues2.length} (may be LLM variance)`);
      }

      // Compare topFixFirst
      const top1 = askData.topFixFirst;
      const top2 = askData2.topFixFirst;
      if (JSON.stringify(top1) === JSON.stringify(top2)) {
        pass('topFixFirst deterministic');
      } else {
        warn('topFixFirst differs between calls');
      }
    } else {
      warn('Could not complete determinism check (second call failed)');
    }

    return allPass;
  } catch (e) {
    fail(`Assist Ask error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Test Assist Plan endpoint (Phase 2B)
 */
async function testAssistPlan(): Promise<boolean> {
  if (!WORKFLOW_UUID || !CONNECTION_ID) {
    warn('Skipping Plan test - DOCTOR_WORKFLOW_UUID and DOCTOR_CONNECTION_ID not set');
    return true;
  }

  console.log(`\n--- Assist Plan Mode (Phase 2B) ---`);
  info(`Testing: POST ${ENDPOINTS.assistPlan}`);

  let allPass = true;

  // Helper to call the plan endpoint
  async function callPlanEndpoint(): Promise<Record<string, unknown> | null> {
    try {
      const planUrl = `${BASE_URL}${ENDPOINTS.assistPlan}`;
      const planRes = await fetch(planUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: CONNECTION_ID,
          workflowUuid: WORKFLOW_UUID,
          analyzed_source: 'prod',
          userGoal: 'Doctor script test - fix any issues',
        }),
      });
      return await safeJson(planRes);
    } catch {
      return null;
    }
  }

  // Helper to extract stable order signature (phase ids + step ids + ranks)
  function extractStableSignature(plan: Record<string, unknown> | null): string {
    if (!plan || !Array.isArray(plan.phases)) return '';
    const parts: string[] = [];
    const phases = plan.phases as Array<Record<string, unknown>>;
    // Sort phases by id for comparison
    const sortedPhases = [...phases].sort((a, b) =>
      String(a.id || '').localeCompare(String(b.id || ''))
    );
    for (const phase of sortedPhases) {
      const steps = (phase.steps as Array<Record<string, unknown>>) || [];
      const sortedSteps = [...steps].sort((a, b) => {
        const rankA = Number(a.rank) || 0;
        const rankB = Number(b.rank) || 0;
        if (rankA !== rankB) return rankA - rankB;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
      const stepSigs = sortedSteps.map(s => `${s.id}:${s.rank}`);
      parts.push(`${phase.id}[${stepSigs.join(',')}]`);
    }
    return parts.join('|');
  }

  try {
    // First call
    const planData1 = await callPlanEndpoint();

    if (!planData1) {
      fail('Plan endpoint did not return JSON');
      return false;
    }

    // Check contract shape
    console.log('\n  Phase 2B Contract Validation:');
    const requiredKeys = ['ok', 'plan', 'debug'];
    for (const key of requiredKeys) {
      if (key in planData1) {
        pass(`Has key: ${key}`);
      } else {
        fail(`Missing key: ${key}`);
        allPass = false;
      }
    }

    if (planData1.ok === true) {
      pass('Plan endpoint returned ok=true');

      // Check plan structure
      const plan = planData1.plan as Record<string, unknown>;
      if (plan && typeof plan === 'object') {
        if (plan.id && typeof plan.id === 'string') {
          pass(`plan.id: ${String(plan.id).slice(0, 8)}...`);
        } else {
          fail('plan.id missing or invalid');
          allPass = false;
        }

        if (plan.created_at) {
          pass('plan.created_at present');
        } else {
          fail('plan.created_at missing');
          allPass = false;
        }

        if (Array.isArray(plan.phases)) {
          pass(`plan.phases: ${plan.phases.length} phases`);
        } else {
          fail('plan.phases not an array');
          allPass = false;
        }
      }

      // Check debug structure
      const debug = planData1.debug as Record<string, unknown>;
      if (debug && typeof debug === 'object') {
        // Check budgets
        const budgets = debug.budgets as Record<string, unknown>;
        if (budgets?.temperature === 0) {
          pass('Deterministic mode: temperature=0');
        } else {
          warn(`Temperature is ${budgets?.temperature}, expected 0`);
        }

        // Check timings
        const timings = debug.timings_ms as Record<string, number>;
        if (timings?.total) {
          pass(`Timings: total=${timings.total}ms, fetch=${timings.fetch_workflow || 0}ms, llm=${timings.llm || 0}ms`);
        }

        if (debug.workflow_uuid) {
          pass(`workflow_uuid: ${String(debug.workflow_uuid).slice(0, 8)}...`);
        }
      }
    } else {
      // ok=false is valid - may be LLM or DB issue
      warn(`Plan returned ok=false: ${planData1.error || 'unknown error'}`);
    }

    // Determinism check - call again and compare stable parts
    console.log('\n  Determinism Check:');
    const planData2 = await callPlanEndpoint();

    if (planData2 && planData1.ok === true && planData2.ok === true) {
      const plan1 = planData1.plan as Record<string, unknown>;
      const plan2 = planData2.plan as Record<string, unknown>;

      // Compare stable signature (phase ids, step ids, ranks)
      // Do NOT compare timestamps or timings
      const sig1 = extractStableSignature(plan1);
      const sig2 = extractStableSignature(plan2);

      if (sig1 === sig2) {
        pass('Plan ordering deterministic (phase/step ids and ranks match)');
      } else {
        warn('Plan ordering differs between calls (may be LLM variance)');
        info(`Sig1: ${sig1.slice(0, 100)}...`);
        info(`Sig2: ${sig2.slice(0, 100)}...`);
      }

      // Compare phase count
      const phases1 = Array.isArray(plan1?.phases) ? plan1.phases.length : 0;
      const phases2 = Array.isArray(plan2?.phases) ? plan2.phases.length : 0;
      if (phases1 === phases2) {
        pass(`Phase count stable: ${phases1}`);
      } else {
        warn(`Phase count changed: ${phases1} vs ${phases2}`);
      }
    } else if (planData1.ok !== true || planData2?.ok !== true) {
      warn('Could not complete determinism check (one or both calls returned ok=false)');
    } else {
      warn('Could not complete determinism check (second call failed)');
    }

    return allPass;
  } catch (e) {
    fail(`Assist Plan error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Test Assist Apply-Step endpoint (Phase 2B Step 2)
 * In integration mode: exercises plan→dry_run→apply→idempotency end-to-end.
 * Returns false if plan returns 0 steps (rather than hiding the failure).
 */
async function testAssistApplyStep(): Promise<boolean> {
  console.log(`\n--- Assist Apply-Step Mode (Phase 2B Step 2) ---`);
  console.log(`  POST ${ENDPOINTS.assistApplyStep}`);

  if (!CONNECTION_ID || !WORKFLOW_UUID) {
    warn('Skipping - DOCTOR_CONNECTION_ID or DOCTOR_WORKFLOW_UUID not set');
    return true;
  }

  let allPass = true;

  try {
    // Step 1: Ensure sandbox exists
    console.log('\n  Step 1: Ensuring sandbox exists...');
    const sandboxUrl = `${BASE_URL}/api/v3/workflows/${WORKFLOW_UUID}/sandbox/ensure?keepFailed=1`;
    const sandboxRes = await fetch(sandboxUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: CONNECTION_ID }),
    });
    const sandboxData = await sandboxRes.json() as { ok: boolean; test_workflow_id?: string };
    if (!sandboxData.ok) {
      fail('Sandbox ensure failed');
      return false;
    }
    pass('Sandbox ensured');

    // Step 2: Get a plan with an EXPLICIT actionable goal (guarantees at least 1 step)
    console.log('\n  Step 2: Getting plan with explicit goal...');
    const planUrl = `${BASE_URL}${ENDPOINTS.assistPlan}`;
    const planRes = await fetch(planUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        workflowUuid: WORKFLOW_UUID,
        analyzed_source: 'prod',
        userGoal: 'Add a Set node named "VN Marker" after the first trigger that sets a field vn_marker to the value "doctor_test". This is for automated testing only.',
      }),
    });
    const planData = await planRes.json() as {
      ok: boolean;
      plan?: { id: string; phases: { steps: { id: string }[] }[] };
      error?: string;
    };

    if (!planData.ok || !planData.plan?.id) {
      fail(`Plan generation failed: ${planData.error || 'no plan returned'}`);
      return false;
    }

    const planId = planData.plan.id;
    const firstStep = planData.plan.phases?.[0]?.steps?.[0];
    if (!firstStep) {
      fail('Apply-step integration not tested: plan returned 0 steps');
      return false;
    }

    const stepId = firstStep.id;
    const totalSteps = planData.plan.phases.reduce(
      (sum: number, p: { steps: { id: string }[] }) => sum + (p.steps?.length || 0), 0
    );
    pass(`Got plan ${planId.slice(0, 8)}... with ${totalSteps} step(s), using step ${stepId}`);

    // Step 3a: Call apply-step with dry_run=true
    console.log('\n  Step 3a: Calling apply-step (dry_run=true)...');
    const applyUrl = `${BASE_URL}${ENDPOINTS.assistApplyStep}`;
    const dryRes = await fetch(applyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        workflowUuid: WORKFLOW_UUID,
        planId,
        stepId,
        dry_run: true,
      }),
    });
    const dryData = await dryRes.json() as {
      ok: boolean;
      patch?: { operations: { op: string }[] };
      test_workflow_id?: string;
      debug?: {
        prod_workflow_id_DENIED?: string;
        dry_run?: boolean;
      };
      error?: string;
    };

    if (!dryData.ok) {
      fail(`dry_run=true failed: ${dryData.error || 'unknown'}`);
      allPass = false;
    } else {
      pass('dry_run=true returned ok');
    }

    if (dryData.debug?.dry_run === true) {
      pass('dry_run=true confirmed in debug');
    } else {
      warn('debug.dry_run not set to true');
    }

    if (dryData.patch?.operations && dryData.patch.operations.length > 0) {
      const validOps = ['update_node_params', 'add_node', 'add_edge', 'set_credential_ref'];
      const allValid = dryData.patch.operations.every((op: { op: string }) => validOps.includes(op.op));
      if (allValid) {
        pass(`dry_run patch: ${dryData.patch.operations.length} ops, all whitelisted`);
      } else {
        fail('dry_run patch contains non-whitelisted ops');
        allPass = false;
      }
    } else {
      warn('dry_run patch is empty or missing');
    }

    if (dryData.test_workflow_id) {
      pass(`dry_run test_workflow_id: ${dryData.test_workflow_id}`);
    } else {
      warn('dry_run test_workflow_id missing');
    }

    // Step 3b: Call apply-step with dry_run=false (actual apply)
    const idempotencyKey = `doctor-test-${planId}:${stepId}:${Date.now()}`;
    console.log(`\n  Step 3b: Calling apply-step (dry_run=false, key=${idempotencyKey.slice(0, 30)}...)...`);
    const applyRes = await fetch(applyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        workflowUuid: WORKFLOW_UUID,
        planId,
        stepId,
        dry_run: false,
        idempotency_key: idempotencyKey,
      }),
    });
    const applyData = await applyRes.json() as {
      ok: boolean;
      patch?: { operations: { op: string }[] };
      test_workflow_id?: string;
      diff_summary?: string;
      debug?: {
        prod_workflow_id_DENIED?: string;
        test_workflow_id?: string;
        dry_run?: boolean;
        apply_error?: { status: number; message: string; body?: string };
        idempotency_key?: string | null;
        idempotency_hit?: boolean;
        existing_application_id?: string;
        audit_error?: string;
      };
      error?: string;
    };

    console.log('\n  Apply-Step Contract Validation:');
    if (applyData.ok) {
      pass('apply-step returned ok=true');
    } else {
      if (applyData.debug?.apply_error) {
        fail(`apply-step failed with apply_error: ${applyData.debug.apply_error.status} ${applyData.debug.apply_error.message}`);
        if (applyData.debug.apply_error.body) {
          info(`apply_error body: ${applyData.debug.apply_error.body.slice(0, 200)}`);
        }
      } else {
        fail(`apply-step returned ok=false: ${applyData.error || 'unknown'}`);
      }
      allPass = false;
    }

    // Safety check: prod_workflow_id_DENIED must exist
    if (applyData.debug?.prod_workflow_id_DENIED) {
      pass(`Safety: prod_workflow_id_DENIED=${applyData.debug.prod_workflow_id_DENIED}`);
    } else {
      fail('Safety: debug.prod_workflow_id_DENIED missing');
      allPass = false;
    }

    // Safety check: test_workflow_id != prod
    if (applyData.test_workflow_id && applyData.debug?.prod_workflow_id_DENIED) {
      if (applyData.test_workflow_id !== applyData.debug.prod_workflow_id_DENIED) {
        pass('Safety: test_workflow_id != prod_workflow_id');
      } else {
        fail('SAFETY VIOLATION: test_workflow_id equals prod_workflow_id!');
        allPass = false;
      }
    }

    // Verify dry_run=false
    if (applyData.debug?.dry_run === false) {
      pass('dry_run=false confirmed (patch was applied)');
    } else {
      warn('debug.dry_run not set to false');
    }

    // Verify no apply_error on success
    if (applyData.ok && !applyData.debug?.apply_error) {
      pass('No apply_error (n8n update succeeded)');
    } else if (applyData.debug?.apply_error) {
      fail(`apply_error present: ${applyData.debug.apply_error.message}`);
      allPass = false;
    }

    // Check diff_summary
    if (applyData.diff_summary) {
      pass(`diff_summary: ${applyData.diff_summary.slice(0, 60)}...`);
    }

    // Verify idempotency_key was echoed back
    if (applyData.debug?.idempotency_key !== idempotencyKey) {
      fail(`Idempotency key mismatch after first call: sent="${idempotencyKey}", received="${applyData.debug?.idempotency_key}"`);
      allPass = false;
    } else {
      pass(`Idempotency key echoed correctly: ${idempotencyKey.slice(0, 30)}...`);
    }

    // Step 4: Idempotency test — same key, expect cache hit
    if (applyData.ok) {
      console.log('\n  Step 4: Testing Idempotency (same key, expect cache hit)...');
      const retryRes = await fetch(applyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: CONNECTION_ID,
          workflowUuid: WORKFLOW_UUID,
          planId,
          stepId,
          dry_run: false,
          idempotency_key: idempotencyKey,
        }),
      });
      const retryData = await retryRes.json() as typeof applyData;

      if (retryData.ok && retryData.debug?.idempotency_hit === true) {
        pass(`Idempotency hit confirmed (existing_application_id: ${retryData.debug.existing_application_id})`);

        if (retryData.test_workflow_id === applyData.test_workflow_id) {
          pass('Idempotent response matches original');
        } else {
          fail('Idempotent response differs from original');
          allPass = false;
        }

        // Step 4a: Verify enriched debug fields (Cursor-like explainability)
        console.log('\n  Step 4a: Verifying enriched idempotency debug fields...');

        // workflow_uuid, plan_id, step_id should be filled from request
        if (retryData.debug.workflow_uuid === WORKFLOW_UUID) {
          pass(`debug.workflow_uuid filled: ${retryData.debug.workflow_uuid.slice(0, 8)}...`);
        } else {
          fail(`debug.workflow_uuid missing or wrong: "${retryData.debug.workflow_uuid}"`);
          allPass = false;
        }
        if (retryData.debug.plan_id === planId) {
          pass(`debug.plan_id filled: ${retryData.debug.plan_id.slice(0, 8)}...`);
        } else {
          fail(`debug.plan_id missing or wrong: "${retryData.debug.plan_id}"`);
          allPass = false;
        }
        if (retryData.debug.step_id === stepId) {
          pass(`debug.step_id filled: ${retryData.debug.step_id}`);
        } else {
          fail(`debug.step_id missing or wrong: "${retryData.debug.step_id}"`);
          allPass = false;
        }

        // test_workflow_id should be present (from vn_test_workflows lookup)
        if (retryData.debug.test_workflow_id) {
          pass(`debug.test_workflow_id enriched: ${retryData.debug.test_workflow_id}`);
        } else {
          warn('debug.test_workflow_id empty (lookup may have failed)');
        }

        // prod_workflow_id_DENIED should be present (from workflowIdBridge)
        if (retryData.debug.prod_workflow_id_DENIED) {
          pass(`debug.prod_workflow_id_DENIED enriched: ${retryData.debug.prod_workflow_id_DENIED}`);
        } else {
          warn('debug.prod_workflow_id_DENIED empty (resolve may have failed)');
        }

        // timings_ms.total should be > 0
        const totalMs = (retryData.debug as any).timings_ms?.total;
        if (typeof totalMs === 'number' && totalMs > 0) {
          pass(`debug.timings_ms.total > 0: ${totalMs}ms`);
        } else {
          warn(`debug.timings_ms.total not populated: ${totalMs}`);
        }

      } else {
        fail(`Idempotency check failed:
    - ok: ${retryData.ok}
    - idempotency_hit: ${retryData.debug?.idempotency_hit}
    - key_sent: ${idempotencyKey}
    - key_received: ${retryData.debug?.idempotency_key}
    - audit_error: ${retryData.debug?.audit_error || 'none'}`);
        console.error('[DEBUG] Full retry response:', JSON.stringify(retryData, null, 2));
        allPass = false;
      }

      // Step 4b: Verify via idempotency endpoint (requires VN_ADMIN_TOKEN)
      const adminToken = process.env.VN_ADMIN_TOKEN;
      if (adminToken) {
        console.log('\n  Step 4b: Verifying idempotency via DB endpoint...');
        try {
          const idemUrl = `${BASE_URL}/api/v3/assist/apply-step/idempotency/${encodeURIComponent(idempotencyKey)}`;
          const idemRes = await fetch(idemUrl, {
            headers: { 'X-VN-Admin-Token': adminToken },
          });
          const idemData = await idemRes.json() as {
            ok: boolean;
            count?: number;
            latest?: { id: string; status: string; created_at: string; workflow_uuid: string; plan_id: string; step_id: string };
            error?: string;
          };

          if (idemData.ok && idemData.count === 1) {
            pass(`Idempotency DB verified: count=${idemData.count}, status=${idemData.latest?.status}`);
            if (idemData.latest?.status === 'applied') {
              pass('DB status matches: applied');
            } else {
              fail(`DB status mismatch: expected "applied", got "${idemData.latest?.status}"`);
              allPass = false;
            }
          } else if (idemData.ok && (idemData.count ?? 0) > 1) {
            warn(`Idempotency DB has ${idemData.count} rows (expected 1), latest: ${idemData.latest?.status}`);
          } else {
            fail(`Idempotency DB check failed: ${idemData.error || `count=${idemData.count}`}`);
            allPass = false;
          }
        } catch (idemErr) {
          warn(`Idempotency endpoint error: ${idemErr instanceof Error ? idemErr.message : idemErr}`);
        }
      } else {
        info('[SKIP] Step 4b: VN_ADMIN_TOKEN not set, skipping idempotency DB verification');
      }
    } else {
      warn('Skipping idempotency test — apply-step did not succeed');
    }

    return allPass;
  } catch (e) {
    fail(`Assist Apply-Step error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log('\n========================================');
  console.log('  Vibe Noding Core - Doctor');
  console.log(`  Mode: ${INTEGRATION ? 'unit + integration' : 'unit only'}`);
  console.log('========================================');

  let exitCode = 0;

  // ── Unit checks (always run) ──────────────────────────────
  let healthOk = await checkHealth();

  if (!healthOk) {
    console.log('\nBackend not reachable. Attempting to start API via "npm run start:doctor"...');
    const started = await startApiServer();
    if (!started) {
      console.log('\nFailed to start API server. Please check logs above.');
      process.exit(1);
    }
    // Re-check health (or just assume true since startApiServer waits for it)
    healthOk = true;
  }

  printEndpoints();

  const corsOk = await checkCORS();

  // ── Integration checks (require --integration flag) ──────
  type CheckResult = { name: string; ok: boolean; skipped?: boolean };
  const integrationChecks: CheckResult[] = [];

  if (!INTEGRATION) {
    console.log('\n--- Integration Tests ---');
    skip('Integration tests disabled. Run with --integration flag or DOCTOR_INTEGRATION=1');
    skip('Example: DOCTOR_INTEGRATION=1 DOCTOR_WORKFLOW_UUID=xxx DOCTOR_CONNECTION_ID=yyy npm run doctor');

    integrationChecks.push(
      { name: 'Workflow resolution', ok: true, skipped: true },
      { name: 'Sandbox engine', ok: true, skipped: true },
      { name: 'Assist Ask mode', ok: true, skipped: true },
      { name: 'Assist Plan mode', ok: true, skipped: true },
      { name: 'Assist Apply-Step mode', ok: true, skipped: true },
    );
  } else if (!WORKFLOW_UUID || !CONNECTION_ID) {
    console.log('\n--- Integration Tests ---');
    fail('--integration enabled but DOCTOR_WORKFLOW_UUID or DOCTOR_CONNECTION_ID not set');
    exitCode = 1;

    integrationChecks.push(
      { name: 'Workflow resolution', ok: false },
      { name: 'Sandbox engine', ok: false },
      { name: 'Assist Ask mode', ok: false },
      { name: 'Assist Plan mode', ok: false },
      { name: 'Assist Apply-Step mode', ok: false },
    );
  } else {
    // Run integration tests, wrapped in try/catch for transport-level crashes
    try {
      const resolveOk = await testWorkflowResolution();
      integrationChecks.push({ name: 'Workflow resolution', ok: resolveOk });

      const sandboxOk = await testSandboxEndpoints();
      integrationChecks.push({ name: 'Sandbox engine', ok: sandboxOk });

      const assistOk = await testAssistAsk();
      integrationChecks.push({ name: 'Assist Ask mode', ok: assistOk });

      const planOk = await testAssistPlan();
      integrationChecks.push({ name: 'Assist Plan mode', ok: planOk });

      const applyStepOk = await testAssistApplyStep();
      integrationChecks.push({ name: 'Assist Apply-Step mode', ok: applyStepOk });
    } catch (integrationErr) {
      const errMsg = integrationErr instanceof Error ? integrationErr.message : String(integrationErr);
      console.error(`\n${RED}[CRASH]${RESET} Integration tests hit a transport-level error: ${errMsg}`);
      console.error('This usually means the external n8n instance is unreachable.');
      exitCode = 1;

      // Fill in any remaining checks as failed
      const ran = new Set(integrationChecks.map(c => c.name));
      for (const name of ['Workflow resolution', 'Sandbox engine', 'Assist Ask mode', 'Assist Plan mode', 'Assist Apply-Step mode']) {
        if (!ran.has(name)) integrationChecks.push({ name, ok: false });
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n--- Summary --- ${INTEGRATION ? '(unit + integration)' : '(unit only)'}`);

  const allChecks: CheckResult[] = [
    { name: 'Health endpoint', ok: healthOk },
    { name: 'CORS config', ok: corsOk },
    ...integrationChecks,
  ];

  for (const check of allChecks) {
    if (check.skipped) {
      skip(check.name);
    } else if (check.ok) {
      pass(check.name);
    } else {
      fail(check.name);
      exitCode = 1;
    }
  }

  console.log(exitCode === 0
    ? `\n${GREEN}All checks passed!${RESET}\n`
    : `\n${RED}Some checks failed.${RESET}\n`);

  // Ensure server process is killed on exit
  if (serverProcess) {
    console.log('\nStopping API server...');
    try {
      if (process.platform === 'win32' && serverProcess.pid) {
        execSync(`taskkill /pid ${serverProcess.pid} /f /t`, { stdio: 'ignore' });
      } else {
        serverProcess.kill();
      }
    } catch (e) {
      // Ignore errors if process is already dead
    }
  }
  process.exit(exitCode);
}

// Catch unhandled rejections from libuv / network layer
process.on('unhandledRejection', (reason) => {
  console.error(`\n${RED}[CRASH]${RESET} Unhandled rejection:`, reason);
  console.error('This is typically a network/transport error. Check that your n8n instance is reachable.');
  process.exit(1);
});

main().catch(e => {
  console.error(`\n${RED}[CRASH]${RESET} Doctor script failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
