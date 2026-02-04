/**
 * Vibe Noding Core - Health Check Doctor Script
 * 
 * Usage: npm run doctor
 * 
 * Checks:
 * 1) GET /api/v3/node-library/health returns 200 + { ok: true }
 * 2) Prints discovered endpoints
 * 3) If DOCTOR_WORKFLOW_UUID + DOCTOR_CONNECTION_ID set, tests workflow resolution
 */

import 'dotenv/config';

const BASE_URL = process.env.DOCTOR_BASE_URL || 'http://127.0.0.1:3000';
const WORKFLOW_UUID = process.env.DOCTOR_WORKFLOW_UUID;
const CONNECTION_ID = process.env.DOCTOR_CONNECTION_ID;

// Colors for terminal output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function pass(msg: string): void { console.log(`${GREEN}[PASS]${RESET} ${msg}`); }
function fail(msg: string): void { console.log(`${RED}[FAIL]${RESET} ${msg}`); }
function warn(msg: string): void { console.log(`${YELLOW}[WARN]${RESET} ${msg}`); }
function info(msg: string): void { console.log(`${BLUE}[INFO]${RESET} ${msg}`); }

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
  fixtures: '/api/v3/workflows/:workflowUuid/fixtures',
  sandboxRun: '/api/v3/workflows/:workflowUuid/sandbox/run',
  // Assist endpoints
  assistAsk: '/api/v3/assist/ask',
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
  
  return allPass;
}

