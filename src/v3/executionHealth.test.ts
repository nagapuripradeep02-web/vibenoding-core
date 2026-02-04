/**
 * Test suite for execution health analysis
 * 
 * Tests the logic that determines:
 * - Is the workflow currently healthy?
 * - Should we report "Looks fixed" or analyze errors?
 */

interface MockExecution {
  id: string;
  status: 'success' | 'error' | 'running' | 'waiting';
  finishedAt?: string;
  stoppedAt?: string;
}

/**
 * Simulates analyzeExecutionHealth logic for testing
 */
function analyzeExecutionHealthForTest(executions: MockExecution[]): {
  isHealthy: boolean;
  latestAny: { id: string; status: string; finishedAt: string } | null;
  latestError: { id: string; status: string; finishedAt: string } | null;
  latestSuccess: { id: string; status: string; finishedAt: string } | null;
} {
  const result = {
    isHealthy: false,
    latestAny: null as any,
    latestError: null as any,
    latestSuccess: null as any,
  };

  if (executions.length === 0) {
    return result;
  }

  // Sort chronologically: newest first
  const sorted = [...executions].sort((a, b) => {
    const aTime = new Date(a.stoppedAt || a.finishedAt || 0).getTime();
    const bTime = new Date(b.stoppedAt || b.finishedAt || 0).getTime();
    return bTime - aTime;
  });

  // Helper: get finishedAt timestamp from an execution
  const getFinishedAt = (exec: MockExecution): string => exec.stoppedAt || exec.finishedAt || '';

  // Find latest of each type
  if (sorted.length > 0) {
    result.latestAny = {
      id: sorted[0].id,
      status: sorted[0].status,
      finishedAt: getFinishedAt(sorted[0]),
    };
  }

  const errorExecution = sorted.find(exec => exec.status === 'error');
  if (errorExecution) {
    result.latestError = {
      id: errorExecution.id,
      status: errorExecution.status,
      finishedAt: getFinishedAt(errorExecution),
    };
  }

  const successExecution = sorted.find(exec => exec.status === 'success');
  if (successExecution) {
    result.latestSuccess = {
      id: successExecution.id,
      status: successExecution.status,
      finishedAt: getFinishedAt(successExecution),
    };
  }

  // Determine health: latest is success AND (no error OR latest success is newer than latest error)
  if (result.latestAny && result.latestAny.status === 'success') {
    const latestSuccessTime = new Date(result.latestAny.finishedAt).getTime();
    let isHealthy = true;

    if (result.latestError) {
      const latestErrorTime = new Date(result.latestError.finishedAt).getTime();
      if (latestErrorTime > latestSuccessTime) {
        // Error is newer than success, so not healthy
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
 * Test 1: Error then success → should return "Looks fixed"
 */
function test1_ErrorThenSuccess() {
  const executions: MockExecution[] = [
    { id: '1103', status: 'error', stoppedAt: '2026-02-03T10:00:00Z' },
    { id: '1104', status: 'success', stoppedAt: '2026-02-03T10:05:00Z' },
  ];

  const result = analyzeExecutionHealthForTest(executions);

  console.log('\n📋 Test 1: Error #1103 → Success #1104');
  console.log('  Expected: isHealthy=true, latestAny=success');
  console.log(`  Result: isHealthy=${result.isHealthy}, latestAny.status=${result.latestAny?.status}`);

  const pass = result.isHealthy && result.latestAny?.status === 'success';
  console.log(`  Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

/**
 * Test 2: Success then error → should analyze the error
 */
function test2_SuccessThenError() {
  const executions: MockExecution[] = [
    { id: '1104', status: 'success', stoppedAt: '2026-02-03T10:05:00Z' },
    { id: '1105', status: 'error', stoppedAt: '2026-02-03T10:10:00Z' },
  ];

  const result = analyzeExecutionHealthForTest(executions);

  console.log('\n📋 Test 2: Success #1104 → Error #1105');
  console.log('  Expected: isHealthy=false, latestAny=error, latestError=1105');
  console.log(`  Result: isHealthy=${result.isHealthy}, latestAny.status=${result.latestAny?.status}, latestError.id=${result.latestError?.id}`);

  const pass = !result.isHealthy && result.latestAny?.status === 'error' && result.latestError?.id === '1105';
  console.log(`  Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

/**
 * Test 3: Multiple errors, latest is success → healthy
 */
function test3_MultipleErrorsThenSuccess() {
  const executions: MockExecution[] = [
    { id: '1100', status: 'error', stoppedAt: '2026-02-03T09:50:00Z' },
    { id: '1101', status: 'error', stoppedAt: '2026-02-03T09:55:00Z' },
    { id: '1102', status: 'error', stoppedAt: '2026-02-03T10:00:00Z' },
    { id: '1103', status: 'success', stoppedAt: '2026-02-03T10:05:00Z' },
  ];

  const result = analyzeExecutionHealthForTest(executions);

  console.log('\n📋 Test 3: Multiple errors #1100-1102 → Success #1103');
  console.log('  Expected: isHealthy=true, latestError.id=1102, latestSuccess.id=1103');
  console.log(`  Result: isHealthy=${result.isHealthy}, latestError.id=${result.latestError?.id}, latestSuccess.id=${result.latestSuccess?.id}`);

  const pass = result.isHealthy && result.latestError?.id === '1102' && result.latestSuccess?.id === '1103';
  console.log(`  Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

/**
 * Test 4: Only success executions → healthy
 */
function test4_OnlySuccess() {
  const executions: MockExecution[] = [
    { id: '1100', status: 'success', stoppedAt: '2026-02-03T09:50:00Z' },
    { id: '1101', status: 'success', stoppedAt: '2026-02-03T09:55:00Z' },
    { id: '1102', status: 'success', stoppedAt: '2026-02-03T10:00:00Z' },
  ];

  const result = analyzeExecutionHealthForTest(executions);

  console.log('\n📋 Test 4: Only success executions');
  console.log('  Expected: isHealthy=true, latestError=null');
  console.log(`  Result: isHealthy=${result.isHealthy}, latestError=${result.latestError ? 'SET' : 'null'}`);

  const pass = result.isHealthy && !result.latestError;
  console.log(`  Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

/**
 * Test 5: Only error executions → not healthy
 */
function test5_OnlyError() {
  const executions: MockExecution[] = [
    { id: '1100', status: 'error', stoppedAt: '2026-02-03T09:50:00Z' },
    { id: '1101', status: 'error', stoppedAt: '2026-02-03T09:55:00Z' },
    { id: '1102', status: 'error', stoppedAt: '2026-02-03T10:00:00Z' },
  ];

  const result = analyzeExecutionHealthForTest(executions);

  console.log('\n📋 Test 5: Only error executions');
  console.log('  Expected: isHealthy=false, latestSuccess=null');
  console.log(`  Result: isHealthy=${result.isHealthy}, latestSuccess=${result.latestSuccess ? 'SET' : 'null'}`);

  const pass = !result.isHealthy && !result.latestSuccess;
  console.log(`  Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

/**
 * Test 6: Empty execution history → not healthy
 */
function test6_NoExecutions() {
  const executions: MockExecution[] = [];

  const result = analyzeExecutionHealthForTest(executions);

  console.log('\n📋 Test 6: No execution history');
  console.log('  Expected: isHealthy=false, all null');
  console.log(`  Result: isHealthy=${result.isHealthy}, latestAny=${result.latestAny ? 'SET' : 'null'}`);

  const pass = !result.isHealthy && !result.latestAny;
  console.log(`  Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

/**
 * Run all tests
 */
function runAllTests() {
  console.log('🧪 Execution Health Analysis Tests');
  console.log('====================================');

  const tests = [
    test1_ErrorThenSuccess,
    test2_SuccessThenError,
    test3_MultipleErrorsThenSuccess,
    test4_OnlySuccess,
    test5_OnlyError,
    test6_NoExecutions,
  ];

  const results = tests.map(test => test());

  console.log('\n====================================');
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`📊 Results: ${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('✅ All tests passed!');
  } else {
    console.log(`❌ ${total - passed} test(s) failed`);
    process.exit(1);
  }
}

// Run tests if executed directly
if (require.main === module) {
  runAllTests();
}

export { analyzeExecutionHealthForTest, runAllTests };
