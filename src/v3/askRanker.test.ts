/**
 * Unit Tests for Ask Ranker
 * 
 * Tests:
 * - Determinism: same input → same output order
 * - Severity priority respected
 * - Issue code priority respected
 * - Stable sort by node_locator for equal priority
 * 
 * Run: npx ts-node src/v3/askRanker.test.ts
 */

import { rankIssues, buildTopFixFirst, convertLegacyIssue, getIssuePriorityScore } from './askRanker';
import type { AskIssue } from './askContract';

// Test helpers
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function pass(msg: string): void { console.log(`${GREEN}[PASS]${RESET} ${msg}`); }
function fail(msg: string): void { console.log(`${RED}[FAIL]${RESET} ${msg}`); }

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, msg: string): void {
    if (condition) {
        pass(msg);
        passCount++;
    } else {
        fail(msg);
        failCount++;
    }
}

// Test fixtures
function createIssue(
    issue_code: AskIssue['issue_code'],
    severity: AskIssue['severity'],
    node_locator: string
): AskIssue {
    return {
        issue_code,
        severity,
        node_locator,
        summary: `Test issue for ${node_locator}`,
        evidence: ['test:evidence'],
        suggested_actions: ['Fix this issue'],
    };
}

// Test 1: Determinism - same input produces same output
function testDeterminism(): void {
    console.log('\n--- Test: Determinism ---');

    const issues: AskIssue[] = [
        createIssue('NODE_DISABLED', 'low', 'NodeZ'),
        createIssue('MISSING_CREDENTIAL', 'critical', 'NodeA'),
        createIssue('EXECUTION_ERROR', 'high', 'NodeB'),
        createIssue('NODE_CONFIG_ERROR', 'high', 'NodeC'),
    ];

    const result1 = rankIssues(issues);
    const result2 = rankIssues(issues);
    const result3 = rankIssues(issues);

    const order1 = result1.map(i => i.node_locator).join(',');
    const order2 = result2.map(i => i.node_locator).join(',');
    const order3 = result3.map(i => i.node_locator).join(',');

    assert(order1 === order2, 'First and second call produce same order');
    assert(order2 === order3, 'Second and third call produce same order');
    // NodeA: MISSING_CREDENTIAL (critical, priority 1)
    // NodeC: NODE_CONFIG_ERROR (high, priority 2)
    // NodeB: EXECUTION_ERROR (high, priority 3)
    // NodeZ: NODE_DISABLED (low, priority 6)
    assert(order1 === 'NodeA,NodeC,NodeB,NodeZ', `Expected order: NodeA,NodeC,NodeB,NodeZ, got: ${order1}`);
}

// Test 2: Severity priority
function testSeverityPriority(): void {
    console.log('\n--- Test: Severity Priority ---');

    const issues: AskIssue[] = [
        createIssue('UNKNOWN', 'low', 'NodeA'),
        createIssue('UNKNOWN', 'critical', 'NodeB'),
        createIssue('UNKNOWN', 'medium', 'NodeC'),
        createIssue('UNKNOWN', 'high', 'NodeD'),
    ];

    const ranked = rankIssues(issues);
    const order = ranked.map(i => i.severity).join(',');

    assert(order === 'critical,high,medium,low', `Severity order: ${order}`);
    assert(ranked[0].node_locator === 'NodeB', 'Critical issue first');
}

// Test 3: Issue code priority (within same severity)
function testIssueCodePriority(): void {
    console.log('\n--- Test: Issue Code Priority ---');

    const issues: AskIssue[] = [
        createIssue('NODE_DISABLED', 'high', 'NodeA'),
        createIssue('MISSING_CREDENTIAL', 'high', 'NodeB'),
        createIssue('EXECUTION_ERROR', 'high', 'NodeC'),
        createIssue('NODE_CONFIG_ERROR', 'high', 'NodeD'),
    ];

    const ranked = rankIssues(issues);
    const order = ranked.map(i => i.issue_code).join(',');

    // Expected: MISSING_CREDENTIAL (1), NODE_CONFIG_ERROR (2), EXECUTION_ERROR (3), NODE_DISABLED (6)
    assert(ranked[0].issue_code === 'MISSING_CREDENTIAL', 'Credential issues first');
    assert(ranked[1].issue_code === 'NODE_CONFIG_ERROR', 'Config errors second');
    assert(ranked[2].issue_code === 'EXECUTION_ERROR', 'Execution errors third');
    assert(ranked[3].issue_code === 'NODE_DISABLED', 'Disabled nodes last');
}

