/**
 * Phase 2B: PlanContract Types
 * Defines structured response format for /api/v3/assist/plan
 * 
 * Goals:
 * - Deterministic, reproducible plan generation
 * - Structured phases and steps with clear ordering
 * - Safety metadata for UI warnings
 * - Server-generated identity fields (security)
 */

/**
 * Individual step in a plan
 */
export interface PlanStep {
    id: string;                    // Unique within plan, e.g., "step_1", "fix_auth"
    title: string;                 // Human-readable step title
    nodeLocators: string[];        // Nodes this step affects
    checks: string[];              // Pre-conditions to verify before executing
    actions: string[];             // What to do (instructions)
    expectedOutcome: string;       // What success looks like
    rollback?: string;             // How to undo if needed
    rank: number;                  // Execution order (lower = first)
}

/**
 * Phase grouping related steps
 */
export interface PlanPhase {
    id: string;                    // e.g., "phase_auth", "phase_config"
    title: string;                 // Human-readable phase title
    steps: PlanStep[];             // Steps sorted by rank, then id
}

/**
 * Safety metadata for the plan
 */
export interface PlanSafety {
    reversible: boolean;           // Can all changes be undone?
    affectsProduction: boolean;    // Will this affect live workflows?
    requiresCredentials: boolean;  // Are credentials needed?
}

/**
 * Full plan structure
 */
export interface Plan {
    id: string;                    // ⚠️ Server-generated from DB row
    created_at: string;            // ⚠️ Server-generated from DB row (ISO timestamp)
    phases: PlanPhase[];
    safety: PlanSafety;
}

/**
 * Budget limits for Plan mode
 */
export interface PlanBudgets {
    max_tokens: number;
    max_tool_calls: number;
    max_seconds: number;
    temperature: number;
}

/**
 * Timing breakdown for debugging
 */
export interface PlanTimings {
    total: number;
    fetch_workflow: number;
    resolve_schemas: number;
    analyze: number;
    llm: number;
}

/**
 * Debug information for transparency
 */
export interface PlanDebug {
    workflow_uuid: string;
    analyzed_source: 'prod' | 'test';
    n8n_workflow_id?: string;
    budgets: PlanBudgets;
    timings_ms: PlanTimings;
}

/**
 * Full PlanContract response
 */
export interface PlanContractResponse {
    ok: boolean;
    plan: Plan | null;             // null when ok=false
    debug: PlanDebug;
    error?: string;                // Set when ok=false
}

/**
 * Default budget constants for Plan mode
 */
export const PLAN_BUDGETS: PlanBudgets = {
    max_tokens: 4000,              // Plans need more tokens than Ask
    max_tool_calls: 1,
    max_seconds: 60,
    temperature: 0,                // Always deterministic
};

/**
 * Create empty timings object
 */
export function createEmptyPlanTimings(): PlanTimings {
    return {
        total: 0,
        fetch_workflow: 0,
        resolve_schemas: 0,
        analyze: 0,
        llm: 0,
    };
}

/**
 * Create empty debug object with defaults
 */
export function createEmptyPlanDebug(workflowUuid: string): PlanDebug {
    return {
        workflow_uuid: workflowUuid,
        analyzed_source: 'prod',
        budgets: { ...PLAN_BUDGETS },
        timings_ms: createEmptyPlanTimings(),
    };
}

/**
 * Sort plan for deterministic output
 * Sorts phases by id, steps within each phase by rank then id
 */
export function sortPlanForDeterminism(plan: Plan): Plan {
    const sortedPhases = [...plan.phases].sort((a, b) => a.id.localeCompare(b.id));

    for (const phase of sortedPhases) {
        phase.steps = [...phase.steps].sort((a, b) => {
            if (a.rank !== b.rank) return a.rank - b.rank;
            return a.id.localeCompare(b.id);
        });
    }

    return {
        ...plan,
        phases: sortedPhases,
    };
}
