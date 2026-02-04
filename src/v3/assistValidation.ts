/**
 * Assistant Response Validation - Anti-hallucination
 * Validates LLM responses against actual workflow context
 */

import type { ContextPack } from './assistContext';

export interface AssistResponse {
  answer: string;
  topFixFirst: string | null;
  issues: string[];
  citations: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate LLM response against context pack
 */
export function validateAssistResponse(
  response: AssistResponse,
  contextPack: ContextPack
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Extract all valid node names from context
  const validNodeNames = new Set(contextPack.nodes.map(n => n.name));

  // 1. Validate citations reference only existing nodes
  for (const citation of response.citations) {
    if (!validNodeNames.has(citation)) {
      errors.push(`Citation references non-existent node: "${citation}"`);
    }
  }

  // 2. Validate answer doesn't reference non-existent nodes
  // Extract quoted node names from answer
  const quotedNodesInAnswer = extractQuotedNodeNames(response.answer);
  for (const nodeName of quotedNodesInAnswer) {
    if (!validNodeNames.has(nodeName)) {
      errors.push(`Answer references non-existent node: "${nodeName}"`);
    }
  }

  // 3. Validate missing credentials claims
  if (contextPack.missingCredentials.length === 0) {
    // Check if answer or issues mention missing credentials
    const text = `${response.answer} ${response.issues.join(' ')}`.toLowerCase();
    if (
      text.includes('missing credential') ||
      text.includes('no credential') ||
      text.includes('add credential')
    ) {
      errors.push('Claims missing credentials when missingCredentials.length === 0');
    }
  }

  // 4. Validate citations are not empty when issues exist
  if (response.issues.length > 0 && response.citations.length === 0) {
    warnings.push('Issues exist but citations[] is empty - should reference affected nodes');
  }

  // 5. Validate topFixFirst mentions actual node if specified
  if (response.topFixFirst) {
    const topFixNodeNames = extractQuotedNodeNames(response.topFixFirst);
    for (const nodeName of topFixNodeNames) {
      if (!validNodeNames.has(nodeName)) {
        errors.push(`topFixFirst references non-existent node: "${nodeName}"`);
      }
    }
  }

  // 6. Validate issues reference actual nodes or problems
  for (const issue of response.issues) {
    const issueNodeNames = extractQuotedNodeNames(issue);
    for (const nodeName of issueNodeNames) {
      if (!validNodeNames.has(nodeName)) {
        errors.push(`Issue references non-existent node: "${nodeName}"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Extract node names in quotes from text
 */
function extractQuotedNodeNames(text: string): string[] {
  const matches = text.match(/"([^"]+)"/g);
  if (!matches) return [];
  
  return matches.map(m => m.slice(1, -1)); // Remove quotes
}

/**
 * Build deterministic fallback response from context pack facts
 */
export function buildDeterministicResponse(
  contextPack: ContextPack,
  userMessage: string
): AssistResponse {
  const issues: string[] = [];
  const citations: string[] = [];

  // Build issues from actual context
  if (contextPack.missingCredentials.length > 0) {
    issues.push(...contextPack.missingCredentials.map(cred => 
      `Missing credential: ${cred}`
    ));
    // Extract node names from missing credentials
    contextPack.missingCredentials.forEach(cred => {
      const match = cred.match(/"([^"]+)"/);
      if (match) citations.push(match[1]);
    });
  }

  if (contextPack.evaluationIssues.length > 0) {
    issues.push(...contextPack.evaluationIssues);
    // Extract node names from issues
    contextPack.evaluationIssues.forEach(issue => {
      const nodeNames = extractQuotedNodeNames(issue);
      citations.push(...nodeNames);
    });
  }

  if (contextPack.latestExecutionError) {
    issues.push(
      `Latest execution failed at node "${contextPack.latestExecutionError.failedNode}": ${contextPack.latestExecutionError.errorMessage}`
    );
    citations.push(contextPack.latestExecutionError.failedNode);
  }

  // Deduplicate citations
  const uniqueCitations = Array.from(new Set(citations));

  // Build factual answer
  let answer = `This workflow "${contextPack.workflow.name}" has ${contextPack.nodes.length} nodes`;
  
  if (issues.length > 0) {
    answer += ` and ${issues.length} detected issue(s). `;
  } else {
    answer += ' and appears to be configured correctly. ';
  }

  if (contextPack.latestExecutionError) {
    answer += `The most recent execution failed at node "${contextPack.latestExecutionError.failedNode}". `;
  }

  if (contextPack.missingCredentials.length > 0) {
    answer += `${contextPack.missingCredentials.length} node(s) are missing credentials. `;
  }

  // Determine top fix
  let topFixFirst: string | null = null;
  if (contextPack.latestExecutionError) {
    topFixFirst = `Fix the error in "${contextPack.latestExecutionError.failedNode}": ${contextPack.latestExecutionError.errorMessage}`;
  } else if (contextPack.missingCredentials.length > 0) {
    topFixFirst = `Add missing credentials: ${contextPack.missingCredentials[0]}`;
  } else if (contextPack.evaluationIssues.length > 0) {
    topFixFirst = contextPack.evaluationIssues[0];
  }

  return {
    answer: answer.trim(),
    topFixFirst,
    issues,
    citations: uniqueCitations,
  };
}

/**
 * Parse LLM JSON response safely
 */
export function parseAssistResponse(llmOutput: string): AssistResponse | null {
  try {
    // Try to extract JSON from markdown code blocks if present
    let jsonStr = llmOutput.trim();
    
    // Remove markdown code fences if present
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    const parsed = JSON.parse(jsonStr) as {
      answer?: string;
      topFixFirst?: string | null;
      issues?: string[];
      citations?: string[];
    };

    // Validate required fields
    if (typeof parsed.answer !== 'string') {
      return null;
    }

    return {
      answer: parsed.answer,
      topFixFirst: parsed.topFixFirst || null,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    };
  } catch (err) {
    console.error('[assistValidation] Failed to parse LLM response:', err);
    return null;
  }
}
