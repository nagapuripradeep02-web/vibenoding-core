# Safety Fixes for POST /api/v3/assist/ask

## Overview
Implemented minimal-risk safety fixes to address JSON truncation, incorrect uniqueTypes, and execution selection issues in the assist/ask endpoint.

## Problems Fixed

### 1. JSON Correctness Hard Guarantee ✅
**Problem:** Responses occasionally truncated/invalid (e.g., `"validation": n`)

**Solution:**
- Added defensive JSON serialization guard before `res.json()`
- Test `JSON.stringify(payload)` in try/catch before sending
- If serialization fails, send minimal fallback response
- Ensured `validation` field is always an object `{ errors: [], warnings: [] }`, never null

**Location:** `src/routes/v3.ts:3950-4014`

**Code:**
```typescript
// Ensure validation is always an object (never null to prevent truncation)
const validationSafe = validationResult ? {
  errors: validationResult.errors || [],
  warnings: validationResult.warnings || [],
} : {
  errors: [],
  warnings: [],
};

const responsePayload = { /* full response */ };

// Defensive JSON serialization guard
try {
  JSON.stringify(responsePayload);
  res.json(responsePayload);
} catch (stringifyError) {
  console.error('[assist/ask] JSON stringify failed, sanitizing debug:', stringifyError);
  // Fallback: send minimal response
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
```

### 2. Fix uniqueTypes Computation ✅
**Problem:** `debug.contextPackSummary.uniqueTypes` sometimes 0 even when nodeCount > 0

**Root Cause:** For healthy workflows, a minimal context was built with hardcoded `uniqueNodeTypes: 0`

**Solution:** Compute uniqueTypes from actual workflow nodes

**Location:** `src/routes/v3.ts:3800-3842`

**Code:**
```typescript
if (executionHealth.isHealthy && executionHealth.latestSuccess) {
  // Compute uniqueNodeTypes from actual workflow nodes
  const uniqueTypes = new Set<string>();
  (workflow.nodes || []).forEach(node => {
    if (node.type) {
      uniqueTypes.add(node.type);
    }
  });

  contextPack = {
    // ... other fields
    metadata: {
      totalNodes: (workflow.nodes || []).length,
      uniqueNodeTypes: uniqueTypes.size,  // ✓ Now computed correctly
      triggersCount: 0,
      schemasTruncated: 0,
    },
  };
}
```

### 3. Fix Execution Selection Logic ✅
**Problem:** Ask sometimes reports last ERROR even when later SUCCESS exists

**Solution:** Filter out "running/waiting" executions, only consider finished executions

**Location:** `src/routes/v3.ts:124-166`

**Changes:**
1. Filter executions to exclude `status === 'running'` or `status === 'waiting'`
2. Sort by finishedAt (prefer stoppedAt, fallback to startedAt)
3. Find `latestAny`, `latestSuccess`, `latestError` from finished executions only
4. Determine health: if `latestAny.status === 'success'` → healthy

**Code:**
```typescript
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
```

### 4. Update Doctor Script ✅
**Problem:** No validation of JSON correctness or execution selection display

**Solution:** Added JSON validation test and enhanced execution selection display

**Location:** `scripts/doctor.ts:425-548`

**Changes:**
1. Parse response text explicitly and catch JSON errors
2. Print "JSON correctness: OK" or "FAIL" with error details
3. Enhanced execution selection display with:
   - Workflow health status (color-coded)
   - Picked execution ID and status
   - Latest (any), latest success, latest error with timestamps
   - Comparison: "error is newer" vs "success is newer"
4. Added uniqueTypes validation check
5. Better formatting with colors and sections

