/**
 * Phase 2B: Plan Context Builder
 * Builds LLM prompts and parses plan responses
 * 
 * Goals:
 * - Strict JSON schema for LLM output
 * - Robust parsing with validation
 * - Deterministic sorting
 */

import type { ContextPack } from './assistContext';
import type { Plan, PlanPhase, PlanStep, PlanSafety } from './planContract';

/**
 * Build system prompt for Plan mode
 */
export function buildPlanSystemPrompt(context: ContextPack, userGoal?: string): string {
    const goalSection = userGoal
        ? `\n\nUser's stated goal: "${userGoal}"\nFocus the plan on achieving this goal.`
        : '';

    return `You are an expert n8n workflow debugger creating a structured fix plan.

TASK: Analyze the workflow context and generate a JSON fix plan.

${goalSection}

STRICT OUTPUT FORMAT (JSON only, no markdown):
{
  "phases": [
    {
      "id": "phase_1",
      "title": "Phase title",
      "steps": [
        {
          "id": "step_1",
          "title": "Step title",
          "nodeLocators": ["Node Name 1", "Node Name 2"],
          "checks": ["Pre-condition to verify"],
          "actions": ["Action to take"],
          "expectedOutcome": "What success looks like",
          "rollback": "How to undo (optional)",
          "rank": 1
        }
      ]
    }
  ],
  "safety": {
    "reversible": true,
    "affectsProduction": false,
    "requiresCredentials": false
  }
}

RULES:
1. Return ONLY valid JSON, no explanation before or after
2. Each step must have a unique id within the plan
3. Rank steps by execution order (1 = first)
4. NodeLocators must reference actual nodes from the workflow
5. Actions should be specific and actionable
6. If no issues found, return empty phases array

WORKFLOW CONTEXT:
- Name: ${context.workflow.name}
- Nodes: ${context.workflow.nodeCount}
- Active: ${context.workflow.active}

ISSUES DETECTED:
${context.evaluationIssues?.length ? context.evaluationIssues.join('\n') : 'None detected'}

MISSING CREDENTIALS:
${context.missingCredentials?.length ? context.missingCredentials.join(', ') : 'None'}

LATEST EXECUTION ERROR:
${context.latestExecutionError
            ? `Node: ${context.latestExecutionError.failedNode}, Error: ${context.latestExecutionError.errorMessage}`
            : 'None'}`;
}

/**
 * Build user context for Plan mode
 */
export function buildPlanUserContext(context: ContextPack): string {
    const nodeList = context.nodes?.map(n => `- ${n.name} (${n.type})`).join('\n') || 'No nodes';

    return `NODE LIST:
${nodeList}

Generate the fix plan JSON now.`;
}

/**
 * Validation result for plan parsing
 */
export interface PlanValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * Validate a plan structure
 */
