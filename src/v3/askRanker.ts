/**
 * Phase 2A: Issue Ranking System
 * Provides deterministic, stable sorting for workflow issues
 * 
 * Priority order:
 * 1. Auth/credentials missing (blocks execution)
 * 2. Node misconfiguration (prevents run)
 * 3. Downstream errors from upstream missing data
 * 4. Connection issues
 * 5. Disabled nodes
 * 6. General issues
 */

import type { AskIssue, IssueCode, IssueSeverity, TopFixFirst } from './askContract';

/**
 * Priority mapping for issue categories (lower = higher priority)
 */
const ISSUE_CODE_PRIORITY: Record<IssueCode, number> = {
    MISSING_CREDENTIAL: 1,        // Auth issues first - blocks everything
    NODE_AUTH_ERROR: 1,
    NODE_CONFIG_ERROR: 2,         // Config that prevents run
    MISSING_REQUIRED_FIELD: 2,
    EXECUTION_ERROR: 3,           // Runtime failures
    UPSTREAM_DATA_MISSING: 4,     // Downstream cascade
    SCHEMA_VALIDATION_ERROR: 4,
    CONNECTION_BROKEN: 5,
    NODE_DISABLED: 6,
    UNKNOWN: 99,
};

/**
 * Severity priority (lower = higher priority)
 */
const SEVERITY_PRIORITY: Record<IssueSeverity, number> = {
    critical: 1,
    high: 2,
    medium: 3,
    low: 4,
};

/**
 * Deterministic comparison function for issues
 * Sort order: severity DESC → issue_code priority → node_locator ASC (alphabetical)
 */
function compareIssues(a: AskIssue, b: AskIssue): number {
    // 1. Compare by severity (critical first)
    const sevA = SEVERITY_PRIORITY[a.severity] ?? 99;
    const sevB = SEVERITY_PRIORITY[b.severity] ?? 99;
    if (sevA !== sevB) {
        return sevA - sevB;
    }

    // 2. Compare by issue_code priority
    const codeA = ISSUE_CODE_PRIORITY[a.issue_code] ?? 99;
    const codeB = ISSUE_CODE_PRIORITY[b.issue_code] ?? 99;
    if (codeA !== codeB) {
        return codeA - codeB;
    }

    // 3. Stable sort by node_locator (alphabetical)
    return a.node_locator.localeCompare(b.node_locator);
}

/**
 * Rank issues deterministically
 * Returns a new sorted array (does not mutate input)
 */
export function rankIssues(issues: AskIssue[]): AskIssue[] {
    // Create copy to avoid mutation
    const sorted = [...issues];
    sorted.sort(compareIssues);
    return sorted;
}

/**
 * Build TopFixFirst from ranked issues
 */
export function buildTopFixFirst(rankedIssues: AskIssue[]): TopFixFirst | null {
    if (rankedIssues.length === 0) {
        return null;
    }

    const top = rankedIssues[0];

    // Determine why this is the top priority
    let whyNow = '';
    switch (top.issue_code) {
        case 'MISSING_CREDENTIAL':
        case 'NODE_AUTH_ERROR':
            whyNow = 'Authentication is required before the workflow can execute';
            break;
        case 'NODE_CONFIG_ERROR':
        case 'MISSING_REQUIRED_FIELD':
            whyNow = 'Node configuration is incomplete and prevents execution';
            break;
        case 'EXECUTION_ERROR':
            whyNow = 'This node failed during the last execution';
            break;
        case 'UPSTREAM_DATA_MISSING':
            whyNow = 'Upstream node is not providing required data';
            break;
        case 'SCHEMA_VALIDATION_ERROR':
            whyNow = 'Node parameters do not match expected schema';
            break;
        case 'CONNECTION_BROKEN':
            whyNow = 'Node connection is broken and data flow is interrupted';
            break;
        case 'NODE_DISABLED':
            whyNow = 'Node is disabled and skipped during execution';
            break;
        default:
            whyNow = 'This issue should be addressed first based on priority';
    }

    return {
        issue_code: top.issue_code,
        severity: top.severity,
        node_locator: top.node_locator,
        why_now: whyNow,
        suggested_action: top.suggested_actions[0] || 'Review and fix this issue',
    };
}

/**
 * Map legacy issue string to structured AskIssue
 * Used during migration from old format
 */
export function convertLegacyIssue(
    legacyIssue: string,
    nodeLocator: string = 'unknown'
): AskIssue {
    const lowerIssue = legacyIssue.toLowerCase();

    // Detect issue type from text
    let issueCode: IssueCode = 'UNKNOWN';
    let severity: IssueSeverity = 'medium';

    if (lowerIssue.includes('credential') || lowerIssue.includes('authentication') || lowerIssue.includes('auth')) {
        issueCode = 'MISSING_CREDENTIAL';
        severity = 'critical';
    } else if (lowerIssue.includes('missing required') || lowerIssue.includes('required field')) {
        issueCode = 'MISSING_REQUIRED_FIELD';
        severity = 'high';
    } else if (lowerIssue.includes('config') || lowerIssue.includes('parameter')) {
        issueCode = 'NODE_CONFIG_ERROR';
        severity = 'high';
    } else if (lowerIssue.includes('execution') || lowerIssue.includes('failed') || lowerIssue.includes('error')) {
        issueCode = 'EXECUTION_ERROR';
        severity = 'high';
    } else if (lowerIssue.includes('disabled')) {
        issueCode = 'NODE_DISABLED';
        severity = 'low';
    } else if (lowerIssue.includes('connection') || lowerIssue.includes('broken')) {
        issueCode = 'CONNECTION_BROKEN';
        severity = 'medium';
    }

    // Extract node name from quotes if present
    const nodeMatch = legacyIssue.match(/"([^"]+)"/);
    const extractedNode = nodeMatch ? nodeMatch[1] : nodeLocator;

    return {
        issue_code: issueCode,
        severity,
        node_locator: extractedNode,
        summary: legacyIssue,
        evidence: [`workflow:issue_detected`],
        suggested_actions: ['Review and fix this issue'],
    };
}

/**
 * Get priority score for an issue (for external use)
 */
export function getIssuePriorityScore(issue: AskIssue): number {
    const sevScore = SEVERITY_PRIORITY[issue.severity] ?? 99;
    const codeScore = ISSUE_CODE_PRIORITY[issue.issue_code] ?? 99;
    return sevScore * 100 + codeScore;
}