async function testAssistAsk(): Promise<boolean> {
  console.log(`\n--- Assist Ask Mode ---`);
  
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
  
  try {
    const askUrl = `${BASE_URL}/api/v3/assist/ask`;
    info(`Testing: POST ${askUrl}`);
    
    const askRes = await fetch(askUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        workflowUuid: WORKFLOW_UUID,
        sessionId: 'doctor-test-001',
        message: 'What does this workflow do?',
      }),
    });
    
    // JSON correctness test
    const responseText = await askRes.text();
    let askData: Record<string, unknown>;
    
    try {
      askData = JSON.parse(responseText) as Record<string, unknown>;
      pass('JSON correctness: OK');
    } catch (jsonError) {
      fail('JSON correctness: INVALID');
      console.log(`   Parse error: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
      console.log(`   Response preview: ${responseText.slice(0, 500)}...`);
      return false;
    }
    
    if (askRes.status === 200 && askData.ok === true) {
      pass('Assist Ask endpoint works');
      info(`Answer preview: ${String(askData.answer).slice(0, 100)}...`);
      
      // Check structured response fields
      if (askData.topFixFirst) {
        info(`Top fix: ${String(askData.topFixFirst).slice(0, 80)}...`);
      }
      
      if (Array.isArray(askData.issues) && askData.issues.length > 0) {
        info(`Issues found: ${askData.issues.length}`);
      }
      
      if (Array.isArray(askData.citations) && askData.citations.length > 0) {
        info(`Citations: ${askData.citations.join(', ')}`);
      } else if (Array.isArray(askData.issues) && askData.issues.length > 0) {
        warn('Issues exist but citations is empty');
      }
      
      if (askData.debug) {
        const debug = askData.debug as Record<string, unknown>;
        
        // Workflow analysis metadata
        if (debug.analyzed_n8n_workflow_id) {
          info(`Analyzed workflow: ${debug.analyzed_n8n_workflow_id} (source: ${debug.analyzed_source})`);
        }
        
        if (debug.workflow_updated_at_from_n8n) {
          info(`Workflow updated at: ${debug.workflow_updated_at_from_n8n}`);
        }
        
        if (debug.workflow_synced) {
          info(`Workflow synced: ${debug.workflow_synced} (unchanged: ${debug.workflow_unchanged})`);
        }
        
        // Execution selection & health
        if (debug.executionSelection) {
          const selection = debug.executionSelection as Record<string, unknown>;
          console.log(`\n  ${BLUE}Execution Selection:${RESET}`);
          info(`  Workflow health: ${selection.workflowIsHealthy ? `${GREEN}HEALTHY ✓${RESET}` : `${RED}HAS ERRORS${RESET}`}`);
          info(`  Picked execution: #${selection.pickedExecutionId} (${selection.pickedExecutionStatus})`);
          info(`  Latest (any): #${selection.latestAnyId} (${selection.latestAnyStatus}) @ ${selection.latestAnyFinishedAt}`);
          info(`  Latest success: ${selection.latestSuccessId ? `#${selection.latestSuccessId} @ ${selection.latestSuccessFinishedAt}` : 'none'}`);
          info(`  Latest error: ${selection.latestErrorId ? `#${selection.latestErrorId} @ ${selection.latestErrorFinishedAt}` : 'none'}`);
          
          if (selection.latestErrorId && selection.latestSuccessId) {
            const successTime = new Date(selection.latestSuccessFinishedAt as string).getTime();
            const errorTime = new Date(selection.latestErrorFinishedAt as string).getTime();
            const comparison = errorTime > successTime ? `${RED}error is newer${RESET}` : `${GREEN}success is newer${RESET}`;
            info(`  Comparison: ${comparison}`);
          }
        }
        
        // Context summary
        if (debug.contextPackSummary) {
          const summary = debug.contextPackSummary as Record<string, unknown>;
          console.log(`\n  ${BLUE}Context Summary:${RESET}`);
          info(`  Nodes: ${summary.nodeCount} (${summary.uniqueTypes} unique types)`);
          info(`  Missing credentials: ${summary.missingCredentials}`);
          info(`  Evaluation issues: ${summary.evaluationIssues}`);
          info(`  Latest execution error: ${summary.latestExecutionError}`);
          
          // Verify uniqueTypes is not zero when nodeCount > 0
          if (Number(summary.nodeCount) > 0 && Number(summary.uniqueTypes) === 0) {
            fail('  uniqueTypes is 0 but nodeCount > 0 (BUG)');
          } else if (Number(summary.uniqueTypes) > 0) {
            pass(`  uniqueTypes computed correctly: ${summary.uniqueTypes}`);
          }
        }
        
        // Execution error debug
        if (debug.executionErrorDebug) {
          const execDebug = debug.executionErrorDebug as Record<string, unknown>;
          if (execDebug.failedNode !== 'N/A') {
            info(`Execution error: node="${execDebug.failedNode}", execution="${execDebug.executionId}"`);
          }
        }
        
        // Validation
        if (debug.validation) {
          const validation = debug.validation as Record<string, unknown>;
          if (Array.isArray(validation.errors) && validation.errors.length > 0) {
            warn(`Validation errors: ${validation.errors.length}`);
          }
        }
        
        // LLM metadata
        if (debug.usedDeterministicFallback) {
          info('Used deterministic fallback (no hallucinations possible)');
        }
      }
      
      return true;
    } else {
      fail(`Assist Ask failed: ${askRes.status}`);
      console.log(`   Error: ${String(askData.error || 'unknown')}`);
      if (askData.details) {
        console.log(`   Details: ${String(askData.details).slice(0, 200)}`);
      }
      if (askData.llm_error) {
        console.log(`   LLM error: ${String(askData.llm_error).slice(0, 200)}`);
      }
      return false;
    }
  } catch (e) {
    fail(`Assist Ask error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log('\n========================================');
  console.log('  Vibe Noding Core - Doctor');
  console.log('========================================');
  
  let exitCode = 0;
  
  // Health check first - if this fails, stop
  const healthOk = await checkHealth();
  if (!healthOk) {
    console.log('\nBackend not reachable. Start it with: npm run dev\n');
    process.exit(1);
  }
  
  printEndpoints();
  
  const corsOk = await checkCORS();
  const resolveOk = await testWorkflowResolution();
  const sandboxOk = await testSandboxEndpoints();
  const assistOk = await testAssistAsk();
  
  // Summary
  console.log(`\n--- Summary ---`);
  
  const checks = [
    { name: 'Health endpoint', ok: healthOk },
    { name: 'CORS config', ok: corsOk },
    { name: 'Workflow resolution', ok: resolveOk },
    { name: 'Sandbox engine', ok: sandboxOk },
    { name: 'Assist Ask mode', ok: assistOk },
  ];
  
  for (const check of checks) {
    if (check.ok) {
      pass(check.name);
    } else {
      fail(check.name);
      exitCode = 1;
    }
  }
  
  console.log(exitCode === 0 
    ? `\n${GREEN}All checks passed!${RESET}\n` 
    : `\n${RED}Some checks failed.${RESET}\n`);
  
  process.exit(exitCode);
}

main().catch(e => {
  console.error('Doctor script failed:', e);
  process.exit(1);
});
