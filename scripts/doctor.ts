/**
 * Vibe Noding Core - Health Check Doctor Script
 * 
 * Usage: npm run doctor
 * 
 * Checks:
 * 1) GET /api/v3/node-library/health returns 200
 * 2) Prints discovered endpoints for sync/evaluate/SSE/poll
 * 3) Validates Cache-Control headers on dynamic endpoints
 * 4) Validates CORS allows localhost:8080 and Authorization header
 * 5) If DOCTOR_WORKFLOW_UUID is set, tests workflow ID resolution
 */

import 'dotenv/config';

const BASE_URL = process.env.DOCTOR_BASE_URL || 'http://localhost:3000';
const WORKFLOW_UUID = process.env.DOCTOR_WORKFLOW_UUID;
const CONNECTION_ID = process.env.DOCTOR_CONNECTION_ID;

// Colors for terminal output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function pass(msg: string) { console.log(`${GREEN}✅ PASS${RESET} ${msg}`); }
function fail(msg: string) { console.log(`${RED}❌ FAIL${RESET} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}⚠️  WARN${RESET} ${msg}`); }
function info(msg: string) { console.log(`${BLUE}ℹ️  INFO${RESET} ${msg}`); }
function header(msg: string) { console.log(`\n${BLUE}━━━ ${msg} ━━━${RESET}`); }

// Discovered endpoints from code analysis
const ENDPOINTS = {
  health: '/api/v3/node-library/health',
  sync: '/api/n8n/sync',
  evaluate: '/api/v3/workflows/evaluate',
  sse: '/api/stream/workflow-state',
  poll: '/api/v3/workflows/:workflowId/poll',
  resolve: '/api/v3/workflows/resolve',
};