// Test 4: Stable sort by node_locator
function testStableSortByNodeLocator(): void {
    console.log('\n--- Test: Stable Sort by Node Locator ---');

    const issues: AskIssue[] = [
        createIssue('MISSING_CREDENTIAL', 'critical', 'Zebra'),
        createIssue('MISSING_CREDENTIAL', 'critical', 'Apple'),
        createIssue('MISSING_CREDENTIAL', 'critical', 'Mango'),
    ];

    const ranked = rankIssues(issues);
    const order = ranked.map(i => i.node_locator).join(',');

    assert(order === 'Apple,Mango,Zebra', `Alphabetical order when equal priority: ${order}`);
}

// Test 5: buildTopFixFirst
function testBuildTopFixFirst(): void {
    console.log('\n--- Test: buildTopFixFirst ---');

    const issues: AskIssue[] = [
        createIssue('EXECUTION_ERROR', 'high', 'NodeA'),
        createIssue('MISSING_CREDENTIAL', 'critical', 'NodeB'),
    ];

    const ranked = rankIssues(issues);
    const topFix = buildTopFixFirst(ranked);

    assert(topFix !== null, 'TopFixFirst is not null');
    assert(topFix!.issue_code === 'MISSING_CREDENTIAL', 'TopFix is credential issue');
    assert(topFix!.node_locator === 'NodeB', 'TopFix points to NodeB');
    assert(topFix!.why_now.includes('Authentication'), 'Why_now explains auth requirement');

    // Test empty case
    const emptyTop = buildTopFixFirst([]);
    assert(emptyTop === null, 'Empty issues returns null TopFixFirst');
}

// Test 6: convertLegacyIssue
function testConvertLegacyIssue(): void {
    console.log('\n--- Test: convertLegacyIssue ---');

    const credIssue = convertLegacyIssue('Missing credential for "HTTP Request" node');
    assert(credIssue.issue_code === 'MISSING_CREDENTIAL', 'Detected credential issue');
    assert(credIssue.severity === 'critical', 'Credential is critical');
    assert(credIssue.node_locator === 'HTTP Request', 'Extracted node name from quotes');

    const configIssue = convertLegacyIssue('Parameter error in config');
    assert(configIssue.issue_code === 'NODE_CONFIG_ERROR', 'Detected config issue');

    const disabledIssue = convertLegacyIssue('Node is disabled');
    assert(disabledIssue.issue_code === 'NODE_DISABLED', 'Detected disabled issue');
    assert(disabledIssue.severity === 'low', 'Disabled is low severity');
}

// Test 7: getIssuePriorityScore
function testGetPriorityScore(): void {
    console.log('\n--- Test: getIssuePriorityScore ---');

    const criticalCred = createIssue('MISSING_CREDENTIAL', 'critical', 'NodeA');
    const highConfig = createIssue('NODE_CONFIG_ERROR', 'high', 'NodeB');
    const lowDisabled = createIssue('NODE_DISABLED', 'low', 'NodeC');

    const score1 = getIssuePriorityScore(criticalCred);
    const score2 = getIssuePriorityScore(highConfig);
    const score3 = getIssuePriorityScore(lowDisabled);

    assert(score1 < score2, 'Critical credential has lower (better) score than high config');
    assert(score2 < score3, 'High config has lower score than low disabled');
}

// Test 8: Input not mutated
function testInputNotMutated(): void {
    console.log('\n--- Test: Input Not Mutated ---');

    const original: AskIssue[] = [
        createIssue('NODE_DISABLED', 'low', 'NodeZ'),
        createIssue('MISSING_CREDENTIAL', 'critical', 'NodeA'),
    ];

    const originalOrder = original.map(i => i.node_locator).join(',');
    rankIssues(original);
    const afterOrder = original.map(i => i.node_locator).join(',');

    assert(originalOrder === afterOrder, 'Original array not mutated');
}

// Main runner
function runAllTests(): void {
    console.log('\n========================================');
    console.log('  Ask Ranker Unit Tests');
    console.log('========================================');

    testDeterminism();
    testSeverityPriority();
    testIssueCodePriority();
    testStableSortByNodeLocator();
    testBuildTopFixFirst();
    testConvertLegacyIssue();
    testGetPriorityScore();
    testInputNotMutated();

    console.log('\n========================================');
    console.log(`  Results: ${passCount} passed, ${failCount} failed`);
    console.log('========================================\n');

    if (failCount > 0) {
        process.exit(1);
    }
}

// Run tests if executed directly
if (require.main === module) {
    runAllTests();
}

export { runAllTests };