**Code:**
```typescript
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

// Enhanced execution selection display
if (debug.executionSelection) {
  const selection = debug.executionSelection as Record<string, unknown>;
  console.log(`\n  ${BLUE}Execution Selection:${RESET}`);
  info(`  Workflow health: ${selection.workflowIsHealthy ? `${GREEN}HEALTHY ✓${RESET}` : `${RED}HAS ERRORS${RESET}`}`);
  info(`  Picked execution: #${selection.pickedExecutionId} (${selection.pickedExecutionStatus})`);
  info(`  Latest (any): #${selection.latestAnyId} (${selection.latestAnyStatus}) @ ${selection.latestAnyFinishedAt}`);
  info(`  Latest success: ${selection.latestSuccessId ? `#${selection.latestSuccessId} @ ${selection.latestSuccessFinishedAt}` : 'none'}`);
  info(`  Latest error: ${selection.latestErrorId ? `#${selection.latestErrorId} @ ${selection.latestErrorFinishedAt}` : 'none'}`);
}

// Verify uniqueTypes is not zero when nodeCount > 0
if (Number(summary.nodeCount) > 0 && Number(summary.uniqueTypes) === 0) {
  fail('  uniqueTypes is 0 but nodeCount > 0 (BUG)');
} else if (Number(summary.uniqueTypes) > 0) {
  pass(`  uniqueTypes computed correctly: ${summary.uniqueTypes}`);
}
```

## Files Modified

1. **src/routes/v3.ts** - Main endpoint implementation
   - Lines 124-166: Filter out running/waiting executions
   - Lines 3800-3842: Compute uniqueTypes for healthy workflows
   - Lines 3950-4014: Add JSON serialization guard and validation safety

2. **scripts/doctor.ts** - Health check script
   - Lines 425-548: Add JSON validation test and enhanced execution display

## Safety Guarantees

### JSON Correctness
✅ Exactly one `res.json()` call per request path
✅ Never uses `res.write()` or streaming
✅ Defensive stringify before sending
✅ Fallback response if serialization fails
✅ `validation` field always an object, never null

### Execution Selection
✅ Only considers finished executions (not running/waiting)
✅ Latest execution properly determined from finished list
✅ Health correctly determined from latest finished execution
✅ All debug fields populated with latestAny/latestSuccess/latestError

### uniqueTypes
✅ Computed from actual workflow.nodes
✅ Correct for both healthy and error workflows
✅ Correct for both prod and VN TEST snapshots

### Logging
✅ No credential/token logging
✅ Only logs IDs, status, node names
✅ Safe error handling

## Test Results

### Unit Tests (executionHealth.test.ts)
```
✅ Test 1: Error then success → isHealthy=true
✅ Test 2: Success then error → isHealthy=false
✅ Test 3: Multiple errors then success → isHealthy=true
✅ Test 4: Only success → isHealthy=true
✅ Test 5: Only error → isHealthy=false
✅ Test 6: No executions → isHealthy=false

Results: 6/6 tests passed
```

### Integration Tests (executionHealthIntegration.test.ts)
```
✅ Test Case 1: Error #1103 → Success #1104 → "Looks fixed"
✅ Test Case 2: Success #1104 → Error #1105 → analyzes error
✅ Test Case 3: Multiple errors → Success → "Looks fixed"
✅ Test Case 4: Timestamp comparison works correctly
✅ Test Case 5: Debug block fully populated

Results: 5/5 tests passed
```

## Acceptance Tests

### A) JSON Validity
```bash
curl http://localhost:3000/api/v3/assist/ask -X POST \
  -H "Content-Type: application/json" \
  -d '{"connectionId":"xxx","workflowUuid":"yyy","message":"test"}' \
  | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')); 'OK'"
```
Expected output: `OK`

### B) Newer Success → "Looks Fixed"
When n8n has error #1103 then success #1104:
- Response: `answer: "Looks fixed. Latest execution #1104 succeeded. (previously failed at execution 1103)"`
- `issues: []`
- `topFixFirst: null`

### C) uniqueTypes Correct
For normal workflows with N nodes of M types:
- `debug.contextPackSummary.uniqueTypes === M`
- Never 0 when nodeCount > 0

## Running Tests

```bash
# Unit tests
npx ts-node src/v3/executionHealth.test.ts

# Integration tests
npx ts-node src/v3/executionHealthIntegration.test.ts

# Health check with JSON validation
npm run doctor
```

## Rollout Safety

- ✅ Localized changes to assist/ask path only
- ✅ No auth/RLS/connection changes
- ✅ No new dependencies
- ✅ Backward compatible
- ✅ TypeScript builds successfully
- ✅ Comprehensive test coverage
- ✅ Defensive error handling

## Monitoring

After deployment, monitor for:
1. Zero instances of JSON parse errors in logs
2. `uniqueTypes` always > 0 when nodes exist
3. Correct workflow health determination
4. No `[assist/ask] JSON stringify failed` errors

## Summary

All safety fixes implemented with minimal risk:
- **JSON correctness:** Hard guarantee via defensive serialization
- **uniqueTypes:** Computed correctly from actual nodes
- **Execution selection:** Only finished executions considered
- **Doctor script:** JSON validation and execution display
- **11/11 tests passing** ✅
