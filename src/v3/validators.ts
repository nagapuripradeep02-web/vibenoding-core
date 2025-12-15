/**
 * V3.0 Node Validators
 * Detect placeholders, missing required fields, and credential status
 */

import type { N8nNode, ValidationResult } from './types';

// Placeholder patterns to detect
const PLACEHOLDER_PATTERNS = [
  /YOUR_/i,
  /CHANGE_ME/i,
  /TODO/i,
  /REPLACE_/i,
  /EXAMPLE/i,
  /<[^>]+>/,  // <something>
  /example\.com/i,
  /localhost/i,
  /127\.0\.0\.1/,
  /test@/i,
  /dummy/i,
  /placeholder/i,
  /xxx+/i,
  /your[-_]?api[-_]?key/i,
  /your[-_]?secret/i,
  /your[-_]?token/i,
  /api[-_]?key[-_]?here/i,
  /insert[-_]?here/i,
];

/**
 * Recursively search an object for placeholder patterns
 */
function findPlaceholdersInValue(value: unknown, path: string = ''): string[] {
  const found: string[] = [];
  
  if (typeof value === 'string') {
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(value)) {
        found.push(`${path}: "${value.substring(0, 50)}${value.length > 50 ? '...' : ''}"`);
        break; // Only report once per field
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...findPlaceholdersInValue(item, `${path}[${index}]`));
    });
  } else if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      found.push(...findPlaceholdersInValue(val, path ? `${path}.${key}` : key));
    }
  }
  
  return found;
}

/**
 * Detect placeholder values in a node's parameters
 */
export function detectPlaceholders(node: N8nNode): ValidationResult {
  const placeholders = findPlaceholdersInValue(node.parameters || {}, 'parameters');
  
  return {
    isValid: placeholders.length === 0,
    missing: placeholders,
  };
}

/**
 * Check if node has credentials attached
 */
export function credentialsAttached(node: N8nNode): ValidationResult {
  const credentials = node.credentials;
  const missing: string[] = [];
  
  // Check if credentials object exists and has entries
  if (!credentials || Object.keys(credentials).length === 0) {
    // Only flag as missing if this node type typically needs credentials
    if (nodeTypicallyNeedsCredentials(node.type)) {
      missing.push(`Node "${node.name}" (${node.type}) may need credentials`);
    }
  }
  
  return {
    isValid: missing.length === 0,
    missing,
  };
}

/**
 * Check if a node type typically requires credentials
 */
function nodeTypicallyNeedsCredentials(nodeType: string): boolean {
  const typeLower = nodeType.toLowerCase();
  
  const credentialNodePatterns = [
    'postgres',
    'mysql',
    'mongodb',
    'redis',
    'supabase',
    'firebase',
    'httprequest',
    'http request',
    'webhook',
    'imap',
    'smtp',
    'email',
    'gmail',
    'outlook',
    'slack',
    'telegram',
    'twilio',
    'sendgrid',
    'mailchimp',
    'stripe',
    'paypal',
    'shopify',
    'salesforce',
    'hubspot',
    'airtable',
    'notion',
    'google',
    'dropbox',
    'aws',
    's3',
    'azure',
    'github',
    'gitlab',
    'jira',
    'trello',
    'asana',
    'discord',
    'twitter',
    'facebook',
    'linkedin',
    'openai',
    'anthropic',
  ];
  
  return credentialNodePatterns.some(pattern => typeLower.includes(pattern));
}

/**
 * Check required fields based on node type
 */
export function requiredFieldsMissing(node: N8nNode): ValidationResult {
  const params = node.parameters || {};
  const missing: string[] = [];
  const typeLower = node.type.toLowerCase();
  
  // Webhook nodes
  if (typeLower.includes('webhook')) {
    if (!params.path && !params.httpMethod) {
      // path might be optional if using default
    }
  }
  
  // HTTP Request nodes
  if (typeLower.includes('httprequest') || typeLower.includes('http request')) {
    if (!params.url && !params.requestUrl) {
      missing.push('url is required for HTTP Request node');
    }
  }
  
  // Postgres nodes
  if (typeLower.includes('postgres')) {
    const operation = params.operation as string;
    if (operation === 'executeQuery') {
      if (!params.query) {
        missing.push('query is required for Postgres executeQuery operation');
      }
    } else if (['insert', 'update', 'upsert'].includes(operation)) {
      if (!params.table && !params.schema) {
        missing.push('table is required for Postgres insert/update operations');
      }
    }
  }
  
  // MySQL nodes
  if (typeLower.includes('mysql')) {
    const operation = params.operation as string;
    if (operation === 'executeQuery') {
      if (!params.query) {
        missing.push('query is required for MySQL executeQuery operation');
      }
    }
  }
  
  // Set node
  if (typeLower.includes('set')) {
    const values = params.values as unknown;
    const assignments = params.assignments as unknown;
    const mode = params.mode as string;
    
    // In newer n8n versions, Set node uses 'assignments' in manual mode
    if (mode === 'manual') {
      if (!assignments || (Array.isArray(assignments) && assignments.length === 0)) {
        // Warn but not fatal - empty Set node might be intentional
        missing.push('Set node has no field assignments (may be intentional)');
      }
    } else if (!values || (typeof values === 'object' && Object.keys(values).length === 0)) {
      // Legacy or expression mode
    }
  }
  
  // Code node
  if (typeLower.includes('code') || typeLower.includes('function')) {
    if (!params.jsCode && !params.code && !params.functionCode) {
      missing.push('code is required for Code/Function node');
    }
  }
  
  // IF node
  if (typeLower.includes('if')) {
    if (!params.conditions && !params.value1) {
      // IF node should have some condition
    }
  }
  
  return {
    isValid: missing.length === 0,
    missing,
  };
}

/**
 * Combined validation for a node
 */
export function validateNode(node: N8nNode): {
  credentials: ValidationResult;
  placeholders: ValidationResult;
  requiredFields: ValidationResult;
} {
  return {
    credentials: credentialsAttached(node),
    placeholders: detectPlaceholders(node),
    requiredFields: requiredFieldsMissing(node),
  };
}

/**
 * Get credential hints for a list of nodes (for Complete tab pre-analysis)
 */
export function getCredentialHints(nodes: N8nNode[]): Array<{
  id: string;
  name: string;
  type: string;
  hasCredentials: boolean;
}> {
  const credentialNodeTypes = /postgres|mysql|supabase|httprequest|imap|smtp|email|google|slack|twilio|mongodb|redis|aws|s3/i;
  
  return nodes
    .filter(node => credentialNodeTypes.test(node.type))
    .map(node => ({
      id: node.id,
      name: node.name,
      type: node.type,
      hasCredentials: !!node.credentials && Object.keys(node.credentials).length > 0,
    }));
}

