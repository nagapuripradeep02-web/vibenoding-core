/**
 * Phase 2B Step 2: ApplyStepContract Types
 * Defines structured request/response for /api/v3/assist/apply-step
 * 
 * Safety:
 * - Never writes to prod workflow
 * - Only whitelisted patch operations allowed
 * - Includes explicit prod_workflow_id_DENIED in debug
 */

/**
 * Whitelisted patch operations
 */
export type PatchOp =
    | 'update_node_params'
    | 'add_node'
    | 'add_edge'
    | 'set_credential_ref';

/**
 * All valid patch operation types
 */
export const VALID_PATCH_OPS: PatchOp[] = [
    'update_node_params',
    'add_node',
    'add_edge',
    'set_credential_ref',
];

/**
 * Individual node patch operation
 */
export interface NodePatch {
    op: PatchOp;
    nodeName?: string;           // Target node for update_node_params, set_credential_ref
    nodeType?: string;           // For add_node
    parameters?: Record<string, unknown>;  // For update_node_params, add_node
    credentialRef?: {            // For set_credential_ref
        name: string;
        type: string;
    };
    position?: {                 // For add_node
        x: number;
        y: number;
    };
    fromNode?: string;           // For add_edge
    toNode?: string;             // For add_edge
}

/**
 * Full patch with operations and rollback
 */
export interface ApplyStepPatch {
    stepId: string;
    operations: NodePatch[];
    rollback: NodePatch[];       // Inverse operations for undo
}

/**
 * Timing breakdown
 */
export interface ApplyStepTimings {
    total: number;
    lookup: number;
    llm: number;
    apply: number;
}

/**
 * Debug information with safety assertions
 */
export interface ApplyStepDebug {
    workflow_uuid: string;
    plan_id: string;
    step_id: string;
    test_workflow_id: string;
    prod_workflow_id_DENIED: string;  // Explicit safety - never writes to this
    dry_run: boolean;
    timings_ms: ApplyStepTimings;
    apply_error?: {                   // n8n update error details (sanitized)
        status: number;
        message: string;
        body?: string;                // Truncated response body
    };
    applied_nodes_preview?: {         // Last 3 nodes for debugging type issues
        name: string;
        type: string;
        typeVersion: number;
    }[];
    idempotency_key: string | null;
    idempotency_hit: boolean;
    existing_application_id?: string;
    cached_status?: string;
    audit_error?: string; // Captures write failures (upsert/idempotency)
    note?: string;        // Best-effort enrichment notes (e.g. "prod_resolve_failed")
}

/**
 * Full response
 */
export interface ApplyStepResponse {
    ok: boolean;
    patch: ApplyStepPatch | null;
    test_workflow_id: string | null;
    diff_summary: string | null;
    debug: ApplyStepDebug;
    error?: string;
}

/**
 * Request body
 */
export interface ApplyStepRequest {
    connectionId: string;
    workflowUuid?: string;       // Accepts both
    workflowId?: string;         // Accepts both
    planId: string;
    stepId: string;
    analyzed_source?: 'prod' | 'test';
    dry_run?: boolean;           // Default true for safety
    idempotency_key?: string;
}

/**
 * Budget constants for apply-step
 */
export const APPLY_STEP_BUDGETS = {
    max_tokens: 2000,
    temperature: 0,              // Always deterministic
    max_seconds: 30,
};

/**
 * Create empty timings
 */
export function createEmptyApplyStepTimings(): ApplyStepTimings {
    return {
        total: 0,
        lookup: 0,
        llm: 0,
        apply: 0,
    };
}

/**
 * Create empty debug with defaults
 */
export function createEmptyApplyStepDebug(
    workflowUuid: string,
    planId: string,
    stepId: string
): ApplyStepDebug {
    return {
        workflow_uuid: workflowUuid,
        plan_id: planId,
        step_id: stepId,
        test_workflow_id: '',
        prod_workflow_id_DENIED: '',
        dry_run: true,
        timings_ms: createEmptyApplyStepTimings(),
        idempotency_key: null,
        idempotency_hit: false,
    };
}

/**
 * Validate patch operations against whitelist
 */
export function validatePatchOperations(ops: NodePatch[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!Array.isArray(ops)) {
        return { valid: false, errors: ['operations must be an array'] };
    }

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];

        if (!VALID_PATCH_OPS.includes(op.op)) {
            errors.push(`Operation ${i}: invalid op "${op.op}", must be one of: ${VALID_PATCH_OPS.join(', ')}`);
            continue;
        }

        // Validate required fields per op type
        switch (op.op) {
            case 'update_node_params':
                if (!op.nodeName) errors.push(`Operation ${i}: update_node_params requires nodeName`);
                if (!op.parameters) errors.push(`Operation ${i}: update_node_params requires parameters`);
                break;
            case 'add_node':
                if (!op.nodeType) errors.push(`Operation ${i}: add_node requires nodeType`);
                break;
            case 'add_edge':
                if (!op.fromNode || !op.toNode) errors.push(`Operation ${i}: add_edge requires fromNode and toNode`);
                break;
            case 'set_credential_ref':
                if (!op.nodeName) errors.push(`Operation ${i}: set_credential_ref requires nodeName`);
                if (!op.credentialRef?.name || !op.credentialRef?.type) {
                    errors.push(`Operation ${i}: set_credential_ref requires credentialRef with name and type`);
                }
                break;
        }
    }

    return { valid: errors.length === 0, errors };
}
