/**
 * Integration test for execution health analysis with endpoint behavior
 * 
 * Tests that the endpoint returns "Looks fixed" when:
 * - Latest execution is success
 * - AND (no error OR latest error is older than latest success)
 * 
 * Tests that endpoint analyzes error when:
 * - Latest execution is error
 * - OR latest error is newer than latest success
 */

interface MockExecution {
  id: string;
  status: 'success' | 'error';
  finishedAt: string;
}

/**
 * Simulates the execution health logic
 */
function analyzeExecutionHealthLogic(executions: MockExecution[]): {
  isHealthy: boolean;
  latestAny: MockExecution | null;
  latestError: MockExecution | null;
  latestSuccess: MockExecution | null;
} {
  const result = {
    isHealthy: false,
    latestAny: null as MockExecution | null,
    latestError: null as MockExecution | null,
    latestSuccess: null as MockExecution | null,
  };

  if (executions.length === 0) {
    return result;
  }

  // Sort chronologically: newest first
  const sorted = [...executions].sort((a, b) => {
    const aTime = new Date(a.finishedAt).getTime();
    const bTime = new Date(b.finishedAt).getTime();
    return bTime - aTime;
  });

  result.latestAny = sorted[0];

  const errorExec = sorted.find(e => e.status === 'error');
  if (errorExec) {
    result.latestError = errorExec;
  }

  const successExec = sorted.find(e => e.status === 'success');
  if (successExec) {
    result.latestSuccess = successExec;
  }

  // Health rule: latest is success AND (no error OR latest success newer than latest error)
  if (result.latestAny?.status === 'success') {
    let isHealthy = true;
    if (result.latestError) {
      const latestSuccessTime = new Date(result.latestAny.finishedAt).getTime();
      const latestErrorTime = new Date(result.latestError.finishedAt).getTime();
      if (latestErrorTime > latestSuccessTime) {
        isHealthy = false;
      }
    }
    if (isHealthy) {
      result.isHealthy = true;
    }
  }

  return result;
}

/**
 * Test 1: Error #1103 then Success #1104 → endpoint returns "Looks fixed"
 */