export function validatePlan(plan: unknown): PlanValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!plan || typeof plan !== 'object') {
        return { valid: false, errors: ['Plan is not an object'], warnings: [] };
    }

    const p = plan as Record<string, unknown>;

    // Check phases
    if (!Array.isArray(p.phases)) {
        errors.push('phases must be an array');
    } else {
        const stepIds = new Set<string>();

        for (let i = 0; i < p.phases.length; i++) {
            const phase = p.phases[i] as Record<string, unknown>;

            if (!phase.id || typeof phase.id !== 'string') {
                errors.push(`Phase ${i}: missing or invalid id`);
            }
            if (!phase.title || typeof phase.title !== 'string') {
                errors.push(`Phase ${i}: missing or invalid title`);
            }

            if (!Array.isArray(phase.steps)) {
                errors.push(`Phase ${i}: steps must be an array`);
            } else {
                for (let j = 0; j < phase.steps.length; j++) {
                    const step = phase.steps[j] as Record<string, unknown>;

                    if (!step.id || typeof step.id !== 'string') {
                        errors.push(`Phase ${i} Step ${j}: missing or invalid id`);
                    } else {
                        if (stepIds.has(step.id)) {
                            errors.push(`Phase ${i} Step ${j}: duplicate step id "${step.id}"`);
                        }
                        stepIds.add(step.id);
                    }

                    if (!step.title || typeof step.title !== 'string') {
                        errors.push(`Phase ${i} Step ${j}: missing or invalid title`);
                    }
                    if (typeof step.rank !== 'number') {
                        errors.push(`Phase ${i} Step ${j}: missing or invalid rank`);
                    }
                    if (!Array.isArray(step.nodeLocators)) {
                        warnings.push(`Phase ${i} Step ${j}: nodeLocators should be array`);
                    }
                    if (!Array.isArray(step.checks)) {
                        warnings.push(`Phase ${i} Step ${j}: checks should be array`);
                    }
                    if (!Array.isArray(step.actions)) {
                        errors.push(`Phase ${i} Step ${j}: actions must be array`);
                    }
                    if (typeof step.expectedOutcome !== 'string') {
                        warnings.push(`Phase ${i} Step ${j}: expectedOutcome should be string`);
                    }
                }
            }
        }
    }

    // Check safety
    if (!p.safety || typeof p.safety !== 'object') {
        warnings.push('safety object missing, will use defaults');
    } else {
        const safety = p.safety as Record<string, unknown>;
        if (typeof safety.reversible !== 'boolean') {
            warnings.push('safety.reversible should be boolean');
        }
        if (typeof safety.affectsProduction !== 'boolean') {
            warnings.push('safety.affectsProduction should be boolean');
        }
        if (typeof safety.requiresCredentials !== 'boolean') {
            warnings.push('safety.requiresCredentials should be boolean');
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

/**
 * Parse LLM response into Plan structure
 * Returns null if parsing fails
 */
export function parsePlanResponse(json: string): Plan | null {
    try {
        // Try to extract JSON if wrapped in markdown
        let cleanJson = json.trim();
        if (cleanJson.startsWith('```')) {
            const match = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (match) cleanJson = match[1];
        }

        const parsed = JSON.parse(cleanJson);

        // Validate structure
        const validation = validatePlan(parsed);
        if (!validation.valid) {
            console.error('[parsePlanResponse] Validation errors:', validation.errors);
            return null;
        }

        if (validation.warnings.length > 0) {
            console.warn('[parsePlanResponse] Warnings:', validation.warnings);
        }

        // Build Plan object with defaults
        const phases: PlanPhase[] = (parsed.phases || []).map((phaseItem: unknown) => {
            const p = phaseItem as Record<string, unknown>;
            return {
                id: String(p.id),
                title: String(p.title),
                steps: ((p.steps as unknown[]) || []).map((stepItem: unknown) => {
                    const s = stepItem as Record<string, unknown>;
                    return {
                        id: String(s.id),
                        title: String(s.title),
                        nodeLocators: Array.isArray(s.nodeLocators) ? s.nodeLocators.map(String) : [],
                        checks: Array.isArray(s.checks) ? s.checks.map(String) : [],
                        actions: Array.isArray(s.actions) ? s.actions.map(String) : [],
                        expectedOutcome: String(s.expectedOutcome || ''),
                        rollback: s.rollback ? String(s.rollback) : undefined,
                        rank: typeof s.rank === 'number' ? s.rank : 0,
                    } as PlanStep;
                }),
            } as PlanPhase;
        });

        const safety: PlanSafety = {
            reversible: parsed.safety?.reversible ?? true,
            affectsProduction: parsed.safety?.affectsProduction ?? false,
            requiresCredentials: parsed.safety?.requiresCredentials ?? false,
        };

        // Note: id and created_at will be set by server after DB insert
        return {
            id: '', // Server will override
            created_at: '', // Server will override
            phases,
            safety,
        };
    } catch (e) {
        console.error('[parsePlanResponse] Parse error:', e);
        return null;
    }
}

/**
 * Extract stable ordering signature for determinism checks
 * Returns string of phase_ids:step_ids:ranks
 */
export function extractStableOrderSignature(plan: Plan): string {
    const parts: string[] = [];

    // Sort phases by id
    const sortedPhases = [...plan.phases].sort((a, b) => a.id.localeCompare(b.id));

    for (const phase of sortedPhases) {
        // Sort steps by rank, then id
        const sortedSteps = [...phase.steps].sort((a, b) => {
            if (a.rank !== b.rank) return a.rank - b.rank;
            return a.id.localeCompare(b.id);
        });

        const stepSigs = sortedSteps.map(s => `${s.id}:${s.rank}`);
        parts.push(`${phase.id}[${stepSigs.join(',')}]`);
    }

    return parts.join('|');
}