async function checkHealth(): Promise<boolean> {
  header('Health Check');
  
  try {
    const res = await fetch(`${BASE_URL}${ENDPOINTS.health}`);
    const data = await res.json();
    
    if (res.status === 200 && data.ok === true) {
      pass(`${ENDPOINTS.health} → 200 OK`);
      info(`Service: ${data.service}, ts: ${data.ts}`);
      return true;
    } else {
      fail(`${ENDPOINTS.health} → ${res.status}`);
      return false;
    }
  } catch (e) {
    fail(`Cannot reach ${BASE_URL}${ENDPOINTS.health}`);
    console.log(`   Error: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

function printEndpoints() {
  header('Discovered Endpoints');
  
  console.log(`\n  Base URL: ${BASE_URL}\n`);
  console.log('  Endpoint                                | Method | Path');
  console.log('  ----------------------------------------|--------|----------------------------------');
  console.log(`  Health                                  | GET    | ${ENDPOINTS.health}`);
  console.log(`  Sync                                    | POST   | ${ENDPOINTS.sync}`);
  console.log(`  Evaluate                                | GET    | ${ENDPOINTS.evaluate}`);
  console.log(`  SSE Stream                              | GET    | ${ENDPOINTS.sse}`);
  console.log(`  Poll                                    | POST   | ${ENDPOINTS.poll}`);
  console.log(`  Resolve (dev)                           | GET    | ${ENDPOINTS.resolve}`);
}

async function checkCacheHeaders(): Promise<boolean> {
  header('Cache-Control Headers');
  
  let allPass = true;
  
  // Check evaluate endpoint headers
  if (WORKFLOW_UUID && CONNECTION_ID) {
    try {
      const url = `${BASE_URL}${ENDPOINTS.evaluate}?connectionId=${CONNECTION_ID}&workflowId=${WORKFLOW_UUID}`;
      const res = await fetch(url);
      const cacheControl = res.headers.get('cache-control') || '';
      
      if (cacheControl.includes('no-store')) {
        pass(`Evaluate: Cache-Control includes no-store`);
      } else {
        warn(`Evaluate: Cache-Control is "${cacheControl}" (expected no-store)`);
        allPass = false;
      }
    } catch (e) {
      warn(`Could not check evaluate headers: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    info('Set DOCTOR_WORKFLOW_UUID and DOCTOR_CONNECTION_ID to test evaluate/poll headers');
  }
  
  // Check global etag setting via health endpoint
  try {
    const res = await fetch(`${BASE_URL}${ENDPOINTS.health}`);
    const etag = res.headers.get('etag');
    
    if (!etag) {
      pass('ETag: Disabled globally (no etag header)');
    } else {
      warn(`ETag: Found "${etag}" - may cause 304 responses`);
      allPass = false;
    }
  } catch (e) {
    warn(`Could not check etag: ${e instanceof Error ? e.message : e}`);
  }
  
  return allPass;
}

async function checkCORS(): Promise<boolean> {
  header('CORS Configuration');
  
  let allPass = true;
  
  try {
    // Send OPTIONS preflight request
    const res = await fetch(`${BASE_URL}${ENDPOINTS.health}`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:8080',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    
    const allowOrigin = res.headers.get('access-control-allow-origin');
    const allowHeaders = res.headers.get('access-control-allow-headers') || '';
    const allowMethods = res.headers.get('access-control-allow-methods') || '';
    
    // Check origin
    if (allowOrigin === 'http://localhost:8080' || allowOrigin === '*') {
      pass(`Origin: localhost:8080 allowed (${allowOrigin})`);
    } else {
      fail(`Origin: localhost:8080 not allowed (got: ${allowOrigin})`);
      allPass = false;
    }
    
    // Check Authorization header
    if (allowHeaders.toLowerCase().includes('authorization')) {
      pass('Headers: Authorization allowed');
    } else {
      fail(`Headers: Authorization not in allowed headers (${allowHeaders})`);
      allPass = false;
    }
    
    // Check methods
    if (allowMethods.includes('GET') && allowMethods.includes('POST')) {
      pass(`Methods: GET, POST allowed`);
    } else {
      warn(`Methods: ${allowMethods}`);
    }
    
  } catch (e) {
    fail(`CORS check failed: ${e instanceof Error ? e.message : e}`);
    allPass = false;
  }
  
  return allPass;
}

async function testWorkflowResolution(): Promise<boolean> {
  header('Workflow ID Resolution');
  
  if (!WORKFLOW_UUID || !CONNECTION_ID) {
    info('Skipped: Set DOCTOR_WORKFLOW_UUID and DOCTOR_CONNECTION_ID to test');
    return true;
  }
  
  try {
    // Test the resolve endpoint
    const url = `${BASE_URL}${ENDPOINTS.resolve}?connectionId=${CONNECTION_ID}&workflowId=${WORKFLOW_UUID}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (res.status === 200 && data.ok === true) {
      pass(`Resolved UUID → n8n ID: ${data.n8nWorkflowId}`);
      info(`Source table: ${data.sourceTable}`);
      return true;
    } else if (res.status === 403) {
      warn('Resolve endpoint is production-protected (expected in prod)');
      return true;
    } else {
      fail(`Resolution failed: ${data.error || res.status}`);
      return false;
    }
  } catch (e) {
    fail(`Resolution test failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       🩺 Vibe Noding Core - Health Check Doctor            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  let exitCode = 0;
  
  // Run checks
  const healthOk = await checkHealth();
  if (!healthOk) {
    console.log('\n❌ Backend not reachable. Start it with: npm run dev\n');
    process.exit(1);
  }
  
  printEndpoints();
  
  const cacheOk = await checkCacheHeaders();
  const corsOk = await checkCORS();
  const resolveOk = await testWorkflowResolution();
  
  // Summary
  header('Summary');
  
  const checks = [
    { name: 'Health endpoint', ok: healthOk },
    { name: 'Cache-Control', ok: cacheOk },
    { name: 'CORS config', ok: corsOk },
    { name: 'Workflow resolution', ok: resolveOk },
  ];
  
  for (const check of checks) {
    if (check.ok) {
      pass(check.name);
    } else {
      fail(check.name);
      exitCode = 1;
    }
  }
  
  console.log('\n' + (exitCode === 0 
    ? `${GREEN}All checks passed!${RESET}` 
    : `${RED}Some checks failed. Review above.${RESET}`));
  
  console.log('\n');
  process.exit(exitCode);
}

main().catch(e => {
  console.error('Doctor script failed:', e);
  process.exit(1);
});