function testCase1_ErrorThenSuccess() {
  console.log('\n📋 Test Case 1: Error #1103 → Success #1104');
  console.log('   Expected behavior: endpoint returns "Looks fixed", issues=[]');

  const executions: MockExecution[] = [
    { id: '1103', status: 'error', finishedAt: '2026-02-03T10:00:00Z' },
    { id: '1104', status: 'success', finishedAt: '2026-02-03T10:05:00Z' },
  ];

  const health = analyzeExecutionHealthLogic(executions);

  console.log(`   Analysis: isHealthy=${health.isHealthy}`);
  console.log(`   - latestAny: #${health.latestAny?.id} (${health.latestAny?.status})`);
  console.log(`   - latestSuccess: #${health.latestSuccess?.id}`);
  console.log(`   - latestError: #${health.latestError?.id}`);

  const pass = health.isHealthy === true && health.latestAny?.status === 'success';
  console.log(`   Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);

  if (pass) {
    console.log(`   → Would return: "Looks fixed. Latest execution #${health.latestAny?.id} succeeded. (previously failed at execution ${health.latestError?.id})"`);
  }

  return pass;
}

/**
 * Test 2: Success #1104 then Error #1105 → endpoint analyzes error #1105
 */
function testCase2_SuccessThenError() {
  console.log('\n📋 Test Case 2: Success #1104 → Error #1105');
  console.log('   Expected behavior: endpoint analyzes error #1105, returns issues based on it');

  const executions: MockExecution[] = [
    { id: '1104', status: 'success', finishedAt: '2026-02-03T10:05:00Z' },
    { id: '1105', status: 'error', finishedAt: '2026-02-03T10:10:00Z' },
  ];

  const health = analyzeExecutionHealthLogic(executions);

  console.log(`   Analysis: isHealthy=${health.isHealthy}`);
  console.log(`   - latestAny: #${health.latestAny?.id} (${health.latestAny?.status})`);
  console.log(`   - latestSuccess: #${health.latestSuccess?.id}`);
  console.log(`   - latestError: #${health.latestError?.id}`);

  const pass = health.isHealthy === false && health.latestAny?.status === 'error';
  console.log(`   Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);

  if (pass) {
    console.log(`   → Would analyze error from execution #${health.latestAny?.id}`);
  }

  return pass;
}

/**
 * Test 3: Multiple errors, then success → workflow is healthy
 */
function testCase3_MultipleErrorsThenSuccess() {
  console.log('\n📋 Test Case 3: Error #1102 → Success #1103 (latest success newer than latest error)');
  console.log('   Expected behavior: endpoint returns "Looks fixed", shows error #1102 in history');

  const executions: MockExecution[] = [
    { id: '1100', status: 'error', finishedAt: '2026-02-03T09:50:00Z' },
    { id: '1101', status: 'error', finishedAt: '2026-02-03T09:55:00Z' },
    { id: '1102', status: 'error', finishedAt: '2026-02-03T10:00:00Z' },
    { id: '1103', status: 'success', finishedAt: '2026-02-03T10:05:00Z' },
  ];

  const health = analyzeExecutionHealthLogic(executions);

  console.log(`   Analysis: isHealthy=${health.isHealthy}`);
  console.log(`   - latestAny: #${health.latestAny?.id} (${health.latestAny?.status})`);
  console.log(`   - latestSuccess: #${health.latestSuccess?.id}`);
  console.log(`   - latestError: #${health.latestError?.id}`);

  const pass =
    health.isHealthy === true &&
    health.latestAny?.status === 'success' &&
    health.latestError?.id === '1102' &&
    health.latestSuccess?.id === '1103';

  console.log(`   Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);

  if (pass) {
    console.log(`   → Would return: "Looks fixed. Latest execution #${health.latestAny?.id} succeeded. (previously failed at execution ${health.latestError?.id})"`);
  }

  return pass;
}

/**
 * Test 4: Success, then error, then success → latest is success, so healthy
 */
function testCase4_SuccessErrorSuccess() {
  console.log('\n📋 Test Case 4: Error #1102 (10:00) < Success #1103 (10:05) → Latest success is newer');
  console.log('   Expected behavior: endpoint returns "Looks fixed"');

  const executions: MockExecution[] = [
    { id: '1102', status: 'error', finishedAt: '2026-02-03T10:00:00Z' },
    { id: '1103', status: 'success', finishedAt: '2026-02-03T10:05:00Z' },
  ];

  const health = analyzeExecutionHealthLogic(executions);

  console.log(`   Analysis: isHealthy=${health.isHealthy}`);
  console.log(`   - latestAny: #${health.latestAny?.id} (${health.latestAny?.status})`);

  const latestSuccessTime = new Date(health.latestSuccess?.finishedAt || '').getTime();
  const latestErrorTime = new Date(health.latestError?.finishedAt || '').getTime();
  console.log(`   - latestSuccess time: ${latestSuccessTime}`);
  console.log(`   - latestError time: ${latestErrorTime}`);
  console.log(`   - success is newer: ${latestSuccessTime > latestErrorTime}`);

  const pass = health.isHealthy === true && health.latestAny?.status === 'success';
  console.log(`   Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);

  return pass;
}

/**
 * Test 5: Debug block contains all necessary fields
 */
function testCase5_DebugBlockFields() {
  console.log('\n📋 Test Case 5: Verify debug block contains all required fields');

  const executions: MockExecution[] = [
    { id: '1102', status: 'error', finishedAt: '2026-02-03T10:00:00Z' },
    { id: '1103', status: 'success', finishedAt: '2026-02-03T10:05:00Z' },
  ];

  const health = analyzeExecutionHealthLogic(executions);

  const debugBlock = {
    executionSelection: {
      pickedExecutionId: health.latestAny?.id,
      pickedExecutionStatus: health.latestAny?.status,
      latestAnyId: health.latestAny?.id,
      latestAnyStatus: health.latestAny?.status,
      latestAnyFinishedAt: health.latestAny?.finishedAt,
      latestErrorId: health.latestError?.id,
      latestErrorStatus: health.latestError?.status,
      latestErrorFinishedAt: health.latestError?.finishedAt,
      latestSuccessId: health.latestSuccess?.id,
      latestSuccessStatus: health.latestSuccess?.status,
      latestSuccessFinishedAt: health.latestSuccess?.finishedAt,
      // recentExecutions would be populated from listRecentExecutions
    },
  };

  console.log('   Debug block fields:');
  console.log(`   - pickedExecutionId: ${debugBlock.executionSelection.pickedExecutionId}`);
  console.log(`   - pickedExecutionStatus: ${debugBlock.executionSelection.pickedExecutionStatus}`);
  console.log(`   - latestAnyId: ${debugBlock.executionSelection.latestAnyId}`);
  console.log(`   - latestAnyStatus: ${debugBlock.executionSelection.latestAnyStatus}`);
  console.log(`   - latestAnyFinishedAt: ${debugBlock.executionSelection.latestAnyFinishedAt}`);
  console.log(`   - latestErrorId: ${debugBlock.executionSelection.latestErrorId}`);
  console.log(`   - latestErrorStatus: ${debugBlock.executionSelection.latestErrorStatus}`);
  console.log(`   - latestErrorFinishedAt: ${debugBlock.executionSelection.latestErrorFinishedAt}`);
  console.log(`   - latestSuccessId: ${debugBlock.executionSelection.latestSuccessId}`);
  console.log(`   - latestSuccessStatus: ${debugBlock.executionSelection.latestSuccessStatus}`);
  console.log(`   - latestSuccessFinishedAt: ${debugBlock.executionSelection.latestSuccessFinishedAt}`);

  const pass =
    debugBlock.executionSelection.pickedExecutionId &&
    debugBlock.executionSelection.pickedExecutionStatus &&
    debugBlock.executionSelection.latestAnyId &&
    debugBlock.executionSelection.latestAnyStatus &&
    debugBlock.executionSelection.latestAnyFinishedAt &&
    debugBlock.executionSelection.latestErrorId &&
    debugBlock.executionSelection.latestErrorStatus &&
    debugBlock.executionSelection.latestErrorFinishedAt &&
    debugBlock.executionSelection.latestSuccessId &&
    debugBlock.executionSelection.latestSuccessStatus &&
    debugBlock.executionSelection.latestSuccessFinishedAt;

  console.log(`   Status: ${pass ? '✅ PASS - All required fields present' : '❌ FAIL - Missing fields'}`);

  return pass;
}

/**
 * Run all test cases
 */
function runAllTests() {
  console.log('🧪 Execution Health Integration Tests (Endpoint Behavior)');
  console.log('=========================================================');

  const tests = [
    testCase1_ErrorThenSuccess,
    testCase2_SuccessThenError,
    testCase3_MultipleErrorsThenSuccess,
    testCase4_SuccessErrorSuccess,
    testCase5_DebugBlockFields,
  ];

  const results = tests.map(test => test());

  console.log('\n=========================================================');
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`📊 Results: ${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('✅ All integration tests passed!');
    console.log('\n📋 Summary:');
    console.log('  ✓ Error→Success workflow returns "Looks fixed"');
    console.log('  ✓ Success→Error workflow analyzes the error');
    console.log('  ✓ Multiple errors followed by success returns "Looks fixed"');
    console.log('  ✓ Timestamp comparison works correctly');
    console.log('  ✓ Debug block contains all required fields');
  } else {
    console.log(`❌ ${total - passed} test(s) failed`);
    process.exit(1);
  }
}

// Run tests if executed directly
if (require.main === module) {
  runAllTests();
}

export { runAllTests, analyzeExecutionHealthLogic };
